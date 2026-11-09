import { describe, expect, test } from 'bun:test';
import { browserApprovalStore, APPROVAL_KEY } from '../src/lib/approval-store';
import { createApiCall, JSON_STATUSES, type ApiCall } from '../src/server/api';
import { createCreateActions } from '../src/server/create-actions';

const AGENT = '0f8e5a52-6a3c-4d0e-9a51-1d2a3b4c5d6e';

function setup(o: { status?: number; body?: unknown; token?: string | undefined; secret?: string | undefined; throws?: boolean; logs?: Record<string, unknown>[] } = {}) {
  const seen: { url: string; method: string; headers: Record<string, string>; body: unknown }[] = [];
  const fakeFetch = (async (url: string, init: RequestInit) => {
    seen.push({ url, method: String(init.method), headers: init.headers as Record<string, string>, body: init.body ? JSON.parse(String(init.body)) : undefined });
    if (o.throws) throw new TypeError('fetch failed: secret-looking detail');
    return new Response(JSON.stringify(o.body ?? {}), { status: o.status ?? 200, headers: { 'content-type': 'application/json' } });
  }) as unknown as typeof fetch;
  const api: ApiCall = createApiCall({
    fetch: fakeFetch,
    baseUrl: 'https://api.test',
    panelSecret: () => ('secret' in o ? o.secret : 'panel-secret-value'),
    requestHeaders: async () => new Headers({ 'x-forwarded-for': '198.51.100.9' }),
  });
  return { seen, actions: createCreateActions({ api, token: async () => ('token' in o ? o.token : 'user-jwt'), log: (e) => o.logs?.push(e) }) };
}

