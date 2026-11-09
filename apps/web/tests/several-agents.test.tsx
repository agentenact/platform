import { describe, expect, test } from 'bun:test';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { MyAgentsView } from '../src/components/my-agents';
import { copy } from '../src/copy';
import { creationKey, forgetCreationKey } from '../src/lib/creation-key';
import { createLoadAgent, createLoadAgents } from '../src/server/agent-data';
import type { ApiCall, ApiResult } from '../src/server/api';
import { dashboardTarget, legacyTarget, queryOf } from '../src/server/dashboard-route';
import { feed, overview } from './support/agent';
import { textOf } from './support/screens';

const A = { id: '3f2b8c1e-5a4d-4e6f-9b7a-1c2d3e4f5a6b', name: 'XLM drop alert', status: 'active' };
const B = { id: '4f2b8c1e-5a4d-4e6f-9b7a-1c2d3e4f5a6b', name: 'USDC watcher', status: 'paused' };
const ME: ApiResult = { status: 200, json: { agent: A, agents: [A, B], agentLimit: 3 } };

function memory() {
  const m = new Map<string, string>();
  return { getItem: (k: string) => m.get(k) ?? null, setItem: (k: string, v: string) => void m.set(k, v), removeItem: (k: string) => void m.delete(k) };
}

describe('several agents: loading one by the id in the address', () => {
  const api: ApiCall = async (path) =>
    path === '/api/me' ? ME
    : path.endsWith('/overview') ? { status: 200, json: overview() }
    : path.includes('/activity') ? { status: 200, json: feed() }
    : { status: 404, json: null };
  const load = createLoadAgent({ token: async () => 't', api, sentenceTimeoutMs: 5 });

  test('any of the owner\'s agents loads, its own id kept (case-insensitive)', async () => {
    const b = await load(B.id.toUpperCase());
    expect(b.kind === 'ready' && b.id).toBe(B.id);
    const a = await load(A.id);
    expect(a.kind === 'ready' && a.id).toBe(A.id);
  });
  test('an id that is not theirs, or not an id, is no_agent: nothing of it is read', async () => {
    const seen: string[] = [];
    const spy = createLoadAgent({ token: async () => 't', api: async (p, o) => (seen.push(p), api(p, o)) });
    expect((await spy('5f2b8c1e-5a4d-4e6f-9b7a-1c2d3e4f5a6b')).kind).toBe('no_agent');
    expect((await spy('../me')).kind).toBe('no_agent');
    expect(seen).toEqual(['/api/me', '/api/me']);
  });
  test('the list loads the agents and the limit', async () => {
    expect(await createLoadAgents({ token: async () => 't', api })()).toEqual({ kind: 'ready', agents: [A, B], limit: 3 });
    expect(await createLoadAgents({ token: async () => undefined, api })()).toEqual({ kind: 'signed_out' });
    expect(await createLoadAgents({ token: async () => 't', api: async () => ({ status: 503, json: null }) })()).toEqual({ kind: 'error' });
  });
});

