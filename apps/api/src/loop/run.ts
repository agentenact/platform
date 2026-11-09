/**
 * One budgeted model run (spec §6, gate 3 `spikes/ai-sdk/loop.ts`, plan D2), on streamText for every mode:
 * - wall clock, an external cancel and an internal cap share ONE abort signal;
 * - the tool-call cap is enforced in a wrapper around every tool's execute, which aborts the internal
 *   controller (a throwing tool alone becomes a tool-error and the loop continues);
 * - once the cap is reached the next step runs with `toolChoice: 'none'` (prepareStep): the model can still answer, and
 *   cannot run a tool (the execute guard aborts any call); that no-tools step is always the last (so a capped run costs at most one extra model call,
 *   and none if the model already answered). maxSteps still bounds the run;
 * - tokens stop at 85% of the budget (a stop can overshoot by one step);
 * - usage is metered from a language-model middleware on the provider's `finish` chunk, the single source of
 *   usage and of per-step charging (`onUsage`). ai 7.0.127 emits no `finish-step` (so no onStepEnd) when an abort
 *   lands during tool execution, but the provider's usage chunk has already been sent by then. Accepted residual:
 *   an abort mid-stream, before the provider sends its usage chunk, is not metered (nothing to read);
 * - a `finish` part with no token totals (the provider's flush always emits one, even for a clean stream with no
 *   usage chunk, or one cut by an `error` chunk) is a metering fault, never a free step: it fails closed like a
 *   throwing `onUsage` (stop=error), keeping whatever was already counted. Residual: a step that fails this way is
 *   charged nothing, since there is nothing to read;
 * - `finish_reason: length` (max_tokens hit) ends as stop=`length` (status done: delivery is unchanged), so a
 *   cut-off answer is distinguishable; each step also carries its finishReason;
 * - tools without `execute` are dropped on purpose: an unexecutable call would end the step with no result;
 * - a pre-aborted signal returns before any model call (streamText would still call the model once);
 * - onError is a no-op: the SDK's default logs the error object. Errors arrive as stream parts instead.
 * Never throws.
 */
import { callDetail } from './call-detail.js';
import { stepCountIs, streamText, wrapLanguageModel, type LanguageModel, type ModelMessage, type ToolSet } from 'ai';
import { callLine } from '../checks/readings.js';
import { costOf, type CallSink } from './ledger.js';
import { emptyUsage, type RunUsage, type StepSummary } from '../runs/index.js';

export interface Budget {
  maxTokens: number;
  /** Per model call (one step). Steps are metered from the provider's finish chunk, so an uncapped step is unmetered until it ends. */
  maxOutputTokens: number;
  maxToolCalls: number;
  maxSteps: number;
  wallClockMs: number;
}

export type StopReason = 'done' | 'tokens' | 'tool_calls' | 'steps' | 'timeout' | 'aborted' | 'error'
  /** The final model call hit max_tokens: the answer may be cut off. Delivered like `done`. */
  | 'length';

export interface ToolEvent {
  id: number;
  name: string;
  state: 'running' | 'done' | 'failed';
}

export interface LoopInput {
  model: LanguageModel;
  system: string;
  messages: ModelMessage[];
  tools: ToolSet;
  budget: Budget;
  signal?: AbortSignal;
  onDelta?: (text: string) => void;
  /** A tool call began or ended, as it happens. `id` counts the run's calls; never carries the call's input or output. */
  onTool?: (e: ToolEvent) => void;
  /**
   * The usage ledger: called once per model call with its tokens and provider-reported cost, from the same finish chunk as `onUsage`
   * (before it). Awaited. A throw is swallowed: the ledger is a record, never a gate (Ledger.record does not throw; this is the backstop).
   */
  record?: CallSink;
  /**
   * Called once per model call, from the provider's usage chunk, before the SDK sees the step end (so before
   * `onStep` and before stopWhen). Awaited. A throw is a fault: the run stops with `error` (fail closed).
   */
  onUsage?: (u: Pick<RunUsage, 'inputTokens' | 'outputTokens' | 'cacheReadTokens' | 'cacheWriteTokens'>) => void | Promise<void>;
  /** Called after each completed step (never for a step cut short by an abort during tools), with running totals. */
  onStep?: (usage: RunUsage, step: StepSummary) => void | Promise<void>;
}