describe('create actions', () => {
  test('a failed call logs its route (ids masked), status and code; a thrown one its class name only; never a body', async () => {
    const logs: Record<string, unknown>[] = [];
    await setup({ status: 400, body: { error: 'bad_view', problem: 'x' }, logs }).actions.createAgent({ name: 'a', spec: {}, view: {} });
    await setup({ status: 500, body: { error: 'internal' }, logs }).actions.agent(AGENT);
    await setup({ throws: true, logs }).actions.createAgent({ name: 'a', spec: {}, view: {} });
    await setup({ token: undefined, logs }).actions.me();
    expect(logs).toEqual([
      { event: 'create_call_failed', route: 'POST /api/agents', status: 400, code: 'bad_view' },
      { event: 'create_call_failed', route: 'GET /api/agents/:id', status: 500 }, // a 5xx body is never read (Traefik replaces it)
      { event: 'create_call_failed', route: 'POST /api/agents', status: 503, threw: 'TypeError' },
      { event: 'create_call_failed', route: 'GET /api/me', status: 401, code: 'no_session' },
    ]);
    expect(JSON.stringify(logs)).not.toContain('secret-looking');
  });

  test('an expected 409 (agent_exists, wallet_exists) is an answer, not a logged failure', async () => {
    const logs: Record<string, unknown>[] = [];
    await setup({ status: 409, body: { error: 'agent_exists' }, logs }).actions.createAgent({ name: 'a', spec: {}, view: {} });
    expect(logs).toEqual([]);
  });

  test('a 202 body reaches the panel (agent create and retry answer { id })', async () => {
    expect(JSON_STATUSES.has(202)).toBe(true);
    const { seen, actions } = setup({ status: 202, body: { id: AGENT } });
    const key = '9f2b8c1e-5a4d-4e6f-9b7a-1c2d3e4f5a6b';
    expect(await actions.createAgent({ name: 'a', spec: {}, view: {}, key })).toEqual({ ok: true, id: AGENT, resumed: false });
    expect(seen[0]!.url).toBe('https://api.test/api/agents');
    expect(seen[0]!.body).toEqual({ name: 'a', spec: {}, view: {}, key });
    // The same key again: the api answers the agent it made.
    expect(await setup({ status: 200, body: { id: AGENT, resumed: true } }).actions.createAgent({ name: 'a', spec: {}, view: {}, key })).toEqual({ ok: true, id: AGENT, resumed: true });
    expect((await setup({ status: 202, body: { id: AGENT } }).actions.retry(AGENT))).toEqual({ ok: true, id: AGENT });
  });

  test('only the two per-IP limited passkey routes forward the visitor address, always with the bearer', async () => {
    const calls: [string, (a: ReturnType<typeof setup>['actions']) => Promise<unknown>][] = [
      ['/api/passkey/options', (a) => a.passkeyOptions()],
      ['/api/passkey/register', (a) => a.passkeyRegister({ id: 'x' })],
      ['/api/me', (a) => a.me()],
      ['/api/wallet', (a) => a.wallet()],
      ['/api/agents', (a) => a.createAgent({ name: 'n', spec: {}, view: {} })],
      [`/api/agents/${AGENT}`, (a) => a.agent(AGENT)],
      [`/api/agents/${AGENT}/retry`, (a) => a.retry(AGENT)],
      ['/api/sign-requests', (a) => a.signRequests()],
      [`/api/sign-requests/${AGENT}/sign`, (a) => a.sign(AGENT, 'xdr')],
      [`/api/sign-requests/${AGENT}/reject`, (a) => a.reject(AGENT)],
    ];
    for (const [path, run] of calls) {
      const { seen, actions } = setup({ body: { optionsJSON: {}, ownerAddress: 'C', requests: [] } });
      await run(actions);
      expect(seen).toHaveLength(1);
      expect(seen[0]!.url).toBe(`https://api.test${path}`);
      expect(seen[0]!.headers.authorization).toBe('Bearer user-jwt');
      const forwards = path.startsWith('/api/passkey/');
      expect(seen[0]!.headers['x-client-ip']).toEqual(forwards ? '198.51.100.9' : (undefined as never));
      expect(seen[0]!.headers['x-panel-secret']).toEqual(forwards ? 'panel-secret-value' : (undefined as never));
    }
  });

  test('without a PANEL_SECRET the passkey call still goes out, with no panel headers', async () => {
    const { seen, actions } = setup({ secret: undefined, body: { optionsJSON: { c: 1 } } });
    expect(await actions.passkeyOptions()).toEqual({ ok: true, optionsJSON: { c: 1 } });
    expect(seen[0]!.headers['x-client-ip']).toBeUndefined();
  });

  test('signed out is a 401 and nothing is called', async () => {
    const { seen, actions } = setup({ token: undefined });
    expect(await actions.me()).toEqual({ ok: false, status: 401, code: 'unauthorized' });
    expect(seen).toHaveLength(0);
  });

  test('failures carry the status and code, never a message; a hidden 5xx body is just a status', async () => {
    expect(await setup({ status: 409, body: { error: 'agent_exists' } }).actions.createAgent({ name: 'n', spec: {}, view: {} })).toEqual({ ok: false, status: 409, code: 'agent_exists' });
    expect(await setup({ status: 502, body: 'x' }).actions.agent(AGENT)).toEqual({ ok: false, status: 502 });
  });

  test('ids that are not uuids never reach a path', async () => {
    const { seen, actions } = setup();
    expect((await actions.agent('../x')).ok).toBe(false);
    expect((await actions.sign('a/b', 'x')).ok).toBe(false);
    expect(seen).toHaveLength(0);
  });

  test('the agent status keeps only what the flow reads', async () => {
    const { actions } = setup({ body: { id: AGENT, status: 'provisioning', stellarAddress: 'G', provision: { step: 'failed', error: 'chain_error', attempts: [{ publicKey: 'G' }] }, lastStart: { outcome: 'deferred', code: 'registry_unreadable', at: 't' }, needsOperator: false } });
    expect(await actions.agent(AGENT)).toEqual({ ok: true, status: 'provisioning', step: 'failed', error: 'chain_error', needsOperator: false, lastStart: { outcome: 'deferred', code: 'registry_unreadable' } });
  });

  test('sign requests: only request-shaped entries are listed', async () => {
    const good = { id: 'a', kind: 'register', agentId: AGENT, entryXdr: 'x' };
    const { actions } = setup({ body: [good, { id: 'b', kind: 'transfer', entryXdr: 'x', agentId: 'y' }, 5] });
    expect(await actions.signRequests()).toEqual({ ok: true, requests: [good] as never });
  });
});

describe('the browser approval store', () => {
  const mem = (init: Record<string, string> = {}) => {
    const m = new Map(Object.entries(init));
    return { getItem: (k: string) => m.get(k) ?? null, setItem: (k: string, v: string) => void m.set(k, v), removeItem: (k: string) => void m.delete(k) };
  };
  const approval = { signedEntryXdr: 'x', summary: 's', call: { fn: 'register_with_uri', owner: 'C', agentUri: 'u' } } as never;
  test('round-trips, clears, and treats a corrupt value as empty', () => {
    const store = browserApprovalStore(mem());
    expect(store.getRegistered()).toBeNull();
    store.setRegistered({ approval, txHash: 'h' });
    expect(store.getRegistered()).toEqual({ approval, txHash: 'h' });
    store.clearRegistered();
    expect(store.getRegistered()).toBeNull();
    expect(browserApprovalStore(mem({ [APPROVAL_KEY]: '{not json' })).getRegistered()).toBeNull();
    expect(browserApprovalStore(mem({ [APPROVAL_KEY]: JSON.stringify({ approval: { call: {} } }) })).getRegistered()).toBeNull();
  });
  test('a failing write throws so the gate does not send', () => {
    const store = browserApprovalStore({ ...mem(), setItem: () => { throw new Error('quota'); } });
    expect(() => store.setRegistered({ approval })).toThrow();
  });
});
