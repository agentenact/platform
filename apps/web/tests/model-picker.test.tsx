import { describe, expect, test } from 'bun:test';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { AgentHeader } from '../src/components/agent-header';
import { matchModels, weightNote } from '../src/components/model-picker';
import { copy } from '../src/copy';
import { asAgentModel, asModelChoices, asOverview } from '../src/lib/agent-types';
import { createAgentActions } from '../src/server/agent-actions';
import type { ApiResult } from '../src/server/api';
import { AGENT_ID, NOW, overview } from './support/agent';
import { textOf } from './support/screens';

const M = copy.agent.model;
const header = (o = overview()) => renderToStaticMarkup(createElement(AgentHeader, { agentId: AGENT_ID, o, now: NOW }));

describe('the agent model in the header', () => {
  test('shows the model it runs on; hidden when the api does not say, or the agent is stopped', () => {
    const h = header();
    expect(h).toContain('data-model-picker="deepseek/deepseek-v4.1-flash"');
    expect(textOf(h)).toContain('DeepSeek V4.1 Flash');
    expect(header(overview({ model: null }))).not.toContain('data-model-picker');
    expect(header(overview({ status: 'stopped' }))).not.toContain('data-model-picker');
  });

  test('a picked model shows its own name', () => {
    const o = overview();
    const h = header(overview({ model: { ...o.model!, current: 'anthropic/claude-haiku-5.5', chosen: 'anthropic/claude-haiku-5.5' } }));
    expect(textOf(h)).toContain('Claude Haiku 5.5');
  });

  test('says how much faster a stronger model uses the daily limit', () => {
    expect(weightNote(1)).toBe(M.same);
    expect(weightNote(26.5)).toBe('Uses the daily limit 26.5× faster');
    expect(weightNote(2)).toBe('Uses the daily limit 2× faster');
  });
});

describe('the model block from the api', () => {
  const good = overview().model!;
  test('reads a good block and drops an odd one', () => {
    expect(asAgentModel(good)).toEqual(good);
    expect(asAgentModel({ ...good, current: 'not a slug' })).toBeNull();
    expect(asAgentModel({ ...good, current: 'x/unlisted' })).toBeNull();
    expect(asAgentModel({ ...good, choices: [{ id: 'a/b', label: 'A', weight: 0.5 }] })).toBeNull();
    expect(asAgentModel(undefined)).toBeNull();
  });

  test('an overview without it still reads, with no picker', () => {
    const { model: _m, ...old } = overview();
    expect(asOverview(old)?.model).toBeNull();
  });
});

describe('setModel', () => {
  test('posts the slug or null and is ok only on 204', async () => {
    const calls: { path: string; body: unknown }[] = [];
    const api = async (path: string, o: { body?: unknown }): Promise<ApiResult> => (calls.push({ path, body: o.body }), { status: 204, json: null });
    const a = createAgentActions({ api: api as never, token: async () => 't' });
    expect(await a.setModel(AGENT_ID, 'anthropic/claude-haiku-5.5')).toEqual({ ok: true });
    expect(await a.setModel(AGENT_ID, null)).toEqual({ ok: true });
    expect(calls).toEqual([
      { path: `/api/agents/${AGENT_ID}/model`, body: { model: 'anthropic/claude-haiku-5.5' } },
      { path: `/api/agents/${AGENT_ID}/model`, body: { model: null } },
    ]);
    const bad = createAgentActions({ api: (async () => ({ status: 400, json: null })) as never, token: async () => 't' });
    expect(await bad.setModel(AGENT_ID, 'x/y')).toEqual({ ok: false, status: 400 });
    expect(await a.setModel('nope', null)).toEqual({ ok: false, status: 400 });
  });
});

describe('all models', () => {
  const all = [
    { id: 'deepseek/deepseek-v4.1-flash', label: 'DeepSeek V4.1 Flash', weight: 1, suggested: true },
    { id: 'x-ai/grok-5-fast', label: 'xAI: Grok 5 Fast', weight: 2, suggested: false },
    { id: 'qwen/qwen3.5-coder', label: 'Qwen: Qwen3.5 Coder', weight: 3, suggested: false },
  ];
  test('search matches name or slug, every word, any case; suggested ones stay in their own list', () => {
    expect(matchModels(all, '').map((c) => c.id)).toEqual(['x-ai/grok-5-fast', 'qwen/qwen3.5-coder']);
    expect(matchModels(all, 'GROK fast').map((c) => c.id)).toEqual(['x-ai/grok-5-fast']);
    expect(matchModels(all, 'qwen/').map((c) => c.id)).toEqual(['qwen/qwen3.5-coder']);
    expect(matchModels(all, 'deepseek')).toEqual([]);
  });

  test('the list from the api: an old answer without `suggested` reads as suggested; an odd entry drops the list', () => {
    expect(asModelChoices([{ id: 'a/b', label: 'A', weight: 1 }])).toEqual([{ id: 'a/b', label: 'A', weight: 1, suggested: true }]);
    expect(asModelChoices([{ id: 'a/b', label: 'A', weight: 1 }, { id: 'bad', label: 'B', weight: 1 }])).toBeNull();
  });

  test('models() reads GET /api/models and is null on any failure', async () => {
    const ok = createAgentActions({ api: (async () => ({ status: 200, json: { models: all } })) as never, token: async () => 't' });
    expect(await ok.models()).toEqual(all);
    const down = createAgentActions({ api: (async () => ({ status: 503, json: null })) as never, token: async () => 't' });
    expect(await down.models()).toBeNull();
    const signedOut = createAgentActions({ api: (async () => ({ status: 200, json: { models: all } })) as never, token: async () => undefined });
    expect(await signedOut.models()).toBeNull();
  });
});
