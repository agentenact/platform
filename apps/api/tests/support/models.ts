/** Mock language models for loop tests: ai@7 MockLanguageModelV4 + simulateReadableStream, as in spikes/ai-sdk. */
import { simulateReadableStream } from 'ai';
import { MockLanguageModelV4 } from 'ai/test';

export type Turn = { tool: string; input?: unknown; parallel?: number; narrate?: string } | { text: string; cut?: boolean };

export const usage = (inp: number, out: number, cacheRead = 0, cacheWrite = 0) => ({
  inputTokens: { total: inp, noCache: inp - cacheRead - cacheWrite, cacheRead, cacheWrite },
  outputTokens: { total: out, text: out, reasoning: 0 },
});

/** Plays `turns` in order, one per model call (the last repeats). A tool turn (`parallel` calls in one step, default 1) costs 1000 in / 100 out, a text turn 1000 in / 50 out. */
export function scriptedModel(turns: Turn[], o: { cost?: number; modelId?: string } = {}) {
  let i = 0;
  // The shape @openrouter/ai-sdk-provider puts on every finish chunk (index.js: openrouterMetadata, usage = OpenRouterUsageAccounting).
  const providerMetadata = o.cost === undefined ? {} : { providerMetadata: { openrouter: { usage: { promptTokens: 1000, completionTokens: 50, totalTokens: 1050, cost: o.cost } } } };
  const model = new MockLanguageModelV4({
    ...(o.modelId ? { modelId: o.modelId } : {}),
    doStream: async () => {
      const t = turns[Math.min(i, turns.length - 1)]!;
      i++;
      const chunks: unknown[] = [{ type: 'stream-start', warnings: [] }];
      if ('tool' in t) {
        if (t.narrate) chunks.push({ type: 'text-start', id: 'n' }, { type: 'text-delta', id: 'n', delta: t.narrate }, { type: 'text-end', id: 'n' });
        for (let k = 0; k < (t.parallel ?? 1); k++) chunks.push({ type: 'tool-call', toolCallId: `c${i}-${k}`, toolName: t.tool, input: JSON.stringify(t.input ?? {}) });
        chunks.push({ type: 'finish', usage: usage(1000, 100), finishReason: { unified: 'tool-calls', raw: 'tool_use' }, ...providerMetadata });
      } else {
        chunks.push({ type: 'text-start', id: 't' }, { type: 'text-delta', id: 't', delta: t.text }, { type: 'text-end', id: 't' });
        chunks.push({ type: 'finish', usage: usage(1000, 50), finishReason: t.cut ? { unified: 'length', raw: 'max_tokens' } : { unified: 'stop', raw: 'end_turn' }, ...providerMetadata });
      }
      return { stream: simulateReadableStream({ chunks }) } as never;
    },
  });
  return Object.assign(model, { calls: () => model.doStreamCalls.length });
}

/** Calls `tool` for `toolSteps` model calls, then answers 'done'. */
export const loopingModel = (tool = 'ping', toolSteps = 100, parallel = 1, o: { cost?: number; modelId?: string } = {}) => scriptedModel([...Array.from({ length: toolSteps }, () => ({ tool, parallel })), { text: 'done' }], o);

/** Every call fails like an overloaded API. */
export function failingModel() {
  const model = new MockLanguageModelV4({
    doStream: async () => {
      throw Object.assign(new Error('Overloaded'), { statusCode: 529 });
    },
  });
  return Object.assign(model, { calls: () => model.doStreamCalls.length });
}
