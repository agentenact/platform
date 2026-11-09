import { describe, expect, it } from 'bun:test';
import { tool } from 'ai';
import { z } from 'zod';
import { BUDGETS } from '../../src/loop/budgets.js';
import { createModels, MODEL_IDS } from '../../src/loop/models.js';
import { runLoop } from '../../src/loop/run.js';

// Opt-in, costs a few cents. The FIRST real call of P3: confirms the three model ids and the usage
// fields (spec gate 3 left this open). Kerem supplies the key for this process only, never on disk:
//   AGENTENACT_OPENROUTER=1 OPENROUTER_API_KEY="$(osascript -e 'text returned of (display dialog "OpenRouter API key" default answer "" with hidden answer)')" \
//     bun test tests/e2e/models.live.test.ts
const live = process.env.AGENTENACT_OPENROUTER === '1';
const tiny = { ...BUDGETS.chat, maxTokens: 20_000, maxSteps: 3, wallClockMs: 60_000 };

describe.skipIf(!live)('Claude models via OpenRouter, real API', () => {
  for (const which of ['run', 'cheap', 'builder'] as const) {
    it(`${MODEL_IDS[which]} answers and reports usage`, async () => {
      const models = createModels();
      const r = await runLoop({ model: models[which], system: 'Answer in one word.', messages: [{ role: 'user', content: 'Say OK.' }], tools: {}, budget: tiny });
      console.log(JSON.stringify({ model: MODEL_IDS[which], stop: r.stop, usage: r.usage, text: r.text.slice(0, 40) }));
      expect(r.stop).toBe('done');
      expect(r.text.length).toBeGreaterThan(0);
      expect(r.usage.inputTokens).toBeGreaterThan(0);
      expect(r.usage.outputTokens).toBeGreaterThan(0);
    }, 60_000);
  }

  it(`${MODEL_IDS.run} calls a tool and finishes`, async () => {
    const add = tool({ description: 'Add two integers.', inputSchema: z.object({ a: z.number().int(), b: z.number().int() }), execute: async ({ a, b }) => ({ sum: a + b }) });
    const r = await runLoop({ model: createModels().run, system: 'Use the add tool, then state the sum.', messages: [{ role: 'user', content: 'What is 40 + 2?' }], tools: { add }, budget: tiny });
    console.log(JSON.stringify({ stop: r.stop, usage: r.usage, steps: r.steps }));
    expect(r.stop).toBe('done');
    expect(r.usage.toolCalls).toBe(1);
    expect(r.text).toContain('42');
  }, 60_000);
});
