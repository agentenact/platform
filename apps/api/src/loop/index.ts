/**
 * The Runner: one metered run. Opens a `runs` row, applies the kill switch and the user's daily caps
 * (both end as `capped` with zero model calls), runs the loop with the mode's budget, writes usage after
 * every step and at the end, and charges the user's daily tokens. Usage is always recorded (spec §5.5).
 */
import type { LanguageModel, ModelMessage, ToolSet } from 'ai';
import type { Policy } from '../policy/index.js';
import { emptyUsage, type FinishedStatus, type RunMode, type RunUsage, type Runs, type StepSummary } from '../runs/index.js';
import { BUDGETS } from './budgets.js';
import type { Ledger } from './ledger.js';
import type { ModelDirectory } from './model-choices.js';
import { runLoop, type Budget, type StopReason, type ToolEvent } from './run.js';

export type OutcomeStop = StopReason | 'killed' | 'user_cap';

export interface RunRequest {
  agentId: string;
  userId: string;
  mode: RunMode;
  system: string;
  messages: ModelMessage[];
  /** A ToolSet, or a function of the run id (tools that record spend against the run, e.g. hire_agent). */
  tools: ToolSet | ((runId: string) => ToolSet);
  triggerId?: string;
  serviceId?: string;
  signal?: AbortSignal;
  onDelta?: (text: string) => void;
  onTool?: (e: ToolEvent) => void;
}

export interface RunOutcome {
  runId: string;
  status: FinishedStatus;
  stop: OutcomeStop;
  text: string;
  /** The last step's text: the answer, without narration before earlier tool calls. */
  finalText: string;
  usage: RunUsage;
  /** The finished steps (redacted: tool names and plain lines), as stored on the run. */
  steps?: StepSummary[];
}

export interface Runner {
  run(r: RunRequest): Promise<RunOutcome>;
}

/** A running mission's text reaches the page at most this often, and only its last LIVE_MAX characters. */
export const LIVE_FLUSH_MS = 1000;
export const LIVE_MAX = 2000;

/**
 * Collects a run's text deltas and writes the tail now and then: never more than one write in flight, never more often than
 * every `flushMs`, and text that arrives while a write is out (or just before a long tool call) still goes out a moment later.
 * Best effort: a failed write is dropped (the next one carries newer text). `stop` cancels a pending write. Never throws.
 */
export function liveWriter(write: (text: string) => Promise<void>, o: { flushMs?: number; max?: number } = {}) {
  const every = o.flushMs ?? LIVE_FLUSH_MS;
  const max = o.max ?? LIVE_MAX;
  let text = '';
  let last = 0;
  let busy = false;
  let dirty = false;
  let stopped = false;
  let timer: ReturnType<typeof setTimeout> | null = null;
  const run = () => {
    timer = null;
    if (!dirty || stopped) return;
    busy = true;
    dirty = false;
    last = Date.now();
    void write(text.length > max ? text.slice(text.length - max) : text)
      .catch(() => undefined)
      .finally(() => {
        busy = false;
        if (dirty) schedule();
      });
  };
  const schedule = () => {
    if (timer || busy || stopped) return;
    timer = setTimeout(run, Math.max(0, last + every - Date.now()));
  };
  return {
    delta(d: string) {
      text += d;
      if (text.length > max * 2) text = text.slice(text.length - max);
      dirty = true;
      schedule();
    },
    stop() {
      stopped = true;
      if (timer) clearTimeout(timer);
      timer = null;
    },
  };
}

export function statusFor(stop: StopReason): FinishedStatus {
  if (stop === 'done' || stop === 'length') return 'done';
  if (stop === 'aborted' || stop === 'error') return 'error';
  return 'budget';
}

