import { describe, expect, it } from 'bun:test';
import { modelIds } from '../src/loop/models.js';

describe('model ids', () => {
  it('defaults every role to the cheapest model, off Anthropic', () => {
    const ids = modelIds({});
    expect(ids).toEqual({ builder: 'deepseek/deepseek-v4.1-flash', builderAnon: 'deepseek/deepseek-v4.1-flash', run: 'deepseek/deepseek-v4.1-flash', cheap: 'deepseek/deepseek-v4.1-flash' });
    expect(Object.values(ids).some((id) => id.startsWith('anthropic/'))).toBe(false);
  });

  it('lets one env var move one role back, leaving the others on the default', () => {
    expect(modelIds({ MODEL_RUN: ' anthropic/claude-sonnet-5.5 ', MODEL_BUILDER: 'anthropic/claude-opus-5.5', MODEL_CHEAP: '' })).toEqual({
      builder: 'anthropic/claude-opus-5.5',
      builderAnon: 'deepseek/deepseek-v4.1-flash',
      run: 'anthropic/claude-sonnet-5.5',
      cheap: 'deepseek/deepseek-v4.1-flash',
    });
  });

  it('fails the boot on a value that is not an OpenRouter slug', () => {
    expect(() => modelIds({ MODEL_RUN: 'sonnet' })).toThrow('MODEL_RUN');
    expect(() => modelIds({ MODEL_BUILDER_ANON: 'a/b c' })).toThrow('MODEL_BUILDER_ANON');
  });
});

describe('direct Anthropic', () => {
  it('sends listed Anthropic picks to Anthropic only with a key, named by their OpenRouter slug', async () => {
    const { createModels } = await import('../src/loop/models.js');
    const both = createModels({ OPENROUTER_API_KEY: 'k', ANTHROPIC_API_KEY: 'a' });
    const s = both.chat('anthropic/claude-sonnet-5.5') as { modelId: string; provider: string };
    expect([s.modelId, s.provider]).toEqual(['anthropic/claude-sonnet-5.5', 'anthropic.messages']);
    expect((both.chat('deepseek/deepseek-v4.1-flash') as { provider: string }).provider).toBe('openrouter');
    expect((both.chat('anthropic/claude-3-haiku') as { provider: string }).provider).toBe('openrouter');
    expect((both.run as { provider: string }).provider).toBe('openrouter');
    const none = createModels({ OPENROUTER_API_KEY: 'k' });
    expect((none.chat('anthropic/claude-sonnet-5.5') as { provider: string }).provider).toBe('openrouter');
  });

  it('prices a call from tokens: cache reads at 0.1x, cache writes at 1.25x input', async () => {
    const { anthropicCost, ANTHROPIC_DIRECT } = await import('../src/loop/models.js');
    const p = ANTHROPIC_DIRECT['anthropic/claude-sonnet-5.5']!;
    expect(anthropicCost(p, { input: 1_000_000, output: 0, cacheRead: 0, cacheWrite: 0 })).toBe(2);
    expect(anthropicCost(p, { input: 1_000_000, output: 100_000, cacheRead: 500_000, cacheWrite: 100_000 })).toBe(0.8 + 0.1 + 0.25 + 1);
  });

  it('the ledger reads our own cost when OpenRouter sent none', async () => {
    const { costOf } = await import('../src/loop/ledger.js');
    expect(costOf({ agentenact: { costUsd: 0.0123 } })).toBe(0.0123);
    expect(costOf({ openrouter: { usage: { cost: 0.5 } }, agentenact: { costUsd: 0.1 } })).toBe(0.5);
    expect(costOf({ agentenact: { costUsd: -1 } })).toBeNull();
  });
});