export interface LoopResult {
  /** Text of every step, concatenated (chat deltas, mission results). */
  text: string;
  /** Text of the last step only: the answer, without narration written before earlier tool calls. */
  finalText: string;
  usage: RunUsage;
  stop: StopReason;
  steps: StepSummary[];
}

/** Calls kept per step in `runs.steps`; a longer step ends with a `more` marker. */
export const MAX_CALLS_PER_STEP = 8;
export const TOKEN_STOP_RATIO = 0.85;
/** Providers report inputTokens inclusive of cache reads and writes, so input + output is the total. */
export const totalTokens = (u: RunUsage) => u.inputTokens + u.outputTokens;

export async function runLoop(i: LoopInput): Promise<LoopResult> {
  const timeout = AbortSignal.timeout(i.budget.wallClockMs);
  const ctl = new AbortController();
  const signal = AbortSignal.any([timeout, ctl.signal, ...(i.signal ? [i.signal] : [])]);
  const usage = emptyUsage();
  const steps: StepSummary[] = [];
  if (signal.aborted) return { text: '', finalText: '', usage, stop: timeout.aborted ? 'timeout' : 'aborted', steps };

  const tokenStop = Math.floor(i.budget.maxTokens * TOKEN_STOP_RATIO);
  let capHit = false;
  let faulted = false;
  const tools: ToolSet = {};
  for (const [name, t] of Object.entries(i.tools)) {
    const execute = t.execute;
    if (!execute) continue;
    tools[name] = {
      ...t,
      execute: async (input: unknown, o: Parameters<typeof execute>[1]) => {
        // Guard for parallel calls in one step; only executed calls are counted.
        if (usage.toolCalls >= i.budget.maxToolCalls) {
          capHit = true;
          ctl.abort();
          throw new Error('tool_cap');
        }
        usage.toolCalls++;
        return execute(input as never, o);
      },
    } as ToolSet[string];
  }

  // A string model id would resolve through the gateway where no middleware can meter it.
  if (typeof i.model === 'string') return { text: '', finalText: '', usage, stop: 'error', steps };
  const modelId = i.model.modelId;
  const model = wrapLanguageModel({
    model: i.model,
    middleware: {
      specificationVersion: 'v4',
      wrapStream: async ({ doStream }) => {
        const r = await doStream();
        return {
          ...r,
          stream: r.stream.pipeThrough(
            new TransformStream({
              async transform(c, out) {
                if (c.type === 'finish' && c.usage.inputTokens.total === undefined && c.usage.outputTokens.total === undefined) {
                  // No usage reached us: fail closed rather than meter this step as free.
                  faulted = true;
                  ctl.abort();
                } else if (c.type === 'finish') {
                  const u = {
                    inputTokens: c.usage.inputTokens.total ?? 0,
                    outputTokens: c.usage.outputTokens.total ?? 0,
                    cacheReadTokens: c.usage.inputTokens.cacheRead ?? 0,
                    cacheWriteTokens: c.usage.inputTokens.cacheWrite ?? 0,
                  };
                  usage.inputTokens += u.inputTokens;
                  usage.outputTokens += u.outputTokens;
                  usage.cacheReadTokens += u.cacheReadTokens;
                  usage.cacheWriteTokens += u.cacheWriteTokens;
                  usage.steps++;
                  try {
                    await i.record?.({ model: modelId, ...u, costUsd: costOf(c.providerMetadata, c.usage.raw) });
                  } catch {
                    // a ledger fault never touches the run
                  }
                  try {
                    await i.onUsage?.(u);
                  } catch {
                    faulted = true;
                    ctl.abort();
                  }
                }
                out.enqueue(c);
              },
            }),
          ),
        };
      },
    },
  });

  let text = '';
  let stepText = '';
  let noToolsStep = false;
  let finish: string | undefined;
  let errored = false;
  let aborted = false;
  // Ids the model chose stay here: what leaves is a count, and only for a tool that exists.
  const calls = new Map<string, number>();
  const toolEnd = (callId: string, name: string, state: 'done' | 'failed') => {
    const id = calls.get(callId);
    if (id !== undefined) i.onTool?.({ id, name, state });
  };
  const r = streamText({
    model,
    system: i.system,
    messages: i.messages,
    tools,
    abortSignal: signal,
    maxRetries: 0,
    maxOutputTokens: i.budget.maxOutputTokens,
    // ai 7.0.127 does not check the signal between steps: an abort inside onStepEnd would still start one more model call.
    // At the cap the model gets one more step with no tools to answer; that step is always the last.
    prepareStep: () => {
      if (usage.toolCalls < i.budget.maxToolCalls) return undefined;
      noToolsStep = true;
      // toolChoice 'none', not activeTools: []: the tool history stays valid for providers (Anthropic refuses
      // tool_use/tool_result blocks with no tools defined); the execute guard still blocks any call.
      return { toolChoice: 'none' as const };
    },
    stopWhen: [stepCountIs(i.budget.maxSteps), () => totalTokens(usage) >= tokenStop, () => noToolsStep, () => signal.aborted],
    onError: () => {},
    onStepEnd: async (s) => {
      // A line only for a call that returned a result (a failed or capped call did not do what the line would say).
      const calls = s.toolCalls.slice(0, MAX_CALLS_PER_STEP).map((c) => {
        const res = s.toolResults.find((x) => x.toolCallId === c.toolCallId);
        if (!res) return { tool: c.toolName, line: null };
        const detail = callDetail(c.toolName, c.input, res.output);
        return { tool: c.toolName, line: callLine(c.toolName, c.input, res.output), ...(detail ? { detail } : {}) };
      });
      if (s.toolCalls.length > MAX_CALLS_PER_STEP) calls.push({ tool: 'more', line: null });
      const step: StepSummary = {
        n: steps.length + 1,
        tools: s.toolCalls.map((c) => c.toolName),
        ...(calls.length > 0 ? { calls } : {}),
        inputTokens: s.usage.inputTokens ?? 0,
        outputTokens: s.usage.outputTokens ?? 0,
        finishReason: s.finishReason,
      };
      steps.push(step);
      await i.onStep?.({ ...usage }, step);
    },
  });
  try {
    for await (const p of r.fullStream) {
      if (p.type === 'start-step') stepText = '';
      else if (p.type === 'text-delta') {
        text += p.text;
        stepText += p.text;
        i.onDelta?.(p.text);
      } else if (p.type === 'tool-call') {
        if (Object.hasOwn(tools, p.toolName)) {
          calls.set(p.toolCallId, calls.size + 1);
          i.onTool?.({ id: calls.size, name: p.toolName, state: 'running' });
        }
      } else if (p.type === 'tool-result') toolEnd(p.toolCallId, p.toolName, 'done');
      else if (p.type === 'tool-error') toolEnd(p.toolCallId, p.toolName, 'failed');
      else if (p.type === 'error') errored = true;
      else if (p.type === 'abort') aborted = true;
      else if (p.type === 'finish') finish = p.finishReason;
    }
  } catch {
    errored = true;
  }
  const stop: StopReason = faulted
    ? 'error'
    : capHit
    ? 'tool_calls'
    : timeout.aborted
      ? 'timeout'
      : aborted || signal.aborted
        ? 'aborted'
        : errored
          ? 'error'
          : totalTokens(usage) >= tokenStop
            ? 'tokens'
            : finish === 'tool-calls'
              ? usage.toolCalls >= i.budget.maxToolCalls
                ? 'tool_calls'
                : 'steps'
              : finish === 'length'
                ? 'length'
                : 'done';
  return { text, finalText: stepText, usage, stop, steps };
}
