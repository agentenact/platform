import { describe, expect, it } from 'bun:test';
import { createCatalog, parseCatalog } from '../src/loop/catalog.js';

// Shapes as OpenRouter /api/v1/models sends them (prices are USD per token, as strings).
const entry = (id: string, o: Record<string, unknown> = {}) => ({
  id,
  name: `Name ${id}`,
  pricing: { prompt: '0.0000002', completion: '0.0000005', request: '0', image: '0' },
  architecture: { input_modalities: ['text', 'image'], output_modalities: ['text'] },
  supported_parameters: ['tools', 'tool_choice', 'max_tokens'],
  ...o,
});
const BODY = {
  data: [
    entry('x-ai/grok-5-fast'),
    entry('meta/llama-free:free'),
    entry('google/gemini-3.5-flash:batch'),
    entry('openrouter/auto', { pricing: { prompt: '-1', completion: '-1' } }),
    entry('no/tools', { supported_parameters: ['max_tokens'] }),
    entry('image/only', { architecture: { input_modalities: ['text'], output_modalities: ['image'] } }),
    entry('zero/price', { pricing: { prompt: '0', completion: '0' } }),
    entry('bad price/x'),
    { id: 42 },
  ],
};

describe('openrouter catalog', () => {
  it('keeps text models with tools and a real price, per million tokens', () => {
    expect(parseCatalog(BODY)).toEqual([{ id: 'x-ai/grok-5-fast', label: 'Name x-ai/grok-5-fast', inUsd: 0.2, outUsd: 0.5 }]);
    expect(parseCatalog(null)).toEqual([]);
    expect(parseCatalog({ data: 'x' })).toEqual([]);
  });

  it('caches for the ttl, keeps the last good list on failure, and never throws', async () => {
    let t = 0;
    let calls = 0;
    let fail = false;
    const fetch = (async () => {
      calls++;
      if (fail) throw new Error('down');
      return new Response(JSON.stringify(BODY), { status: 200 });
    }) as unknown as typeof globalThis.fetch;
    const c = createCatalog({ fetch, now: () => t, ttlMs: 1000 });
    expect((await c.find('x-ai/grok-5-fast'))?.inUsd).toBe(0.2);
    await c.list();
    expect(calls).toBe(1);
    t = 2000;
    fail = true;
    expect(await c.list()).toHaveLength(1); // stale answer at once; the refresh fails in the background
    await new Promise((r) => setTimeout(r, 0));
    expect(await c.find('x-ai/grok-5-fast')).not.toBeNull();
    const down = createCatalog({ fetch: (async () => new Response('no', { status: 503 })) as unknown as typeof globalThis.fetch });
    expect(await down.list()).toEqual([]);
  });
});