export function createRunner(d: {
  runs: Pick<Runs, 'start' | 'progress' | 'finish'> & Partial<Pick<Runs, 'live'>>;
  policy: Pick<Policy, 'killed' | 'admitRun' | 'chargeTokens'>;
  model: LanguageModel;
  /** The id string of `model` (MODEL_IDS), recorded on every run. */
  modelId: string;
  budgets?: Partial<Record<RunMode, Budget>>;
  /** The usage ledger: one row per model call of every run (kind = the run's mode). */
  ledger?: Ledger;
  /**
   * Per-agent models: the owner's pick (app.agents.model, null = none), what may be picked and its weight, and a factory for
   * a slug. Without all three every run uses `model`. A pick that no longer resolves, or a failed lookup, runs on `model` too.
   */
  modelFor?: (agentId: string) => Promise<string | null>;
  models?: Pick<ModelDirectory, 'resolve'>;
  chat?: (id: string) => LanguageModel;
}): Runner {
  const made = new Map<string, LanguageModel>();
  /** The model of this agent's run, its id, and how many allowance tokens one of its tokens costs. */
  const pick = async (agentId: string): Promise<{ model: LanguageModel; id: string; weight: number }> => {
    const fallback = { model: d.model, id: d.modelId, weight: 1 };
    if (!d.modelFor || !d.chat || !d.models) return fallback;
    const chosen = await d.modelFor(agentId).catch(() => null);
    if (!chosen || chosen === d.modelId) return fallback;
    const c = await d.models.resolve(chosen).catch(() => null);
    if (!c) return fallback;
    let model = made.get(chosen);
    if (!model) made.set(chosen, (model = d.chat(chosen)));
    return { model, id: chosen, weight: c.weight };
  };
  return {
    async run(r) {
      const m = await pick(r.agentId);
      const runId = await d.runs.start({ agentId: r.agentId, mode: r.mode, ...(r.triggerId ? { triggerId: r.triggerId } : {}), ...(r.serviceId ? { serviceId: r.serviceId } : {}), model: m.id });
      // What the model consumed so far, kept here so a fault still records it.
      const seen = emptyUsage();
      const steps: StepSummary[] = [];
      // A mission has no browser listening: its text goes to the run row now and then, for the agent page to show.
      const runsLive = d.runs.live;
      const live = r.mode === 'mission' && runsLive ? liveWriter((t) => runsLive(runId, t)) : null;
      try {
        const capped = async (stop: 'killed' | 'user_cap'): Promise<RunOutcome> => {
          await d.runs.finish(runId, { status: 'capped', stopReason: stop, usage: emptyUsage(), steps: [] });
          return { runId, status: 'capped', stop, text: '', finalText: '', usage: emptyUsage() };
        };
        if (d.policy.killed) return await capped('killed');
        if (!(await d.policy.admitRun(r.userId))) return await capped('user_cap');

        // D12 (revised): every model call is charged from its provider usage chunk (so a step cut short by an abort
        // during tools is still charged); over the daily cap, or if charging fails, the run stops.
        const userCap = new AbortController();
        let overCap = false;
        let underCap = true;
        const result = await runLoop({
          model: m.model,
          system: r.system,
          messages: r.messages,
          tools: typeof r.tools === 'function' ? r.tools(runId) : r.tools,
          budget: d.budgets?.[r.mode] ?? BUDGETS[r.mode],
          signal: r.signal ? AbortSignal.any([r.signal, userCap.signal]) : userCap.signal,
          ...(r.onDelta ? { onDelta: r.onDelta } : live ? { onDelta: live.delta } : {}),
          ...(r.onTool ? { onTool: r.onTool } : {}),
          ...(d.ledger ? { record: d.ledger.sink({ kind: r.mode, agentId: r.agentId, userId: r.userId, runId }) } : {}),
          onUsage: async (u) => {
            seen.inputTokens += u.inputTokens;
            seen.outputTokens += u.outputTokens;
            seen.cacheReadTokens += u.cacheReadTokens;
            seen.cacheWriteTokens += u.cacheWriteTokens;
            seen.steps++;
            underCap = true; // a throw below leaves this true: runLoop ends the run as `error`, not as a cap
            // A pricier picked model uses the daily allowance faster (loop/model-choices.ts: who pays).
            underCap = await d.policy.chargeTokens(r.userId, Math.ceil((u.inputTokens + u.outputTokens) * m.weight));
          },
          // The cap decision lives here because only the step end knows finishReason.
          onStep: async (u, step) => {
            steps.push(step);
            // Only stop a run that would take another step; a final step that crosses the cap still ends `done`.
            if (!underCap && step.finishReason === 'tool-calls') {
              overCap = true; // overrides any other stop reason from this same step
              userCap.abort();
            }
            try {
              await d.runs.progress(runId, u, steps);
            } catch {
              // best effort: the final write below carries the same totals
            }
          },
        });
        live?.stop();
        const stop: OutcomeStop = overCap ? 'user_cap' : result.stop;
        const status: FinishedStatus = overCap ? 'capped' : statusFor(result.stop);
        await d.runs.finish(runId, { status, stopReason: stop, usage: result.usage, steps: result.steps });
        return { runId, status, stop, text: result.text, finalText: result.finalText, usage: result.usage, steps: result.steps };
      } catch {
        live?.stop();
        // A run row must never stay `running`: record the fault (best effort) and report it instead of throwing.
        try {
          await d.runs.finish(runId, { status: 'error', stopReason: 'error', usage: seen, steps });
        } catch {
          // the row is left to runs.failInterrupted at the next boot
        }
        return { runId, status: 'error', stop: 'error', text: '', finalText: '', usage: seen };
      }
    },
  };
}
