import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import type { AuthVerifier } from '../src/account/auth.js';
import { createBuilder } from '../src/builder/index.js';
import { xlmDrop } from '../src/builder/examples.js';
import { createHandoffs } from '../src/builder/handoff.js';
import { createBuilderLimits } from '../src/builder/limits.js';
import { createTrial } from '../src/builder/trial.js';
import type { Db } from '../src/db/index.js';
import { createApp, type AppDeps } from '../src/gateway/app.js';
import { freshDb } from './support/db.js';
import { failingModel, scriptedModel } from './support/models.js';

const ORIGIN = 'https://app.agentenact.io';
const API = 'https://api.agentenact.io';
const good = () => JSON.stringify(xlmDrop());

describe('gateway builder routes (anonymous draft and edit)', () => {
  let sql: Db;
  let drop: () => Promise<void>;
  let base: Omit<AppDeps, 'builder'>;
  beforeAll(async () => {
    ({ sql, drop } = await freshDb());
    const verify: AuthVerifier = async (t) => (t.startsWith('tok:') ? { id: t.slice(4), email: `${t.slice(4)}@example.com` } : null);
    base = { sql, verify, passkey: {} as never, signRequests: {} as never, provisioner: {} as never, appOrigin: ORIGIN };
  });
  afterAll(() => drop());

  const U = { u1: crypto.randomUUID(), u2: crypto.randomUUID(), u3: crypto.randomUUID() };
  let n = 0;
  const freshIp = () => `203.0.113.${++n}`;
  const setup = (o: { anon?: ReturnType<typeof scriptedModel>; strong?: ReturnType<typeof scriptedModel>; killed?: boolean; trialAnon?: ReturnType<typeof scriptedModel>; trialRun?: ReturnType<typeof scriptedModel> } = {}) => {
    const anon = o.anon ?? scriptedModel([{ text: good() }]);
    const strong = o.strong ?? scriptedModel([{ text: good() }]);
    const limits = createBuilderLimits(sql);
    const trialAnon = o.trialAnon ?? scriptedModel([{ text: 'anon preview' }]);
    const trialRun = o.trialRun ?? scriptedModel([{ text: 'signed preview' }]);
    const tb = { trialTools: () => ({}), conditionFetch: async () => ({ symbol: 'XLM', network: 'mainnet', windowSeconds: 3600, from: { usd: '0.2000', at: '2026-10-13T10:00:00.000Z' }, to: { usd: '0.1820', at: '2026-10-13T11:00:00.000Z' }, changePct: -9 }) };
    const sandbox = async () => ({ ok: true as const, value: true });
    const app = createApp({
      ...base,
      builder: {
        builder: createBuilder({ models: { builder: strong, builderAnon: anon } }),
        trial: createTrial({ model: trialRun, toolbox: tb, sandbox }),
        trialAnon: createTrial({ model: trialAnon, toolbox: tb, sandbox }),
        limits,
        killed: o.killed ?? false,
      },
    });
    return { app, anon, strong, trialAnon, trialRun };
  };
  const post = (app: ReturnType<typeof setup>['app'], path: string, body: unknown, o: { ip?: string; user?: string; raw?: string } = {}) =>
    app(
      new Request(`${API}${path}`, {
        method: 'POST',
        headers: { origin: ORIGIN, 'content-type': 'application/json', ...(o.user ? { authorization: `Bearer tok:${o.user}` } : {}) },
        body: o.raw ?? JSON.stringify(body),
      }),
      o.ip ?? freshIp(),
    );
  const draft = (app: ReturnType<typeof setup>['app'], o: Parameters<typeof post>[3] = {}, body: unknown = { prompt: 'tell me when XLM drops' }) => post(app, '/api/builder/draft', body, o);
  const usage = async (scope: string) => ((await sql`select kind, n, tokens::int as tokens from app.builder_usage where scope = ${scope} order by kind`) as { kind: string; n: number; tokens: number }[]);

  it('anonymous draft returns a DraftResult, from the cheap model, with the app CORS', async () => {
    const { app, anon, strong } = setup();
    const r = await draft(app);
    expect([r.status, r.headers.get('access-control-allow-origin')]).toEqual([200, ORIGIN]);
    expect(await r.json()).toEqual({ draft: xlmDrop() });
    expect([anon.calls(), strong.calls()]).toEqual([1, 0]);
  });

  it('a signed-in draft uses the Builder model and is limited by user, not by IP', async () => {
    const { app, anon, strong } = setup();
    const ip = freshIp();
    for (let i = 0; i < 10; i++) expect((await draft(app, { ip, user: U.u1 })).status).toBe(200);
    expect([anon.calls(), strong.calls()]).toEqual([0, 10]);
    const r = await draft(app, { ip, user: U.u1 });
    expect([r.status, await r.json()]).toEqual([429, { error: 'daily_limit' }]);
    // The same IP is still fresh for an anonymous visitor, and another user is unaffected.
    expect((await draft(app, { ip })).status).toBe(200);
    expect((await draft(app, { ip, user: U.u2 })).status).toBe(200);
  });

  it('the 4th anonymous draft from one IP is 429 sign_in_to_keep_drafting', async () => {
    const { app } = setup();
    const ip = freshIp();
    for (let i = 0; i < 3; i++) expect((await draft(app, { ip })).status).toBe(200);
    const r = await draft(app, { ip });
    expect([r.status, await r.json(), r.headers.get('access-control-allow-origin')]).toEqual([429, { error: 'sign_in_to_keep_drafting' }, ORIGIN]);
  });

  it('a bad body is 400 and costs nothing', async () => {
    const { app, anon } = setup();
    const ip = freshIp();
    for (const body of [{}, { prompt: '' }, { prompt: '   ' }, { prompt: 5 }, { prompt: 'x'.repeat(2001) }, { prompt: 'ok', current: 'nope' }, { prompt: 'ok', current: { name: 'x' } }]) {
      const r = await draft(app, { ip }, body);
      expect([r.status, ((await r.json()) as { error: string }).error.startsWith('bad_')]).toEqual([400, true]);
    }
    expect((await draft(app, { ip, raw: '{not json' })).status).toBe(400);
    expect(anon.calls()).toBe(0);
    expect(await usage(`ip:${ip}`)).toEqual([]);
  });

  it('a bad bearer is 401, never an anonymous fallback', async () => {
    const { app, anon } = setup();
    const r = await app(new Request(`${API}/api/builder/draft`, { method: 'POST', headers: { authorization: 'Bearer bad' }, body: JSON.stringify({ prompt: 'x' }) }), freshIp());
    expect(r.status).toBe(401);
    expect(anon.calls()).toBe(0);
  });

  it('a revise request: current is model input only and is validated first', async () => {
    const { app, anon } = setup();
    const r = await draft(app, {}, { prompt: 'make it 10%', current: xlmDrop() });
    expect(r.status).toBe(200);
    expect(JSON.stringify(anon.doStreamCalls[0]!.prompt)).toContain('XLM buy-the-dip alert');
    // The answer is validated and scoped like any other: an out-of-scope answer is invalid (502), never returned.
    const bad = xlmDrop();
    bad.spec.hire_targets = [{ url: 'https://agent.example/a', max_usdc: '0.05' }];
    const m = scriptedModel([{ text: JSON.stringify(bad) }]);
    const { app: app2 } = setup({ anon: m });
    const r2 = await draft(app2, {}, { prompt: 'x', current: xlmDrop() });
    expect([r2.status, await r2.json()]).toEqual([502, { error: 'builder_failed', code: 'invalid' }]);
  });

  it('a model failure is 502 and the visitor is still charged one draft, plus tokens when reported', async () => {
    const { app } = setup({ anon: failingModel() as never });
    const ip = freshIp();
    const r = await draft(app, { ip });
    expect([r.status, await r.json()]).toEqual([502, { error: 'builder_failed', code: 'model_error' }]);
    expect((await usage(`ip:${ip}`))[0]).toMatchObject({ kind: 'draft', n: 1 });
  });

  it('every outcome is metered, an invalid answer included (tokens of both calls)', async () => {
    const { app } = setup({ anon: scriptedModel([{ text: 'nope' }, { text: 'still nope' }]) });
    const ip = freshIp();
    const r = await draft(app, { ip });
    expect([r.status, await r.json()]).toEqual([502, { error: 'builder_failed', code: 'invalid' }]);
    expect(await usage(`ip:${ip}`)).toEqual([{ kind: 'draft', n: 1, tokens: 2 * 1050 }]);
  });

  it('a success is metered on the visitor and the global bucket', async () => {
    const { app } = setup();
    const ip = freshIp();
    await draft(app, { ip });
    expect(await usage(`ip:${ip}`)).toEqual([{ kind: 'draft', n: 1, tokens: 1050 }]);
    expect((await usage('global'))[0]!.tokens).toBeGreaterThanOrEqual(1050);
  });

  it('a draft aborted by the client is neither a 502 nor an uncounted free call', async () => {
    const { app } = setup();
    const ip = freshIp();
    const ac = new AbortController();
    ac.abort();
    const r = await app(new Request(`${API}/api/builder/draft`, { method: 'POST', body: JSON.stringify({ prompt: 'x' }), signal: ac.signal }), ip);
    expect(r.status).toBe(499);
    expect((await usage(`ip:${ip}`))[0]).toMatchObject({ kind: 'draft', n: 1 }); // aborting repeatedly is not a way around the limit
  });

  it('killed is 503 for a draft and nothing is counted; an edit costs no model call and still works', async () => {
    const { app, anon } = setup({ killed: true });
    const ip = freshIp();
    expect((await draft(app, { ip })).status).toBe(503);
    expect(anon.calls()).toBe(0);
    expect(await usage(`ip:${ip}`)).toEqual([]);
    expect((await post(app, '/api/builder/edit', { draft: xlmDrop(), param: 'drop', value: 7 }, { ip })).status).toBe(200);
  });

  it('edit applies a param without any model call, and counts as an edit', async () => {
    const { app, anon, strong } = setup();
    const ip = freshIp();
    const r = await post(app, '/api/builder/edit', { draft: xlmDrop(), param: 'drop', value: 7 }, { ip });
    expect(r.status).toBe(200);
    const { draft: d } = (await r.json()) as { draft: ReturnType<typeof xlmDrop> };
    expect(d.params[0]!.value).toBe(7);
    expect(d.spec.triggers[0]).toMatchObject({ params: { drop_pct: 7 } });
    expect([anon.calls(), strong.calls()]).toEqual([0, 0]);
    expect(await usage(`ip:${ip}`)).toEqual([{ kind: 'edit', n: 1, tokens: 0 }]);
  });

  it('edit refuses an invalid value with 400 bad_edit and a problem', async () => {
    const { app } = setup();
    for (const [param, value] of [['drop', 9999], ['drop', 'x'], ['nope', 1]] as const) {
      const r = await post(app, '/api/builder/edit', { draft: xlmDrop(), param, value });
      const b = (await r.json()) as { error: string; problem: string };
      expect([r.status, b.error, typeof b.problem]).toEqual([400, 'bad_edit', 'string']);
    }
  });

  it('edit refuses a draft that is not valid or outside the Builder scope', async () => {
    const { app } = setup();
    const out = xlmDrop();
    out.spec.hire_targets = [{ url: 'https://agent.example/a', max_usdc: '0.05' }];
    for (const d of [{ name: 'x' }, 'str', out]) {
      const r = await post(app, '/api/builder/edit', { draft: d, param: 'drop', value: 7 });
      expect([r.status, ((await r.json()) as { error: string }).error]).toEqual([400, 'bad_edit']);
    }
    expect((await post(app, '/api/builder/edit', { draft: xlmDrop(), param: 5, value: 7 })).status).toBe(400);
  });

  it('the 21st anonymous edit from one IP is 429', async () => {
    const { app } = setup();
    const ip = freshIp();
    for (let i = 0; i < 20; i++) expect((await post(app, '/api/builder/edit', { draft: xlmDrop(), param: 'drop', value: 7 }, { ip })).status).toBe(200);
    const r = await post(app, '/api/builder/edit', { draft: xlmDrop(), param: 'drop', value: 7 }, { ip });
    expect([r.status, await r.json()]).toEqual([429, { error: 'sign_in_to_keep_drafting' }]);
  });

  it('a signed-in edit is not limited (it costs no model call)', async () => {
    const { app } = setup();
    const ip = freshIp();
    for (let i = 0; i < 25; i++) expect((await post(app, '/api/builder/edit', { draft: xlmDrop(), param: 'drop', value: 7 }, { ip, user: U.u3 })).status).toBe(200);
  });

  const trialReq = (app: ReturnType<typeof setup>['app'], o: Parameters<typeof post>[3] = {}, body: unknown = { spec: xlmDrop().spec }) => post(app, '/api/builder/trial', body, o);

  it('anonymous trial works once per IP on the cheap model, the second is 429 sign_in_to_keep_drafting', async () => {
    const { app, trialAnon, trialRun } = setup();
    const ip = freshIp();
    const r = await trialReq(app, { ip });
    expect([r.status, r.headers.get('access-control-allow-origin')]).toEqual([200, ORIGIN]);
    const { trial } = (await r.json()) as { trial: { status: string; text: string; condition: { held: boolean } } };
    expect([trial.status, trial.text, trial.condition.held]).toEqual(['done', 'anon preview', true]);
    expect([trialAnon.calls(), trialRun.calls()]).toEqual([1, 0]);
    const r2 = await trialReq(app, { ip });
    expect([r2.status, await r2.json()]).toEqual([429, { error: 'sign_in_to_keep_drafting' }]);
    expect(trialAnon.calls()).toBe(1);
    expect(await usage(`ip:${ip}`)).toEqual([{ kind: 'trial', n: 1, tokens: 1050 }]);
  });

  it('a signed-in user gets 10 trials on the normal run model, the 11th is daily_limit', async () => {
    const { app, trialAnon, trialRun } = setup();
    const user = crypto.randomUUID();
    for (let i = 0; i < 10; i++) expect((await trialReq(app, { user })).status).toBe(200);
    expect([trialAnon.calls(), trialRun.calls()]).toEqual([0, 10]);
    const r = await trialReq(app, { user });
    expect([r.status, await r.json()]).toEqual([429, { error: 'daily_limit' }]);
    expect(await usage(`user:${user}`)).toEqual([{ kind: 'trial', n: 10, tokens: 10 * 1050 }]);
  });

  it('a revoked or missing agent is irrelevant: the request carries no agent id', async () => {
    const { app } = setup();
    expect((await trialReq(app, { user: crypto.randomUUID() }, { spec: xlmDrop().spec, agentId: crypto.randomUUID() })).status).toBe(200);
  });

  it('a bad spec or one outside the Builder scope is 400 bad_spec and costs nothing', async () => {
    const { app, trialAnon } = setup();
    const ip = freshIp();
    const hire = xlmDrop().spec;
    hire.hire_targets = [{ url: 'https://agent.example/a', max_usdc: '0.05' }];
    const hook = xlmDrop().spec;
    hook.delivery.webhook_url = 'https://hooks.example.com/x';
    const noStale = xlmDrop().spec;
    (noStale.triggers[0] as { code: string }).code = 'return true;';
    for (const body of [{}, { spec: 'x' }, { spec: { persona: 'p' } }, { spec: hire }, { spec: hook }, { spec: noStale }]) {
      const r = await trialReq(app, { ip }, body);
      expect([r.status, ((await r.json()) as { error: string }).error]).toEqual([400, 'bad_spec']);
    }
    expect((await trialReq(app, { ip, raw: '{nope' })).status).toBe(400);
    expect(trialAnon.calls()).toBe(0);
    expect(await usage(`ip:${ip}`)).toEqual([]);
  });

  it('a failed trial is still metered; a client that left is 499 and still counted', async () => {
    const { app } = setup({ trialAnon: scriptedModel([{ text: 'x' }]) });
    const ip = freshIp();
    const ac = new AbortController();
    ac.abort();
    const r = await app(new Request(`${API}/api/builder/trial`, { method: 'POST', body: JSON.stringify({ spec: xlmDrop().spec }), signal: ac.signal }), ip);
    expect(r.status).toBe(499);
    expect((await usage(`ip:${ip}`))[0]).toMatchObject({ kind: 'trial', n: 1 });
  });

  it('a trial whose model fails is still metered', async () => {
    const { app } = setup({ trialAnon: failingModel() as never });
    const ip = freshIp();
    const r = await app(new Request(`${API}/api/builder/trial`, { method: 'POST', body: JSON.stringify({ spec: xlmDrop().spec }) }), ip);
    expect(r.status).toBe(200);
    expect(((await r.json()) as { trial: { status: string } }).trial.status).toBe('error');
    expect((await usage(`ip:${ip}`))[0]).toMatchObject({ kind: 'trial', n: 1 });
  });

  it('a bad bearer is 401 and killed is 503, with nothing counted', async () => {
    const { app, trialAnon } = setup({ killed: true });
    const ip = freshIp();
    expect((await trialReq(app, { ip })).status).toBe(503);
    const ok = setup();
    const r = await ok.app(new Request(`${API}/api/builder/trial`, { method: 'POST', headers: { authorization: 'Bearer bad' }, body: JSON.stringify({ spec: xlmDrop().spec }) }), freshIp());
    expect(r.status).toBe(401);
    expect([trialAnon.calls(), ok.trialAnon.calls()]).toEqual([0, 0]);
    expect(await usage(`ip:${ip}`)).toEqual([]);
  });

  it('is absent without deps: 404', async () => {
    const app = createApp(base);
    expect((await post(app, '/api/builder/draft', { prompt: 'x' })).status).toBe(404);
  });
});

