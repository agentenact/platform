import { describe, expect, it } from 'bun:test';
import type { CatalogModel } from '../src/loop/catalog.js';
import { createModelDirectory, MAX_WEIGHT, MODEL_CHOICES, weightOf } from '../src/loop/model-choices.js';

const DEF = 'deepseek/deepseek-v4.1-flash';
const catalogOf = (list: CatalogModel[]) => ({ list: async () => list, find: async (id: string) => list.find((m) => m.id === id) ?? null });
const CATALOG = catalogOf([
  { id: 'x-ai/grok-5-fast', label: 'xAI: Grok 5 Fast', inUsd: 0.2, outUsd: 0.5 },
  { id: 'openai/gpt-5.4-pro', label: 'OpenAI: GPT-5.4 Pro', inUsd: 30, outUsd: 180 },
  { id: 'anthropic/claude-haiku-5.5', label: 'Anthropic: Claude Haiku 5.5', inUsd: 0.1, outUsd: 0.5 },
]);

describe('model choices', () => {
  it('lists unique OpenRouter slugs with prices, the cheapest default first', () => {
    const ids = MODEL_CHOICES.map((c) => c.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const c of MODEL_CHOICES) expect(c.id).toMatch(/^[\w.-]+\/[\w.:-]+$/);
    expect(ids[0]).toBe(DEF);
  });

  it('weighs the default and anything cheaper at 1, a pricier model by its blended price', () => {
    expect(weightOf(DEF, DEF)).toBe(1);
    expect(weightOf('anthropic/claude-sonnet-5.5', DEF)).toBe(26.5);
    expect(weightOf('anthropic/claude-haiku-5.5', DEF)).toBe(1.4);
    expect(weightOf(DEF, 'anthropic/claude-sonnet-5.5')).toBe(1);
    expect(weightOf('not/listed', DEF)).toBe(1);
  });
});

describe('model directory', () => {
  it('resolves curated models, catalog models up to MAX_WEIGHT, and the default; nothing else', async () => {
    const dir = createModelDirectory({ defaultId: DEF, catalog: CATALOG });
    expect(await dir.resolve(DEF)).toMatchObject({ id: DEF, weight: 1, suggested: true });
    expect(await dir.resolve('anthropic/claude-sonnet-5.5')).toMatchObject({ weight: 26.5, suggested: true });
    expect(await dir.resolve('x-ai/grok-5-fast')).toMatchObject({ label: 'xAI: Grok 5 Fast', weight: 2, suggested: false });
    expect(await dir.resolve('openai/gpt-5.4-pro')).toBeNull();
    expect(await dir.resolve('gone/model')).toBeNull();
    // Without a catalog only the curated list resolves.
    expect(await createModelDirectory({ defaultId: DEF }).resolve('x-ai/grok-5-fast')).toBeNull();
  });

  it('lists the suggested models first, then the catalog without duplicates or heavy models', async () => {
    const all = await createModelDirectory({ defaultId: DEF, catalog: CATALOG }).all();
    expect(all.slice(0, MODEL_CHOICES.length).every((c) => c.suggested)).toBe(true);
    expect(all.map((c) => c.id).filter((id) => id === 'anthropic/claude-haiku-5.5')).toHaveLength(1);
    expect(all.at(-1)).toMatchObject({ id: 'x-ai/grok-5-fast', suggested: false });
    expect(all.some((c) => c.id === 'openai/gpt-5.4-pro')).toBe(false);
    expect(all.every((c) => c.weight <= MAX_WEIGHT)).toBe(true);
  });

  it('view: a stale or default pick reads as none; a catalog pick joins the list', async () => {
    const dir = createModelDirectory({ defaultId: DEF, catalog: CATALOG });
    expect(await dir.view('gone/model')).toMatchObject({ current: DEF, chosen: null, catalog: true });
    expect(await dir.view(DEF)).toMatchObject({ current: DEF, chosen: null });
    const v = await dir.view('x-ai/grok-5-fast');
    expect(v).toMatchObject({ current: 'x-ai/grok-5-fast', chosen: 'x-ai/grok-5-fast' });
    expect(v.choices.at(-1)).toMatchObject({ id: 'x-ai/grok-5-fast', suggested: false });
  });

  it('an unlisted default goes first by its catalog name, and weighs others against its price', async () => {
    const dir = createModelDirectory({ defaultId: 'x-ai/grok-5-fast', catalog: CATALOG });
    const v = await dir.view(null);
    expect(v.choices[0]).toMatchObject({ id: 'x-ai/grok-5-fast', label: 'xAI: Grok 5 Fast', weight: 1 });
    expect(v.choices.find((c) => c.id === DEF)!.weight).toBe(1);
  });
});
