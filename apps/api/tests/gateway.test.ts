import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { Keypair } from '@stellar/stellar-sdk';
import type { AuthUser, AuthVerifier } from '../src/account/auth.js';
import { createPasskeyAccount, type PasskeyAccount, type WalletDeployer } from '../src/account/passkey.js';
import { createSignRequests, type SignRequests } from '../src/account/sign-requests.js';
import type { Db } from '../src/db/index.js';
import { httpError } from '../src/errors.js';
import {
  createApp,
  MAX_ORPHANS,
  PASSKEY_OPTIONS_PER_ACCOUNT,
  PASSKEY_REGISTER_PER_ACCOUNT,
  PASSKEY_REGISTER_PER_IP,
  RETRY_LIMIT_PER_ACCOUNT,
  type AppDeps,
} from '../src/gateway/app.js';
import { TESTNET } from '../src/owner-client/testnet.js';
import type { StartOutcome } from '../src/provision/index.js';
import { freshDb } from './support/db.js';
import { authEntry, b64, scv, signEntry } from './support/entries.js';
import { contractAddress, insertAgent, insertUser } from './support/fixtures.js';
import { minimalSpec } from './support/specs.js';
import { softAuthenticator } from './support/soft-authenticator.js';

const ORIGIN = 'https://app.agentenact.io';
const API = 'https://api.agentenact.io';
const PUBLIC = 'https://public.example.test';
const A = { id: crypto.randomUUID(), email: 'a@example.com' };
const B = { id: crypto.randomUUID(), email: 'b@example.com' };
const C = { id: crypto.randomUUID(), email: 'c@example.com' };
const walletC = contractAddress(7);
const sponsor = Keypair.random().publicKey();

