// Corrected minimal `loop` sketch: budget + abort + metering. Names verified against ai@7.0.127.
import { generateText, stepCountIs, type LanguageModel, type ToolSet, type LanguageModelUsage } from 'ai';

export type Budget = { maxTokens: number; maxToolCalls: number; maxSteps: number; wallClockMs: number };
export type RunUsage = { inputTokens: number; outputTokens: number; cacheReadTokens: number; cacheWriteTokens: number; steps: number; toolCalls: number };
export type StopReason = 'done' | 'tokens' | 'tool_calls' | 'steps' | 'aborted' | 'timeout' | 'error';

export async function loop(opts: {
  model: LanguageModel; tools: ToolSet; system?: string; prompt: string; budget: Budget; signal?: AbortSignal;
  onUsage?: (u: RunUsage) => void | Promise<void>; // persist to `runs` (called after every step)
}) {
  const { budget } = opts;
  // 1. wall-clock + external cancel -> ONE signal
  const signal = AbortSignal.any([AbortSignal.timeout(budget.wallClockMs), ...(opts.signal ? [opts.signal] : [])]);
  const ctl = new AbortController(); // lets the tool wrapper kill the run
  const sig = AbortSignal.any([signal, ctl.signal]);

  // 2. metering: accumulate in onStepEnd (the only source that survives an abort)
  const u: RunUsage = { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, steps: 0, toolCalls: 0 };
  const add = (x: LanguageModelUsage) => {
    u.inputTokens += x.inputTokens ?? 0; u.outputTokens += x.outputTokens ?? 0;
    u.cacheReadTokens += x.inputTokenDetails.cacheReadTokens ?? 0; u.cacheWriteTokens += x.inputTokenDetails.cacheWriteTokens ?? 0;
    u.steps++;
  };
  const total = () => u.inputTokens + u.outputTokens; // inputTokens already includes cache read+write

  // 3. tool-call cap: wrapper counts at execute time (covers parallel calls inside one step)
  let capHit = false;
  const tools = Object.fromEntries(Object.entries(opts.tools).map(([name, t]) => [name, {
    ...t,
    execute: async (input: any, o: any) => {
      if (++u.toolCalls > budget.maxToolCalls) { capHit = true; ctl.abort(new Error('tool_cap')); throw new Error('tool_cap'); }
      return (t as any).execute(input, o);
    },
  }])) as ToolSet;

  if (sig.aborted) return { text: '', usage: u, stop: 'aborted' as StopReason }; // SDK does NOT check a pre-aborted signal itself
  try {
    const r = await generateText({
      model: opts.model, system: opts.system, prompt: opts.prompt, tools, abortSignal: sig, maxRetries: 0,
      stopWhen: [stepCountIs(budget.maxSteps), () => total() >= budget.maxTokens], // evaluated after each step
      onStepEnd: async (s) => { add(s.usage); await opts.onUsage?.({ ...u }); },
    });
    const stop: StopReason = total() >= budget.maxTokens ? 'tokens' : r.finishReason === 'tool-calls' ? 'steps' : 'done';
    return { text: r.text, usage: u, stop };
  } catch (e) {
    const stop: StopReason = capHit ? 'tool_calls' : signal.reason?.name === 'TimeoutError' ? 'timeout' : sig.aborted ? 'aborted' : 'error';
    if (stop === 'error') throw e;
    return { text: '', usage: u, stop }; // usage of completed steps is intact; the in-flight step is NOT counted
  }
}
