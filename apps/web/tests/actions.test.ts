import { describe, expect, test } from 'bun:test';
import { copy, errorCopy } from '../src/copy';
import { createApiCall, type ApiCall } from '../src/server/api';
import { createBuilderActions } from '../src/server/builder-actions';

interface Seen {
  url: string;
  headers: Record<string, string>;
  body: unknown;
}

/** A fake fetch that records the request and answers with `status` and `body` (a string is sent as is, e.g. Traefik's HTML). */
function setup(o: { status?: number; body?: unknown; secret?: string | undefined; incoming?: Record<string, string>; token?: string }) {
  const seen: Seen[] = [];
  const fakeFetch = (async (url: string, init: RequestInit) => {
    seen.push({ url, headers: init.headers as Record<string, string>, body: init.body ? JSON.parse(String(init.body)) : undefined });
    const raw = typeof o.body === 'string' ? o.body : JSON.stringify(o.body ?? {});
    return new Response(raw, { status: o.status ?? 200, headers: { 'content-type': typeof o.body === 'string' ? 'text/html' : 'application/json' } });
  }) as unknown as typeof fetch;
  const api: ApiCall = createApiCall({
    fetch: fakeFetch,
    baseUrl: 'https://api.test',
    panelSecret: () => ('secret' in o ? o.secret : 'panel-secret-value'),
    requestHeaders: async () => new Headers(o.incoming ?? { 'x-forwarded-for': '198.51.100.9' }),
  });
  const actions = createBuilderActions({ api, token: async () => o.token });
  return { seen, actions };
}

describe('anonymous calls', () => {
  test("an anonymous draft sends x-client-ip = the visitor and x-panel-secret, never the panel server's address", async () => {
    // The panel server's own address (10.0.1.5) is the socket peer; it never appears in these headers.
    const { seen, actions } = setup({ body: { draft: { ok: 1 } }, incoming: { 'x-forwarded-for': '162.158.10.1', 'cf-connecting-ip': '203.0.113.7', 'x-client-ip': '6.6.6.6' } });
    const r = await actions.draft('watch xlm');
    expect(r).toEqual({ ok: true, draft: { ok: 1 } });
    expect(seen).toHaveLength(1);
    expect(seen[0]!.url).toBe('https://api.test/api/builder/draft');
    expect(seen[0]!.headers['x-client-ip']).toBe('203.0.113.7');
    expect(seen[0]!.headers['x-panel-secret']).toBe('panel-secret-value');
    expect(seen[0]!.headers.authorization).toBeUndefined();
    expect(JSON.stringify(seen[0]!.headers)).not.toContain('10.0.1.5');
  });
  test('a visitor-supplied x-client-ip header is not forwarded as the visitor', async () => {
    const { seen, actions } = setup({ body: { draft: {} }, incoming: { 'x-forwarded-for': '198.51.100.9', 'x-client-ip': '6.6.6.6' } });
    await actions.draft('x');
    expect(seen[0]!.headers['x-client-ip']).toBe('198.51.100.9');
  });
  test('with no PANEL_SECRET the anonymous call is not made', async () => {
    const { seen, actions } = setup({ secret: undefined });
    const r = await actions.draft('x');
    expect(seen).toHaveLength(0);
    expect(r).toEqual({ ok: false, kind: 'failed', message: copy.errors.status5xx });
  });
  test('the secret never appears in a result', async () => {
    const { actions } = setup({ status: 502, body: { error: 'builder_failed', code: 'budget' } });
    expect(JSON.stringify(await actions.draft('x'))).not.toContain('panel-secret-value');
  });
});

describe('signed-in calls', () => {
  test('send the bearer and no panel headers', async () => {
    const { seen, actions } = setup({ token: 'user-jwt', body: { trial: { ok: true } } });
    const r = await actions.trial({ name: 'a' });
    expect(r).toEqual({ ok: true, trial: { ok: true } });
    expect(seen[0]!.headers.authorization).toBe('Bearer user-jwt');
    expect(seen[0]!.headers['x-panel-secret']).toBeUndefined();
    expect(seen[0]!.headers['x-client-ip']).toBeUndefined();
  });
  test('a signed-in call works with no PANEL_SECRET set', async () => {
    const { seen, actions } = setup({ token: 't', secret: undefined, body: { draft: {} } });
    expect((await actions.edit({}, 'p', 1)).ok).toBe(true);
    expect(seen).toHaveLength(1);
  });
});

