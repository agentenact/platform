import { MockLanguageModelV4 } from 'ai/test';
import { simulateReadableStream } from 'ai';

export const usage = (inp: number, out: number, cacheRead = 0, cacheWrite = 0) => ({
  inputTokens: { total: inp, noCache: inp - cacheRead - cacheWrite, cacheRead, cacheWrite },
  outputTokens: { total: out, text: out, reasoning: 0 },
});
const toolCalls = { unified: 'tool-calls' as const, raw: 'tool_use' };
const stop = { unified: 'stop' as const, raw: 'end_turn' };

/** Model that calls `tool` every step (n steps) then answers. Records call count. */
export function loopingModel(tool = 'ping', toolSteps = 100) {
  let i = 0;
  const gen = async () => {
    i++;
    if (i <= toolSteps)
      return {
        content: [{ type: 'tool-call' as const, toolCallId: `c${i}`, toolName: tool, input: '{}' }],
        finishReason: toolCalls,
        usage: usage(1000, 100, i > 1 ? 800 : 0, i === 1 ? 800 : 0),
        warnings: [],
      };
    return { content: [{ type: 'text' as const, text: 'done' }], finishReason: stop, usage: usage(1000, 50), warnings: [] };
  };
  const stream = async () => {
    const g = await gen();
    const parts: any[] = [{ type: 'stream-start', warnings: [] }];
    for (const c of g.content as any[]) {
      if (c.type === 'tool-call') parts.push(c);
      else parts.push({ type: 'text-start', id: 't' }, { type: 'text-delta', id: 't', delta: c.text }, { type: 'text-end', id: 't' });
    }
    parts.push({ type: 'finish', usage: g.usage, finishReason: g.finishReason });
    return { stream: simulateReadableStream({ chunks: parts }) as any };
  };
  const model = new MockLanguageModelV4({ doGenerate: gen as any, doStream: stream as any });
  return model;
}