describe('gateway builder routes (draft handoff)', () => {
  let sql: Db;
  let drop: () => Promise<void>;
  let app: ReturnType<typeof createApp>;
  beforeAll(async () => {
    ({ sql, drop } = await freshDb());
    const verify: AuthVerifier = async (t) => (t.startsWith('tok:') ? { id: t.slice(4), email: `${t.slice(4)}@example.com` } : null);
    const models = { builder: scriptedModel([]), builderAnon: scriptedModel([]) };
    app = createApp({
      sql,
      verify,
      passkey: {} as never,
      signRequests: {} as never,
      provisioner: {} as never,
      appOrigin: ORIGIN,
      builder: { builder: createBuilder({ models }), handoffs: createHandoffs(sql), limits: createBuilderLimits(sql), killed: false },
    });
  });
  afterAll(() => drop());

  let n = 0;
  const freshIp = () => `198.51.100.${++n}`;
  const put = (body: unknown, o: { ip?: string; raw?: string } = {}) =>
    app(new Request(`${API}/api/builder/handoff`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: o.raw ?? JSON.stringify(body) }), o.ip ?? freshIp());
  const claim = (id: string, user?: string) =>
    app(new Request(`${API}/api/builder/handoff/${id}/claim`, { method: 'POST', headers: user ? { authorization: `Bearer tok:${user}` } : {} }), freshIp());
  const stored = async () => Number(((await sql`select count(*)::int as n from app.draft_handoffs`) as { n: number }[])[0]!.n);
  const U1 = crypto.randomUUID();
  const U2 = crypto.randomUUID();

  it('a visitor parks a draft and a signed-in user claims it once; the second claim is 404', async () => {
    const r = await put({ draft: xlmDrop() });
    expect(r.status).toBe(200);
    const { id } = (await r.json()) as { id: string };
    expect(id).toMatch(/^[A-Za-z0-9_-]{22}$/);
    const c = await claim(id, U1);
    expect([c.status, c.headers.get('cache-control')]).toEqual([200, 'no-store']);
    expect(await c.json()).toEqual({ draft: xlmDrop() });
    expect((await claim(id, U1)).status).toBe(404);
  });

  it('claim needs a signed-in user (401), and a 401 does not spend the handoff', async () => {
    const { id } = (await (await put({ draft: xlmDrop() })).json()) as { id: string };
    expect((await claim(id)).status).toBe(401);
    expect((await claim(id, U1)).status).toBe(200);
  });

  it('any signed-in user holding the id can claim it, and a wrong or malformed id cannot', async () => {
    const { id } = (await (await put({ draft: xlmDrop() })).json()) as { id: string };
    expect((await claim('A'.repeat(22), U2)).status).toBe(404);
    expect((await claim('A'.repeat(21), U2)).status).toBe(404);
    expect((await claim(`${'A'.repeat(21)}.`, U2)).status).toBe(404);
    expect((await claim(id, U2)).status).toBe(200); // a different user than the one who would sign in: the id is the secret
  });

  it('email-bound: only the account with the parked email claims it; the claim body email is ignored; the row survives a wrong claim', async () => {
    const claimWith = (id: string, user: string, body: unknown) =>
      app(new Request(`${API}/api/builder/handoff/${id}/claim`, { method: 'POST', headers: { authorization: `Bearer tok:${user}`, 'content-type': 'application/json' }, body: JSON.stringify(body) }), freshIp());
    const u1 = crypto.randomUUID(); // verify() derives the email `<id>@example.com`
    const u2 = crypto.randomUUID();
    const { id } = (await (await put({ draft: xlmDrop(), email: `  ${u1.toUpperCase()}@Example.com ` })).json()) as { id: string };
    const rows = (await sql`select email_sha256 from app.draft_handoffs where id = ${id}`) as { email_sha256: string }[];
    expect(rows[0]!.email_sha256).toMatch(/^[0-9a-f]{64}$/);
    const wrong = await claimWith(id, u2, { email: `${u1}@example.com` });
    expect([wrong.status, await wrong.json()]).toEqual([404, { error: 'not_found' }]);
    expect((await claim(id)).status).toBe(401);
    const ok = await claim(id, u1);
    expect(ok.status).toBe(200);
    expect(await ok.json()).toEqual({ draft: xlmDrop() });
  });

  it('a handoff parked with an unusable email value is stored without a hash', async () => {
    for (const email of [42, '', '   ', null, { a: 1 }]) {
      const { id } = (await (await put({ draft: xlmDrop(), email })).json()) as { id: string };
      const rows = (await sql`select email_sha256 from app.draft_handoffs where id = ${id}`) as { email_sha256: string | null }[];
      expect(rows[0]!.email_sha256).toBeNull();
    }
  });

  it('an invalid draft is 400 and nothing is stored (shape, checks, scope, webhook, hire, service)', async () => {
    const before = await stored();
    const webhook = xlmDrop();
    webhook.spec.delivery.webhook_url = 'https://example.com/hook';
    const hire = xlmDrop();
    hire.spec.hire_targets = [{ url: 'https://agent.example/a', max_usdc: '0.05' }];
    const badBinding = xlmDrop();
    badBinding.bindings = [{ param: 'drop', path: '/nope' }];
    for (const body of [{}, { draft: null }, { draft: { name: 'x' } }, { draft: webhook }, { draft: hire }, { draft: badBinding }, { draft: { ...xlmDrop(), extra: 1 } }]) {
      const r = await put(body);
      expect([r.status, ((await r.json()) as { error: string }).error]).toEqual([400, 'bad_draft']);
    }
    expect((await put(null, { raw: '{not json' })).status).toBe(400);
    expect(await stored()).toBe(before);
  });

  it('the body cap is 64 KB in bytes, not characters', async () => {
    const before = await stored();
    // 25,000 three-byte characters: 25 K characters, 75 K bytes.
    const r = await put({ draft: xlmDrop(), pad: '€'.repeat(25_000) });
    expect(r.status).toBe(413);
    expect(await stored()).toBe(before);
  });

  it('the 11th handoff from one IP is 429 with the sign-in message; a refusal stores nothing', async () => {
    const ip = freshIp();
    for (let i = 0; i < 10; i++) expect((await put({ draft: xlmDrop() }, { ip })).status).toBe(200);
    const before = await stored();
    const r = await put({ draft: xlmDrop() }, { ip });
    expect([r.status, await r.json()]).toEqual([429, { error: 'sign_in_to_keep_drafting' }]);
    expect(await stored()).toBe(before);
    expect((await put({ draft: xlmDrop() })).status).toBe(200);
  });

  it('an unexpected failure on claim never logs the id', async () => {
    const logs: unknown[] = [];
    const id = 'AbCdEfGhIjKlMnOpQrStUv';
    const boom = createApp({ sql, verify: async (t) => ({ id: t, email: 'a@example.com' }), passkey: {} as never, signRequests: {} as never, provisioner: {} as never, appOrigin: ORIGIN, log: (e: unknown) => void logs.push(e), builder: { builder: createBuilder({ models: { builder: scriptedModel([]), builderAnon: scriptedModel([]) } }), handoffs: { put: async () => id, claim: async () => { throw new Error('db down'); } }, limits: createBuilderLimits(sql), killed: false } });
    const r = await boom(new Request(`${API}/api/builder/handoff/${id}/claim`, { method: 'POST', headers: { authorization: `Bearer ${U1}` } }), freshIp());
    expect(r.status).toBe(500);
    expect(JSON.stringify(logs)).not.toContain(id);
    expect(JSON.stringify(logs)).toContain('unhandled');
  });

  it('the 21st handoff from one signed-in user is 429 daily_limit, whatever the IP', async () => {
    const user = crypto.randomUUID();
    const withUser = (ip: string) => app(new Request(`${API}/api/builder/handoff`, { method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer tok:${user}` }, body: JSON.stringify({ draft: xlmDrop() }) }), ip);
    for (let i = 0; i < 20; i++) expect((await withUser(freshIp())).status).toBe(200);
    const before = await stored();
    const r = await withUser(freshIp());
    expect([r.status, await r.json()]).toEqual([429, { error: 'daily_limit' }]);
    expect(await stored()).toBe(before);
  });

  it('the routes answer 404 when handoffs are not configured', async () => {
    const off = createApp({ sql, verify: async () => null, passkey: {} as never, signRequests: {} as never, provisioner: {} as never, appOrigin: ORIGIN, builder: { builder: createBuilder({ models: { builder: scriptedModel([]), builderAnon: scriptedModel([]) } }), limits: createBuilderLimits(sql), killed: false } });
    const r = await off(new Request(`${API}/api/builder/handoff`, { method: 'POST', body: '{}' }), freshIp());
    expect(r.status).toBe(404);
  });
});