describe('error mapping', () => {
  test('429 sign_in_to_keep_drafting maps to sign_in', async () => {
    const { actions } = setup({ status: 429, body: { error: 'sign_in_to_keep_drafting' } });
    expect(await actions.draft('x')).toEqual({ ok: false, kind: 'sign_in', message: copy.errors.signInToKeepDrafting });
  });
  test('429 capacity_reached (all signed-in drafting for today is used) maps to daily with its own plain line', async () => {
    const { actions } = setup({ status: 429, body: { error: 'capacity_reached' } });
    expect(await actions.draft('x')).toEqual({ ok: false, kind: 'daily', message: copy.errors.capacityReached });
  });

  test('400 bad_name has its own plain line', () => {
    expect(errorCopy('bad_name', 400)).toBe(copy.errors.badName);
  });

  test('429 daily_limit maps to daily', async () => {
    const { actions } = setup({ status: 429, body: { error: 'daily_limit' } });
    expect(await actions.draft('x')).toEqual({ ok: false, kind: 'daily', message: copy.errors.dailyLimit });
  });
  test('any other 429 maps to busy', async () => {
    const { actions } = setup({ status: 429, body: { error: 'rate_limited' } });
    expect(await actions.draft('x')).toMatchObject({ ok: false, kind: 'busy' });
  });
  test('401 maps to sign_in', async () => {
    const { actions } = setup({ status: 401, body: { error: 'unauthorized' }, token: 'old' });
    expect(await actions.handoff({})).toMatchObject({ ok: false, kind: 'sign_in' });
  });
  test('502 maps to failed (Traefik replaces its body, so the status decides)', async () => {
    const { actions } = setup({ status: 502, body: { error: 'builder_failed', code: 'budget' } });
    expect(await actions.draft('x')).toEqual({ ok: false, kind: 'failed', message: copy.errors.status5xx });
  });
  test('a 400 JSON code gets its own sentence', async () => {
    const { actions } = setup({ status: 400, body: { error: 'bad_edit', problem: 'x' } });
    expect(await actions.edit({}, 'p', 1)).toEqual({ ok: false, kind: 'failed', message: copy.errors.badEdit });
  });
  test('409 maps to busy', async () => {
    const { actions } = setup({ status: 409, body: { error: 'agent_exists' } });
    expect(await actions.handoff({})).toEqual({ ok: false, kind: 'busy', message: copy.errors.agentExists });
  });
  test('a 503 with an HTML body maps to failed without parsing the body', async () => {
    const { actions } = setup({ status: 503, body: '<html>Service Unavailable</html>' });
    expect(await actions.draft('x')).toEqual({ ok: false, kind: 'failed', message: copy.errors.status5xx });
  });
  test('a 200 without the expected body is a failure, not a success', async () => {
    const { actions } = setup({ body: {} });
    expect(await actions.draft('x')).toMatchObject({ ok: false, kind: 'failed' });
  });
  test('a network error maps to failed', async () => {
    const api: ApiCall = async () => {
      throw new Error('connect ECONNREFUSED');
    };
    const r = await createBuilderActions({ api, token: async () => undefined }).draft('x');
    expect(r).toMatchObject({ ok: false, kind: 'failed' });
    expect(JSON.stringify(r)).not.toContain('ECONNREFUSED');
  });
});

describe('request shapes', () => {
  test('draft, edit, trial and handoff post the bodies the api expects', async () => {
    const a = setup({ body: { draft: { d: 1 } } });
    await a.actions.draft('p', { cur: 1 });
    await a.actions.draft('p');
    await a.actions.edit({ d: 1 }, 'N', 5);
    expect(a.seen.map((s) => [s.url.replace('https://api.test', ''), s.body])).toEqual([
      ['/api/builder/draft', { prompt: 'p', current: { cur: 1 } }],
      ['/api/builder/draft', { prompt: 'p' }],
      ['/api/builder/edit', { draft: { d: 1 }, param: 'N', value: 5 }],
    ]);
    const h = setup({ body: { id: 'abcdefghijklmnopqrstuv' } });
    expect(await h.actions.handoff({ d: 1 })).toEqual({ ok: true, id: 'abcdefghijklmnopqrstuv' });
    expect(h.seen[0]!.url).toBe('https://api.test/api/builder/handoff');
    expect(h.seen[0]!.body).toEqual({ draft: { d: 1 } }); // no email: the limit path carries none
    await h.actions.handoff({ d: 1 }, 'Ada@Example.com');
    expect(h.seen[1]!.body).toEqual({ draft: { d: 1 }, email: 'Ada@Example.com' });
  });
});
