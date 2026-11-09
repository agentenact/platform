import { describe, expect, test } from 'bun:test';
import { createGetHeaderMe } from '../src/server/account';
import { createLoadAgent } from '../src/server/agent-data';
import { createGetMe, withCachedMe } from '../src/server/me';
import type { ApiCall } from '../src/server/api';
import { AGENT_ID, feed, overview } from './support/agent';

/** React's cache(), for a test: one answer per argument list for the life of one "request". */
const memo = <A extends unknown[], R>(fn: (...a: A) => R) => {
  const seen = new Map<string, R>();
  return (...a: A): R => {
    const k = JSON.stringify(a);
    if (!seen.has(k)) seen.set(k, fn(...a));
    return seen.get(k)!;
  };
};

const upstream = () => {
  const calls: string[] = [];
  const api: ApiCall = async (path) => {
    calls.push(path);
    if (path === '/api/me') return { status: 200, json: { agent: { id: AGENT_ID, name: 'XLM drop watcher', status: 'active' } } };
    if (path.endsWith('/overview')) return { status: 200, json: overview() };
    if (path.includes('/activity')) return { status: 200, json: feed() };
    return { status: 404, json: null };
  };
  return { api, calls };
};

describe('one profile read per request', () => {
  test('the layout header and the page share one /api/me call', async () => {
    const up = upstream();
    const api = withCachedMe(up.api, memo);
    const header = createGetHeaderMe({ email: async () => 'a@b.co', me: createGetMe({ token: async () => 't', api }) });
    const load = createLoadAgent({ token: async () => 't', api });
    expect(await header()).toEqual({ email: 'a@b.co', agentName: 'XLM drop watcher' });
    expect((await load(AGENT_ID)).kind).toBe('ready');
    expect(up.calls.filter((p) => p === '/api/me')).toHaveLength(1);
  });

  test('other paths, other tokens and writes are never served from the profile cache', async () => {
    const up = upstream();
    const api = withCachedMe(up.api, memo);
    await api('/api/me', { token: 'one' });
    await api('/api/me', { token: 'two' });
    await api('/api/me', { token: 'one' });
    await api('/api/me', { token: 'one', method: 'POST', body: {} });
    await api('/api/agents');
    await api('/api/agents');
    expect(up.calls).toEqual(['/api/me', '/api/me', '/api/me', '/api/agents', '/api/agents']);
  });
});