describe('gateway', () => {
  let sql: Db;
  let drop: () => Promise<void>;
  let app: (req: Request, ip?: string) => Promise<Response>;
  let signRequests: SignRequests;
  let deps: AppDeps;
  const started: string[] = [];
  let nextOutcome: StartOutcome = { outcome: 'busy' };
  let verifierDown = false;
  let agentA = '';
  /** tok-a/b/c, plus tok-u:<uuid> for throwaway users (rate-limit tests). */
  const users = new Map<string, AuthUser>([['tok-a', A], ['tok-b', B], ['tok-c', C]]);

  beforeAll(async () => {
    ({ sql, drop } = await freshDb());
    const verify: AuthVerifier = async (t) => {
      if (verifierDown) throw new Error('auth: the token verifier is unavailable');
      if (t.startsWith('tok-u:')) return { id: t.slice(6), email: `${t.slice(6)}@example.com` };
      return users.get(t) ?? null;
    };
    const deployer: WalletDeployer = {
      deployPasskeyWallet: async (response) => ({
        contractId: walletC,
        credentialId: response.id,
        credential: { credentialId: response.id, publicKey: 'BAQE', contractId: walletC, createdAt: 1, isPrimary: true },
        deployTx: 'd'.repeat(64),
      }),
    };
    signRequests = createSignRequests(sql, { source: sponsor, pollMs: 10, latestLedger: async () => 5000 });
    deps = {
      sql,
      verify,
      passkey: createPasskeyAccount({ sql, chain: deployer, rpId: 'agentenact.io', origin: ORIGIN }),
      signRequests,
      provisioner: { start: async (id) => (started.push(id), nextOutcome) },
      appOrigin: ORIGIN,
    };
    app = createApp(deps);
  });
  afterAll(() => drop());

  const callOn = async (handler: typeof app, method: string, path: string, token?: string, body?: unknown, ip?: string) => {
    const headers: Record<string, string> = {};
    if (token) headers.authorization = `Bearer ${token}`;
    if (body !== undefined) headers['content-type'] = 'application/json';
    const res = await handler(
      new Request(`${API}${path}`, { method, headers, body: body === undefined ? undefined : typeof body === 'string' ? body : JSON.stringify(body) }),
      ip,
    );
    const text = await res.text();
    return { status: res.status, headers: res.headers, body: text ? JSON.parse(text) : null };
  };
  const call = (method: string, path: string, token?: string, body?: unknown) => callOn(app, method, path, token, body);

  it('health checks the database; CORS allows only the app origin, with no credentials', async () => {
    const h = await call('GET', '/health');
    expect([h.status, h.body]).toEqual([200, { ok: true }]);
    // No Origin (not a browser cross-origin call): no allow-origin, and the answer still varies by Origin.
    expect([h.headers.get('access-control-allow-origin'), h.headers.get('vary')]).toEqual([null, 'Origin']);
    const pre = await app(new Request(`${API}/api/me`, { method: 'OPTIONS', headers: { origin: ORIGIN, 'access-control-request-method': 'POST' } }));
    expect(pre.status).toBe(204);
    expect(pre.headers.get('access-control-allow-origin')).toBe(ORIGIN);
    expect(pre.headers.get('access-control-allow-headers')).toBe('authorization, content-type');
    expect(pre.headers.get('access-control-allow-credentials')).toBeNull();
    // A foreign origin is never echoed back, and gets no allow-origin at all.
    const evil = await app(new Request(`${API}/api/me`, { method: 'OPTIONS', headers: { origin: 'https://evil.example', 'access-control-request-method': 'POST' } }));
    expect([evil.status, evil.headers.get('access-control-allow-origin'), evil.headers.get('vary')]).toEqual([204, null, 'Origin']);
  });

  it('CORS with APP_ORIGINS: reflects an origin in the list, refuses one that is not, leaves /a/ and /public/ alone', async () => {
    const multi = createApp({ ...deps, appOrigins: [ORIGIN, 'https://agentenact.io', 'https://staging.agentenact.io'] });
    const from = (origin: string | null, path = '/health', method = 'GET') =>
      multi(new Request(`${API}${path}`, { method, headers: origin ? { origin, 'access-control-request-method': 'POST' } : {} }));
    for (const origin of [ORIGIN, 'https://agentenact.io', 'https://staging.agentenact.io']) {
      const pre = await from(origin, '/api/me', 'OPTIONS');
      expect([origin, pre.status, pre.headers.get('access-control-allow-origin'), pre.headers.get('vary')]).toEqual([origin, 204, origin, 'Origin']);
      const got = await from(origin);
      expect([origin, got.status, got.headers.get('access-control-allow-origin')]).toEqual([origin, 200, origin]);
      // Error answers carry it too.
      const err = await from(origin, '/api/me');
      expect([origin, err.status, err.headers.get('access-control-allow-origin')]).toEqual([origin, 401, origin]);
    }
    // Near misses are not in the list: another subdomain, http, a port, a trailing slash, the srvl.app host, a suffix trick.
    for (const origin of ['https://evil.agentenact.io', 'http://agentenact.io', 'https://agentenact.io:8443', 'https://agentenact.io/', 'https://agentenact.srvl.app', 'https://agentenact.io.evil.example', 'null']) {
      const pre = await from(origin, '/api/me', 'OPTIONS');
      expect([origin, pre.headers.get('access-control-allow-origin'), pre.headers.get('vary')]).toEqual([origin, null, 'Origin']);
      expect([origin, (await from(origin)).headers.get('access-control-allow-origin')]).toEqual([origin, null]);
    }
    // The public surfaces keep ACAO * whatever the Origin.
    const paid = await from('https://evil.example', `/a/${crypto.randomUUID()}/x`, 'OPTIONS');
    expect(paid.headers.get('access-control-allow-origin')).toBe('*');
  });

  it('auth: no token or a bad token is 401; a down verifier is 503; a good token upserts the profile', async () => {
    expect((await call('GET', '/api/me')).status).toBe(401);
    expect(await call('GET', '/api/me', 'nope')).toMatchObject({ status: 401, body: { error: 'unauthorized' } });
    verifierDown = true;
    expect(await call('GET', '/api/me', 'tok-a')).toMatchObject({ status: 503, body: { error: 'auth_unavailable' } });
    verifierDown = false;
    expect(await call('GET', '/api/me', 'tok-a')).toMatchObject({ status: 200, body: { id: A.id, email: A.email, ownerAddress: null } });
  });

  it('an unavailable verifier is logged (auth_unavailable, how long it took, the class name only); the body carries only the code', async () => {
    const events: Record<string, string | number>[] = [];
    const down = createApp({ ...deps, verify: async () => { throw Object.assign(new Error('auth: secret detail'), { name: 'AuthTimeout' }); }, log: (e) => events.push(e) });
    expect(await callOn(down, 'POST', '/api/agents', 'tok-a', { name: 'n' })).toMatchObject({ status: 503, body: { error: 'auth_unavailable' } });
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ event: 'auth_unavailable', errName: 'AuthTimeout' });
    expect(typeof events[0]!.ms).toBe('number');
    expect(JSON.stringify(events)).not.toContain('secret detail');
  });

  it('the profile is written only when it is missing or the email changed (no upsert per request)', async () => {
    const D = { id: crypto.randomUUID(), email: 'd@example.com' };
    users.set('tok-d', D);
    const writes: string[] = [];
    const spy = new Proxy(sql, {
      apply(target, thisArg, args: unknown[]) {
        const text = (args[0] as string[]).join('?');
        if (/insert into app\.users/.test(text)) writes.push('upsert');
        return Reflect.apply(target, thisArg, args);
      },
    }) as Db;
    const spied = createApp({ ...deps, sql: spy });
    expect((await callOn(spied, 'GET', '/api/me', 'tok-d')).body).toMatchObject({ id: D.id, email: D.email });
    await callOn(spied, 'GET', '/api/me', 'tok-d');
    await callOn(spied, 'GET', '/api/me', 'tok-d');
    expect(writes).toEqual(['upsert']);
    users.set('tok-d', { ...D, email: 'd2@example.com' });
    expect((await callOn(spied, 'GET', '/api/me', 'tok-d')).body).toMatchObject({ email: 'd2@example.com' });
    expect(writes).toEqual(['upsert', 'upsert']);
  });

  it('an agent needs a wallet first', async () => {
    expect(await call('POST', '/api/agents', 'tok-b', { name: 'Scout', spec: minimalSpec() })).toMatchObject({ status: 409, body: { error: 'no_wallet' } });
  });

  it('passkey: options → browser ceremony → register → the profile owns the wallet', async () => {
    const soft = softAuthenticator({ rpId: 'agentenact.io', origin: ORIGIN });
    const opts = await call('POST', '/api/passkey/options', 'tok-a');
    expect(opts.status).toBe(200);
    const response = await soft.webAuthn.startRegistration(opts.body);
    expect(await call('POST', '/api/passkey/register', 'tok-a', { response })).toMatchObject({ status: 200, body: { ownerAddress: walletC } });
    expect((await call('GET', '/api/me', 'tok-a')).body.ownerAddress).toBe(walletC);
    expect(await call('GET', '/api/wallet', 'tok-a')).toMatchObject({ status: 200, body: { contractId: walletC, credentialId: response.id } });
    expect(await call('GET', '/api/wallet', 'tok-b')).toMatchObject({ status: 404, body: { error: 'no_wallet' } });
  });

  it('passkey: wallet_record_failed logs the public contractId and deployTx; the body carries only the code', async () => {
    const events: Record<string, string | number>[] = [];
    const failing: PasskeyAccount = {
      ...deps.passkey,
      register: async () => {
        throw Object.assign(httpError(502, 'wallet_record_failed'), { contractId: contractAddress(5), deployTx: 'f'.repeat(64) });
      },
    };
    const U = crypto.randomUUID();
    const shaped = await softAuthenticator({ rpId: 'agentenact.io', origin: ORIGIN }).webAuthn.startRegistration({ optionsJSON: { challenge: 'c' } });
    const res = await callOn(createApp({ ...deps, passkey: failing, log: (e) => events.push(e) }), 'POST', '/api/passkey/register', `tok-u:${U}`, { response: shaped });
    expect([res.status, res.body]).toEqual([502, { error: 'wallet_record_failed' }]);
    expect(events).toEqual([{ event: 'wallet_record_failed', user: U, contractId: contractAddress(5), deployTx: 'f'.repeat(64) }]);
  });

  it('passkey: a malformed register body is 400 bad_request, never a 500', async () => {
    for (const b of [{}, { response: null }, { response: {} }, { response: { response: 'x' } }, { response: { response: {} } }, []]) {
      const tok = `tok-u:${crypto.randomUUID()}`; // one account per body: register allows 5 per account per hour
      expect(await call('POST', '/api/passkey/register', tok, b)).toMatchObject({ status: 400, body: { error: 'bad_request' } });
    }
  });

  it('passkey: register (paid) is tight per account; options is looser; each is separate', async () => {
    const limited = createApp(deps);
    const tok = `tok-u:${crypto.randomUUID()}`;
    for (let i = 0; i < PASSKEY_REGISTER_PER_ACCOUNT; i++) {
      expect((await callOn(limited, 'POST', '/api/passkey/register', tok, { response: {} }, `10.0.0.${i}`)).status).toBe(400);
    }
    const over = await callOn(limited, 'POST', '/api/passkey/register', tok, { response: {} }, '10.0.1.1');
    expect([over.status, over.body]).toEqual([429, { error: 'rate_limited' }]);
    expect(Number(over.headers.get('retry-after'))).toBeGreaterThan(0);
    expect(over.headers.get('access-control-expose-headers')).toBe('retry-after'); // the browser may read it
    // options has its own, looser budget.
    for (let i = 0; i < PASSKEY_OPTIONS_PER_ACCOUNT; i++) {
      expect((await callOn(limited, 'POST', '/api/passkey/options', tok, undefined, `10.0.2.${i}`)).status).toBe(200);
    }
    expect((await callOn(limited, 'POST', '/api/passkey/options', tok, undefined, '10.0.3.1')).status).toBe(429);
    // Another account is unaffected.
    expect((await callOn(limited, 'POST', '/api/passkey/options', `tok-u:${crypto.randomUUID()}`, undefined, '10.0.3.1')).status).toBe(200);
  });

  it('passkey: register is rate-limited per IP across accounts (open signups); IPv6 counts per /64', async () => {
    const limited = createApp(deps);
    for (let i = 0; i < PASSKEY_REGISTER_PER_IP; i++) {
      expect((await callOn(limited, 'POST', '/api/passkey/register', `tok-u:${crypto.randomUUID()}`, { response: {} }, `2001:db8:5:6::${i.toString(16)}`)).status).toBe(400);
    }
    expect(await callOn(limited, 'POST', '/api/passkey/register', `tok-u:${crypto.randomUUID()}`, { response: {} }, '2001:db8:5:6:ffff::1')).toMatchObject({
      status: 429,
      body: { error: 'rate_limited' },
    });
    expect((await callOn(limited, 'POST', '/api/passkey/register', `tok-u:${crypto.randomUUID()}`, { response: {} }, '2001:db8:5:7::1')).status).toBe(400);
  });

  it('passkey: unauthenticated requests do not spend the IP budget', async () => {
    const limited = createApp(deps);
    for (let i = 0; i < PASSKEY_REGISTER_PER_IP + 5; i++) {
      expect((await callOn(limited, 'POST', '/api/passkey/register', 'nope', { response: {} }, '198.51.100.7')).status).toBe(401);
    }
    expect((await callOn(limited, 'POST', '/api/passkey/register', `tok-u:${crypto.randomUUID()}`, { response: {} }, '198.51.100.7')).status).toBe(400);
  });

  it('agents: validate the name, start provisioning, one per user', async () => {
    expect(await call('POST', '/api/agents', 'tok-a', { name: '  ', spec: minimalSpec() })).toMatchObject({ status: 400, body: { error: 'bad_name' } });
    // A view that does not describe the spec is refused before anything is written.
    const view = { sentence: ['I watch the market.'], params: [], bindings: [] };
    expect(await call('POST', '/api/agents', 'tok-a', { name: 'Scout', spec: minimalSpec(), view: { ...view, sentence: [] } })).toMatchObject({ status: 400, body: { error: 'bad_view' } });
    expect(started).toEqual([]);
    const created = await call('POST', '/api/agents', 'tok-a', { name: 'Scout', spec: minimalSpec(), view });
    expect(created.status).toBe(202);
    agentA = created.body.id;
    expect(((await sql`select view from app.agent_specs where agent_id = ${agentA} and version = 1`) as { view: unknown }[])[0]!.view).toEqual(view);
    expect(started).toEqual([agentA]);
    expect(await call('POST', '/api/agents', 'tok-a', { name: 'Second', spec: minimalSpec() })).toMatchObject({ status: 409, body: { error: 'agent_exists' } });
    expect(await call('GET', `/api/agents/${agentA}`, 'tok-a')).toMatchObject({
      status: 200,
      body: { id: agentA, name: 'Scout', status: 'provisioning', stellarAddress: null, agentId: null, provision: { step: 'pending', attempts: [] } },
    });
  });

  it('tenant isolation: another user cannot read, retry or sign for the agent', async () => {
    expect(await call('GET', `/api/agents/${agentA}`, 'tok-b')).toMatchObject({ status: 404, body: { error: 'not_found' } });
    expect((await call('POST', `/api/agents/${agentA}/retry`, 'tok-b')).status).toBe(404);

    const entry = authEntry({ signer: walletC, fn: 'register_with_uri', args: [scv.addr(walletC), scv.str(`${PUBLIC}/a/${agentA}/agent.json`)] });
    const waiting = signRequests.request({ userId: A.id, agentId: agentA, kind: 'register', entryXdr: b64(entry), validUntilLedger: 5100, networkPassphrase: TESTNET.passphrase });
    let list = await call('GET', '/api/sign-requests', 'tok-a');
    for (let i = 0; i < 50 && list.body.length === 0; i++) {
      await Bun.sleep(10);
      list = await call('GET', '/api/sign-requests', 'tok-a');
    }
    expect(list.body).toHaveLength(1);
    expect(list.body[0]).toMatchObject({ kind: 'register', agentId: agentA, source: sponsor });
    expect((await call('GET', '/api/sign-requests', 'tok-b')).body).toEqual([]);
    const signed = b64(signEntry(entry, 5100));
    expect((await call('POST', `/api/sign-requests/${list.body[0].id}/sign`, 'tok-b', { signedEntryXdr: signed })).status).toBe(404);
    expect((await call('POST', `/api/sign-requests/${list.body[0].id}/reject`, 'tok-b')).status).toBe(404);
    expect((await call('POST', `/api/sign-requests/${list.body[0].id}/sign`, 'tok-a', { signedEntryXdr: signed })).status).toBe(204);
    expect(await waiting).toBe(signed);
  });

  it('retry from failed, and from a start stuck at pending or key_ready; never from creating or active', async () => {
    const h = createApp(deps); // its own retry budget
    const retry = () => callOn(h, 'POST', `/api/agents/${agentA}/retry`, 'tok-a');
    const setStep = (step: string) => sql`update app.agents set provision_state = ${{ step, attempts: [] }} where id = ${agentA}`;
    const before = started.length;
    // A run is (or may be) on chain: refused, nothing launched.
    await setStep('creating');
    expect(await retry()).toMatchObject({ status: 409, body: { error: 'not_failed' } });
    await setStep('active');
    expect(await retry()).toMatchObject({ status: 409, body: { error: 'not_failed' } });
    await sql`update app.agents set status = 'active' where id = ${agentA}`;
    await sql`update app.agents set provision_state = ${{ step: 'failed', attempts: [], error: 'owner_timeout' }} where id = ${agentA}`;
    expect(await retry()).toMatchObject({ status: 409, body: { error: 'not_failed' } });
    await sql`update app.agents set status = 'provisioning' where id = ${agentA}`;
    expect(started.length).toBe(before);
    // Nothing is on chain before `creating`: a first start that errored or a crash leaves these with an exit.
    await setStep('pending');
    expect((await retry()).status).toBe(202);
    await setStep('key_ready');
    expect((await retry()).status).toBe(202);
    await sql`update app.agents set provision_state = ${{ step: 'failed', attempts: [], error: 'owner_timeout' }} where id = ${agentA}`;
    expect((await retry()).status).toBe(202);
    expect(started.slice(before)).toEqual([agentA, agentA, agentA]);
  });

  it('provision outcomes reach the client: a deferral shows when to retry; operator cases say so', async () => {
    // Fresh app instances: each has its own retry budget (5/h per account, in memory in tests); outcomes are in the database.
    const one = createApp(deps);
    const at = async (h: typeof app) => (await callOn(h, 'GET', `/api/agents/${agentA}`, 'tok-a')).body;
    const retry = (h: typeof app) => callOn(h, 'POST', `/api/agents/${agentA}/retry`, 'tok-a');
    nextOutcome = { outcome: 'deferred', code: 'bind_window_open', retryAfterLedger: 5101 };
    expect((await retry(one)).status).toBe(202);
    await Bun.sleep(0);
    expect(await at(one)).toMatchObject({ lastStart: { outcome: 'deferred', code: 'bind_window_open', retryAfterLedger: 5101 }, needsOperator: false });

    // A registry that keeps answering "no such agent" (e.g. a testnet reset) is not transient lag.
    nextOutcome = { outcome: 'deferred', code: 'registry_no_agent' };
    for (let i = 0; i < 3; i++) {
      expect((await retry(one)).status).toBe(202);
      await Bun.sleep(0);
      expect((await at(one)).needsOperator).toBe(i === 2);
      if (i === 0) {
        // A retry that lands on a running start (busy) says nothing about the registry: the streak survives.
        nextOutcome = { outcome: 'busy' };
        expect((await retry(one)).status).toBe(202);
        await Bun.sleep(0);
        nextOutcome = { outcome: 'deferred', code: 'registry_no_agent' };
      }
    }

    // Any other definite answer resets the streak.
    const two = createApp(deps);
    for (const o of [{ code: 'registry_no_agent' }, { code: 'registry_no_agent' }, { code: 'registry_unreadable' }, { code: 'registry_no_agent' }] as const) {
      nextOutcome = { outcome: 'deferred', ...o };
      expect((await retry(two)).status).toBe(202);
      await Bun.sleep(0);
    }
    expect((await at(two)).needsOperator).toBe(false);

    // bound_foreign_owner is persisted: it needs an operator and is never retried from the API.
    const three = createApp(deps);
    await sql`update app.agents set provision_state = ${{ step: 'failed', attempts: [], error: 'bound_foreign_owner' }} where id = ${agentA}`;
    const before = started.length;
    expect(await retry(three)).toMatchObject({ status: 409, body: { error: 'needs_operator' } });
    expect(started.length).toBe(before);
    expect((await at(three)).needsOperator).toBe(true);
    await sql`update app.agents set provision_state = ${{ step: 'failed', attempts: [], error: 'owner_timeout' }} where id = ${agentA}`;
  });

  it('retry spend is capped: 5 launches per account per hour, then 429; refusals do not count', async () => {
    const h = createApp(deps);
    const retry = () => callOn(h, 'POST', `/api/agents/${agentA}/retry`, 'tok-a');
    await sql`update app.agents set provision_state = ${{ step: 'creating', attempts: [] }} where id = ${agentA}`;
    expect((await retry()).status).toBe(409); // not_failed: nothing launched, nothing counted
    await sql`update app.agents set provision_state = ${{ step: 'failed', attempts: [], error: 'owner_timeout' }} where id = ${agentA}`;
    const before = started.length;
    for (let i = 0; i < RETRY_LIMIT_PER_ACCOUNT; i++) expect((await retry()).status).toBe(202);
    const over = await retry();
    expect([over.status, over.body]).toEqual([429, { error: 'rate_limited' }]);
    expect(Number(over.headers.get('retry-after'))).toBeGreaterThan(0);
    expect(started.length - before).toBe(RETRY_LIMIT_PER_ACCOUNT);
  });

  it('retry spend is capped: MAX_ORPHANS abandoned keys (orphans) need an operator', async () => {
    const h = createApp(deps);
    await sql`delete from app.provision_starts`; // earlier tests left a no-agent streak (shared by replicas, so by apps too)
    const orphan = (n: number) => ({ publicKey: Keypair.random().publicKey(), attempt: n, txs: { account: String(n).repeat(64) } });
    await sql`update app.agents set provision_state = ${{ step: 'failed', attempts: [], error: 'chain_error', orphans: Array.from({ length: MAX_ORPHANS - 1 }, (_, i) => orphan(i + 1)) }} where id = ${agentA}`;
    expect((await callOn(h, 'GET', `/api/agents/${agentA}`, 'tok-a')).body.needsOperator).toBe(false);
    await sql`update app.agents set provision_state = ${{ step: 'failed', attempts: [], error: 'chain_error', orphans: Array.from({ length: MAX_ORPHANS }, (_, i) => orphan(i + 1)) }} where id = ${agentA}`;
    const before = started.length;
    expect(await callOn(h, 'POST', `/api/agents/${agentA}/retry`, 'tok-a')).toMatchObject({ status: 409, body: { error: 'needs_operator' } });
    expect(started.length).toBe(before);
    expect((await callOn(h, 'GET', `/api/agents/${agentA}`, 'tok-a')).body.needsOperator).toBe(true);
    await sql`update app.agents set provision_state = ${{ step: 'failed', attempts: [], error: 'owner_timeout' }} where id = ${agentA}`;
  });

  it('route ids are case-insensitive: an uppercase uuid reaches the same agent', async () => {
    expect(await call('GET', `/api/agents/${agentA.toUpperCase()}`, 'tok-a')).toMatchObject({ status: 200, body: { id: agentA } });
    expect((await app(new Request(`${PUBLIC}/a/${agentA.toUpperCase()}/agent.json`))).status).toBe(200);
  });

  it('agent.json: an internal error is still a public 500 (ACAO *)', async () => {
    const broken = createApp({ ...deps, sql: new Proxy(sql, { apply: () => Promise.reject(new Error('db down')) }) as Db });
    const res = await broken(new Request(`${PUBLIC}/a/${agentA}/agent.json`));
    expect(res.status).toBe(500);
    expect(res.headers.get('access-control-allow-origin')).toBe('*');
    expect(await res.json()).toEqual({ error: 'internal' });
  });

  it('agent.json is public, minimal, 404 for unknown agents, 410 for deleted ones', async () => {
    const doc = await app(new Request(`${PUBLIC}/a/${agentA}/agent.json`));
    expect(doc.status).toBe(200);
    expect(doc.headers.get('access-control-allow-origin')).toBe('*');
    expect(await doc.json()).toEqual({ name: 'Scout', description: '', services: [], agentId: null, agentWallet: null });
    expect((await app(new Request(`${PUBLIC}/a/${crypto.randomUUID()}/agent.json`))).status).toBe(404);
    expect((await app(new Request(`${PUBLIC}/a/not-a-uuid/agent.json`))).status).toBe(404);
    const revokedOwner = await insertUser(sql, { ownerAddress: contractAddress(11) });
    const revoked = await insertAgent(sql, revokedOwner, { name: 'Gone', status: 'revoked' });
    expect((await app(new Request(`${PUBLIC}/a/${revoked}/agent.json`))).status).toBe(410);
  });

  it('bodies: over 64 KB is 413, malformed JSON is 400; unknown routes are 404', async () => {
    expect((await call('POST', '/api/agents', 'tok-a', JSON.stringify({ name: 'x'.repeat(70_000) }))).status).toBe(413);
    // 64 KB counts bytes, not characters.
    expect((await call('POST', '/api/agents', 'tok-a', JSON.stringify({ name: 'é'.repeat(40_000) }))).status).toBe(413);
    expect(await call('POST', '/api/agents', 'tok-a', '{nope')).toMatchObject({ status: 400, body: { error: 'bad_json' } });
    expect((await call('GET', '/api/nothing', 'tok-a')).status).toBe(404);
  });

  it('an unhandled error is 500 internal, logged by event and path only', async () => {
    const events: Record<string, string | number>[] = [];
    const broken = createApp({ ...deps, signRequests: { ...signRequests, pending: async () => { throw new Error('db: secret detail'); } }, log: (e) => events.push(e) });
    expect(await callOn(broken, 'GET', '/api/sign-requests', 'tok-a')).toMatchObject({ status: 500, body: { error: 'internal' } });
    expect(events).toEqual([{ event: 'unhandled', path: '/api/sign-requests', errName: 'Error' }]);
  });

  it('an unhandled error logs its class name and a pattern-checked code (SQLSTATE), never the message or other fields', async () => {
    const events: Record<string, string | number>[] = [];
    const pgError = Object.assign(new Error('column "owner_secret" of relation "agents" does not exist (user a@example.com)'), { name: 'PostgresError', errno: '42703', detail: 'SABCDEF-secret' });
    const broken = createApp({ ...deps, signRequests: { ...signRequests, pending: async () => { throw pgError; } }, log: (e) => events.push(e) });
    expect((await callOn(broken, 'GET', '/api/sign-requests', 'tok-a')).status).toBe(500);
    expect(events).toEqual([{ event: 'unhandled', path: '/api/sign-requests', errName: 'PostgresError', errCode: '42703' }]);
    const text = JSON.stringify(events);
    for (const leak of ['owner_secret', 'a@example.com', 'SABCDEF', 'tok-a']) expect(text).not.toContain(leak);
  });

  it('agents: a banned word in the name is 400 bad_name with or without a view, and nothing is created', async () => {
    const before = started.length;
    expect(await call('POST', '/api/agents', 'tok-a', { name: 'My prompt bot', spec: minimalSpec() })).toMatchObject({ status: 400, body: { error: 'bad_name' } });
    const view = { sentence: ['I watch the market.'], params: [], bindings: [] };
    expect(await call('POST', '/api/agents', 'tok-a', { name: 'Soroban helper', spec: minimalSpec(), view })).toMatchObject({ status: 400, body: { error: 'bad_name' } });
    expect(started.length).toBe(before);
  });

  it('without a key (an older panel), one agent per user still: concurrent creates give one 202 and one 409; the 409 starts no provision', async () => {
    await sql`insert into app.users (id, email, owner_address) values (${C.id}, ${C.email}, ${contractAddress(8)})`;
    const before = started.length;
    const results = await Promise.all([call('POST', '/api/agents', 'tok-c', { name: 'One', spec: minimalSpec() }), call('POST', '/api/agents', 'tok-c', { name: 'Two', spec: minimalSpec() })]);
    expect(results.map((r) => r.status).sort()).toEqual([202, 409]);
    expect(results.find((r) => r.status === 409)!.body).toEqual({ error: 'agent_exists' });
    expect(started.length - before).toBe(1);
    const [n] = (await sql`select count(*)::int as n from app.agents where user_id = ${C.id}`) as { n: number }[];
    expect(n!.n).toBe(1);
    expect(await call('POST', '/api/agents', 'tok-c', { name: 'Three', spec: minimalSpec() })).toMatchObject({ status: 409, body: { error: 'agent_exists' } });
    expect(started.length - before).toBe(1);
  });

  describe('several agents per account (keyed creates)', () => {
    let n = 100;
    async function fresh(): Promise<{ token: string; id: string }> {
      const u = { id: crypto.randomUUID(), email: `${crypto.randomUUID()}@example.com` };
      const token = `tok-k:${u.id}`;
      users.set(token, u);
      await sql`insert into app.users (id, email, owner_address) values (${u.id}, ${u.email}, ${contractAddress(++n)})`;
      return { token, id: u.id };
    }
    const post = (h: typeof app, token: string, name: string, key: string) => callOn(h, 'POST', '/api/agents', token, { name, spec: minimalSpec(), key });

    it('each new key is a new agent up to the limit; then 409 agent_limit, with nothing written or started', async () => {
      const u = await fresh();
      const limited = createApp({ ...deps, agentLimits: { live: 2, perDay: 10 }, feeModel: 'sponsor' });
      const before = started.length;
      expect((await post(limited, u.token, 'One', crypto.randomUUID())).status).toBe(202);
      expect((await post(limited, u.token, 'Two', crypto.randomUUID())).status).toBe(202);
      expect(await post(limited, u.token, 'Three', crypto.randomUUID())).toMatchObject({ status: 409, body: { error: 'agent_limit' } });
      expect(started.length - before).toBe(2);
      const me = await callOn(limited, 'GET', '/api/me', u.token);
      expect(me.body.agents.map((x: { name: string }) => x.name)).toEqual(['One', 'Two']);
      expect(me.body.agent.name).toBe('One');
      expect(me.body.agentLimit).toBe(2);
    });

    it('a revoked agent frees its slot but still counts toward the day: 429 creation_limit', async () => {
      const u = await fresh();
      const limited = createApp({ ...deps, agentLimits: { live: 1, perDay: 2 } });
      const first = await post(limited, u.token, 'One', crypto.randomUUID());
      await sql`update app.agents set status = 'revoked' where id = ${first.body.id}`;
      expect((await post(limited, u.token, 'Two', crypto.randomUUID())).status).toBe(202);
      await sql`update app.agents set status = 'revoked' where user_id = ${u.id}`;
      expect(await post(limited, u.token, 'Three', crypto.randomUUID())).toMatchObject({ status: 429, body: { error: 'creation_limit' } });
    });

    it('the same key again is the same agent: 200 resumed, nothing new written or started (a lost answer asked again)', async () => {
      const u = await fresh();
      const key = crypto.randomUUID();
      const before = started.length;
      const one = await post(app, u.token, 'One', key);
      expect(one.status).toBe(202);
      expect(await post(app, u.token, 'One', key.toUpperCase())).toEqual(expect.objectContaining({ status: 200, body: { id: one.body.id, resumed: true } }));
      expect(started.length - before).toBe(1);
      const [c] = (await sql`select count(*)::int as n from app.agents where user_id = ${u.id}`) as { n: number }[];
      expect(c!.n).toBe(1);
    });

    it('concurrent creates are counted one after the other: exactly the limit is made', async () => {
      const u = await fresh();
      const limited = createApp({ ...deps, agentLimits: { live: 2, perDay: 10 }, feeModel: 'sponsor' });
      const results = await Promise.all(['A', 'B', 'C', 'D'].map((x) => post(limited, u.token, x, crypto.randomUUID())));
      expect(results.map((r) => r.status).sort()).toEqual([202, 202, 409, 409]);
      const same = crypto.randomUUID();
      const v = await fresh();
      const twice = await Promise.all([post(app, v.token, 'X', same), post(app, v.token, 'X', same)]);
      expect(twice.map((r) => r.status).sort()).toEqual([200, 202]);
      expect(new Set(twice.map((r) => r.body.id)).size).toBe(1);
    });

    it('a key that is not a uuid is 400 bad_key', async () => {
      const u = await fresh();
      expect(await post(app, u.token, 'One', 'nope')).toMatchObject({ status: 400, body: { error: 'bad_key' } });
    });

    it('a skill set is one of the owner\'s at a revision: malformed is 400 bad_skill_set, unknown 404, nothing started', async () => {
      const u = await fresh();
      const before = started.length;
      for (const skillSet of [{ id: 'nope', revision: 1 }, { id: crypto.randomUUID(), revision: 0 }, 'x']) {
        expect(await callOn(app, 'POST', '/api/agents', u.token, { name: 'One', spec: minimalSpec(), key: crypto.randomUUID(), skillSet })).toMatchObject({ status: 400, body: { error: 'bad_skill_set' } });
      }
      expect(await callOn(app, 'POST', '/api/agents', u.token, { name: 'One', spec: minimalSpec(), key: crypto.randomUUID(), skillSet: { id: crypto.randomUUID(), revision: 1 } })).toMatchObject({ status: 404, body: { error: 'set_not_found' } });
      expect(started.length).toBe(before);
    });
  });

  describe('creating from an approved description', () => {
    const cron = { kind: 'cron' as const, cron: '*/15 * * * *', mission: 'Report XLM.' };
    let nextWallet = 30;
    async function newUser(wallet = true): Promise<{ token: string; id: string }> {
      const u = { id: crypto.randomUUID(), email: `${crypto.randomUUID()}@example.com` };
      const token = `tok-n:${u.id}`;
      users.set(token, u);
      await sql`insert into app.users (id, email, owner_address) values (${u.id}, ${u.email}, ${wallet ? contractAddress(++nextWallet) : null})`;
      return { token, id: u.id };
    }
    const counts = async (userId: string) => {
      const [r] = (await sql`select (select count(*)::int from app.agents where user_id = ${userId}) as agents,
                                    (select count(*)::int from app.agent_specs s join app.agents a on a.id = s.agent_id where a.user_id = ${userId}) as specs`) as { agents: number; specs: number }[];
      return r!;
    };

    it('stores version 1 approved, sets active_spec_version and materializes triggers, while the agent is still provisioning', async () => {
      const u = await newUser();
      const res = await call('POST', '/api/agents', u.token, { name: 'Scout', spec: minimalSpec({ triggers: [cron] }) });
      expect(res.status).toBe(202);
      const id: string = res.body.id;
      const [a] = (await sql`select status, active_spec_version from app.agents where id = ${id}`) as { status: string; active_spec_version: number }[];
      expect([a!.status, a!.active_spec_version]).toEqual(['provisioning', 1]);
      const specs = (await sql`select version, status from app.agent_specs where agent_id = ${id}`) as { version: number; status: string }[];
      expect(specs).toEqual([{ version: 1, status: 'approved' }]);
      const trig = (await sql`select kind, spec_version, enabled from app.triggers where agent_id = ${id}`) as { kind: string; spec_version: number; enabled: boolean }[];
      expect(trig).toEqual([{ kind: 'cron', spec_version: 1, enabled: true }]);
    });

    it('an invalid or missing description is 400 bad_spec with a problem, and no agent row exists', async () => {
      const u = await newUser();
      const before = started.length;
      const bad = await call('POST', '/api/agents', u.token, { name: 'Scout', spec: { persona: 'p' } });
      expect(bad).toMatchObject({ status: 400, body: { error: 'bad_spec' } });
      expect(typeof bad.body.problem).toBe('string');
      // A client that still posts only a name gets the same clear answer.
      expect(await call('POST', '/api/agents', u.token, { name: 'Scout' })).toMatchObject({ status: 400, body: { error: 'bad_spec' } });
      expect(await call('POST', '/api/agents', u.token, { name: 'Scout', spec: 'nope' })).toMatchObject({ status: 400, body: { error: 'bad_spec' } });
      expect(await counts(u.id)).toEqual({ agents: 0, specs: 0 });
      expect(started.length).toBe(before);
    });

    it('a validation error does not echo the body or a secret value', async () => {
      const u = await newUser();
      const secret = 'sk-live-SECRET-VALUE-123';
      const res = await call('POST', '/api/agents', u.token, { name: 'Scout', spec: { persona: secret, system_prompt: 5, [secret]: secret } });
      expect(res.status).toBe(400);
      expect(JSON.stringify(res.body)).not.toContain('SECRET-VALUE');
      expect(JSON.stringify(res.body).length).toBeLessThan(300);
    });

    it('no wallet is 409 no_wallet and no spec is saved', async () => {
      const u = await newUser(false);
      expect(await call('POST', '/api/agents', u.token, { name: 'Scout', spec: minimalSpec() })).toMatchObject({ status: 409, body: { error: 'no_wallet' } });
      expect(await counts(u.id)).toEqual({ agents: 0, specs: 0 });
    });

    it('without a key, a second agent is still 409 agent_exists and writes nothing more', async () => {
      const u = await newUser();
      expect((await call('POST', '/api/agents', u.token, { name: 'One', spec: minimalSpec() })).status).toBe(202);
      const before = started.length;
      expect(await call('POST', '/api/agents', u.token, { name: 'Two', spec: minimalSpec() })).toMatchObject({ status: 409, body: { error: 'agent_exists' } });
      expect(await counts(u.id)).toEqual({ agents: 1, specs: 1 });
      expect(started.length).toBe(before);
    });

    it('provision starts only after the description is saved (the start sees the committed spec)', async () => {
      const u = await newUser();
      const seen: { specs: number; active: number | null }[] = [];
      const checking = createApp({
        ...deps,
        provisioner: {
          start: async (id) => {
            const [r] = (await sql`select (select count(*)::int from app.agent_specs where agent_id = ${id} and status = 'approved') as specs, active_spec_version as active from app.agents where id = ${id}`) as { specs: number; active: number | null }[];
            seen.push(r!);
            return { outcome: 'busy' };
          },
        },
      });
      expect((await callOn(checking, 'POST', '/api/agents', u.token, { name: 'Scout', spec: minimalSpec() })).status).toBe(202);
      for (let i = 0; i < 200 && seen.length === 0; i++) await Bun.sleep(10);
      expect(seen).toEqual([{ specs: 1, active: 1 }]);
    });

    it('a failure while saving the description rolls the agent back and starts nothing', async () => {
      const u = await newUser();
      const before = started.length;
      const failing = new Proxy(sql, {
        apply(target, thisArg, args: unknown[]) {
          if (/insert into app\.agent_specs/.test((args[0] as string[]).join('?'))) return Promise.reject(new Error('boom'));
          return Reflect.apply(target, thisArg, args);
        },
        get(target, prop, recv) {
          if (prop !== 'begin') return Reflect.get(target, prop, recv);
          return (fn: (tx: unknown) => Promise<unknown>) =>
            (target as unknown as { begin: (f: (tx: unknown) => Promise<unknown>) => Promise<unknown> }).begin((tx) =>
              fn(
                new Proxy(tx as object, {
                  apply(t, thisArg, args: unknown[]) {
                    if (/insert into app\.agent_specs/.test((args[0] as string[]).join('?'))) return Promise.reject(new Error('boom'));
                    return Reflect.apply(t as never, thisArg, args);
                  },
                }),
              ),
            );
        },
      }) as Db;
      const res = await callOn(createApp({ ...deps, sql: failing }), 'POST', '/api/agents', u.token, { name: 'Scout', spec: minimalSpec() });
      expect(res.status).toBe(500);
      expect(await counts(u.id)).toEqual({ agents: 0, specs: 0 });
      expect(started.length).toBe(before);
    });
  });
});