describe('My agents', () => {
  test('one row per agent, each to its own page, with a plain status; the slots are counted and each free one creates', () => {
    const html = renderToStaticMarkup(createElement(MyAgentsView, { agents: [A, B], limit: 3 }));
    const t = textOf(html);
    expect(t).toContain('XLM drop alert');
    expect(t).toContain('USDC watcher');
    expect(t).toContain('Watching');
    expect(t).toContain('Paused');
    expect(t).toContain('2 of 3 agents · testnet');
    expect(html).toContain(`href="/dashboard/${A.id}"`);
    expect(html).toContain(`href="/dashboard/${B.id}"`);
    expect(html).toMatch(/<a[^>]*data-new-agent=""[^>]*href="\/create"/);
    expect(html.match(/data-free-slot/g)).toHaveLength(1);
    expect(html).toMatch(/<a[^>]*data-free-slot[^>]*href="\/create"/);
    expect(html.match(/rounded-full bg-fg"/g)).toHaveLength(2);
    expect(t).not.toContain(copy.myAgents.full(3));
  });
  test('at the limit New agent stays in place but inactive, the reason is on the page, and no free slot is drawn', () => {
    const html = renderToStaticMarkup(createElement(MyAgentsView, { agents: [A, B], limit: 2 }));
    expect(html).toMatch(/<span[^>]*aria-disabled="true"[^>]*data-new-agent="full"/);
    expect(html).not.toMatch(/<a[^>]*href="\/create"/);
    expect(html).not.toContain('data-free-slot');
    expect(textOf(html)).toContain('All 2 are in use. An account can have 2 agents on testnet.');
    expect(textOf(html)).toContain('2 of 2 agents · testnet');
  });
  test('with an idea to add, each row opens that agent\'s editor with the idea in the box, and nothing offers creating', () => {
    const html = renderToStaticMarkup(createElement(MyAgentsView, { agents: [A, B], limit: 3, prompt: 'also USDC & more' }));
    expect(html).toContain(`href="/dashboard/${B.id}?tab=edit&amp;prompt=also+USDC+%26+more"`);
    expect(textOf(html)).toContain(copy.myAgents.addTo);
    expect(html).not.toContain('data-new-agent');
    expect(html).not.toContain('data-free-slot');
  });
});

describe('plain /dashboard', () => {
  test('always the list, even with one agent; an old run or idea link opens the only agent; none goes home', () => {
    expect(dashboardTarget([A], {})).toBeNull();
    expect(dashboardTarget([A, B], {})).toBeNull();
    expect(dashboardTarget([A], { run: 'r1' })).toBe(`/dashboard/${A.id}?run=r1`);
    expect(dashboardTarget([A], { prompt: 'x' })).toBe(`/dashboard/${A.id}?prompt=x`);
    expect(dashboardTarget([A, B], { prompt: 'x' })).toBeNull();
    expect(dashboardTarget([], {})).toBe('/');
    expect(dashboardTarget(null, {})).toBe('/');
  });
});

describe('old addresses', () => {
  test('one agent: that tab of it, query kept; several: the list with the query; none: the first screen', () => {
    expect(legacyTarget([A], 'chat', {})).toBe(`/dashboard/${A.id}?tab=chat`);
    expect(legacyTarget([A], 'activity', { run: 'r1' })).toBe(`/dashboard/${A.id}?run=r1`);
    expect(legacyTarget([A, B], 'whatItDoes', { prompt: 'x y' })).toBe('/dashboard?prompt=x+y');
    expect(legacyTarget([], 'chat', {})).toBe('/');
    expect(legacyTarget(null, 'chat', {})).toBe('/');
    expect(queryOf({ a: '1', b: ['2', '3'], c: undefined })).toBe('?a=1');
  });
});

describe('the creation key', () => {
  test('the same description in the same tab keeps its key; another description gets a new one; done forgets it', () => {
    const store = memory();
    let n = 0;
    const make = () => `00000000-0000-4000-8000-00000000000${++n}`;
    const one = { name: 'a', spec: { s: 1 }, view: {} };
    const k1 = creationKey(one, store, make);
    expect(creationKey(one, store, make)).toBe(k1);
    const k2 = creationKey({ ...one, name: 'b' }, store, make);
    expect(k2).not.toBe(k1);
    forgetCreationKey(store);
    expect(creationKey({ ...one, name: 'b' }, store, make)).not.toBe(k2);
  });
  test('storage that throws or holds junk still gives a key', () => {
    const broken = { getItem: () => { throw new Error('blocked'); }, setItem: () => { throw new Error('blocked'); }, removeItem: () => { throw new Error('blocked'); } };
    expect(creationKey({ x: 1 }, broken, () => '00000000-0000-4000-8000-000000000009')).toBe('00000000-0000-4000-8000-000000000009');
    const junk = memory();
    junk.setItem('ae:creation-key', '{"of":"{\\"x\\":1}","key":"not-a-uuid"}');
    expect(creationKey({ x: 1 }, junk, () => '00000000-0000-4000-8000-000000000008')).toBe('00000000-0000-4000-8000-000000000008');
    expect(creationKey({ x: 1 }, null, () => '00000000-0000-4000-8000-000000000007')).toBe('00000000-0000-4000-8000-000000000007');
    forgetCreationKey(broken);
  });
});
