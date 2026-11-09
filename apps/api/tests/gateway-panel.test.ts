import { createModelDirectory } from '../src/loop/model-choices.js';
import { afterAll, beforeAll, describe, expect, it, setDefaultTimeout } from 'bun:test';
import type { AuthVerifier } from '../src/account/auth.js';
import { createAgents } from '../src/agents/index.js';
import { bigUsdc, watchAccount, xlmDrop } from '../src/builder/examples.js';
import type { DraftResult } from '../src/builder/draft-schema.js';
import { createBuilder } from '../src/builder/index.js';
import { createBuilderLimits, USER_DRAFTS } from '../src/builder/limits.js';
import { createSuggest } from '../src/builder/suggest.js';
import { createChecks } from '../src/runs/checks.js';
import { applyParam } from '../src/builder/params.js';
import { createSpecs, type Specs } from '../src/specs/index.js';
import { parseSpec, type AgentSpec } from '../src/specs/schema.js';
import type { Db } from '../src/db/index.js';
import { createApp, type AppDeps } from '../src/gateway/app.js';
import { PANEL_WRITES_PER_HOUR } from '../src/gateway/panel-routes.js';
import { createActivity } from '../src/activity/index.js';
import { freshDb } from './support/db.js';
import { scriptedModel } from './support/models.js';
import { activeAgent } from './support/specs.js';

const ORIGIN = 'https://app.agentenact.io';
const API = 'https://api.agentenact.io';

describe('gateway panel routes: pause and resume', () => {
  let sql: Db;
  let drop: () => Promise<void>;
  let base: Omit<AppDeps, 'panel'>;
  beforeAll(async () => {
    ({ sql, drop } = await freshDb());
    const verify: AuthVerifier = async (t) => (t.startsWith('tok:') ? { id: t.slice(4), email: `${t.slice(4)}@example.com` } : null);
    base = { sql, verify, passkey: {} as never, signRequests: {} as never, provisioner: {} as never, appOrigin: ORIGIN };
  });
  afterAll(() => drop());

  const app = (now?: () => number) => createApp({ ...base, panel: { agents: createAgents(sql), activity: {} as never, ...(now ? { now } : {}) } });
  const call = (h: ReturnType<typeof app>, path: string, userId?: string) =>
    h(new Request(`${API}${path}`, { method: 'POST', headers: { origin: ORIGIN, ...(userId ? { authorization: `Bearer tok:${userId}` } : {}) } }));
  const status = async (id: string) => ((await sql`select status from app.agents where id = ${id}`) as { status: string }[])[0]!.status;

  it('pause and resume return 204, are owner-only, and carry the app CORS', async () => {
    const a = await activeAgent(sql);
    const b = await activeAgent(sql);
    const h = app();
    const paused = await call(h, `/api/agents/${a.agentId}/pause`, a.userId);
    expect([paused.status, paused.headers.get('access-control-allow-origin')]).toEqual([204, ORIGIN]);
    expect(await status(a.agentId)).toBe('paused');
    expect((await call(h, `/api/agents/${a.agentId}/resume`, b.userId)).status).toBe(404); // not their agent
    expect((await call(h, `/api/agents/${a.agentId}/pause`)).status).toBe(401);
    expect(await status(a.agentId)).toBe('paused');
    const resumed = await call(h, `/api/agents/${a.agentId}/resume`, a.userId);
    expect([resumed.status, resumed.headers.get('access-control-allow-origin')]).toEqual([204, ORIGIN]);
    expect(await status(a.agentId)).toBe('active');
  });

  it('DELETE deletes the owner\'s agent (202), hands it to the closer, and is owner-only', async () => {
    const a = await activeAgent(sql);
    const b = await activeAgent(sql);
    const closed: string[] = [];
    const h = createApp({ ...base, panel: { agents: createAgents(sql), closer: { close: async (id) => void closed.push(id) }, activity: {} as never } });
    const del = (userId?: string) =>
      h(new Request(`${API}/api/agents/${a.agentId}`, { method: 'DELETE', headers: { origin: ORIGIN, ...(userId ? { authorization: `Bearer tok:${userId}` } : {}) } }));
    expect((await del()).status).toBe(401);
    expect((await del(b.userId)).status).toBe(404);
    expect(await status(a.agentId)).toBe('active');
    const r = await del(a.userId);
    expect([r.status, await r.json(), r.headers.get('access-control-allow-origin')]).toEqual([202, { deleted: true }, ORIGIN]);
    expect(await status(a.agentId)).toBe('revoked');
    expect(closed).toEqual([a.agentId]);
  });

  it('answers a wrong-state call with 409 and the code, and keeps the CORS on the error', async () => {
    const a = await activeAgent(sql);
    const h = app();
    const r = await call(h, `/api/agents/${a.agentId}/resume`, a.userId);
    expect([r.status, await r.json(), r.headers.get('access-control-allow-origin')]).toEqual([409, { error: 'not_paused' }, ORIGIN]);
    await call(h, `/api/agents/${a.agentId}/pause`, a.userId);
    expect(await (await call(h, `/api/agents/${a.agentId}/pause`, a.userId)).json()).toEqual({ error: 'not_active' });
  });

  it('allows the browser preflight for POST', async () => {
    const r = await app()(new Request(`${API}/api/agents/${crypto.randomUUID()}/pause`, { method: 'OPTIONS' }));
    expect([r.status, r.headers.get('access-control-allow-methods')]).toEqual([204, 'GET, POST, PUT, PATCH, DELETE']);
  });

  it('limits writes to 30 per hour per user, with retry-after, and counts both routes together', async () => {
    const a = await activeAgent(sql);
    let t = 0;
    const h = app(() => t);
    for (let i = 0; i < PANEL_WRITES_PER_HOUR; i++) await call(h, `/api/agents/${a.agentId}/${i % 2 === 0 ? 'pause' : 'resume'}`, a.userId);
    const r = await call(h, `/api/agents/${a.agentId}/pause`, a.userId);
    expect([r.status, r.headers.get('retry-after')]).toEqual([429, '3600']);
    t = 3_600_000;
    expect((await call(h, `/api/agents/${a.agentId}/pause`, a.userId)).status).toBe(204);
  });
});

describe('gateway panel routes: overview, activity, earnings', () => {
  let sql: Db;
  let drop: () => Promise<void>;
  let h: (r: Request) => Promise<Response>;
  const seen: (number | undefined)[] = [];
  beforeAll(async () => {
    ({ sql, drop } = await freshDb());
    const verify: AuthVerifier = async (t) => (t.startsWith('tok:') ? { id: t.slice(4), email: `${t.slice(4)}@example.com` } : null);
    const real = createActivity(sql, { publicBaseUrl: 'https://agentenact.io' });
    const activity = { ...real, feed: (u: string, a: string, o: { days?: number }) => (seen.push(o.days), real.feed(u, a, o)) };
    h = createApp({ sql, verify, passkey: {} as never, signRequests: {} as never, provisioner: {} as never, appOrigin: ORIGIN, panel: { agents: createAgents(sql), activity } });
  });
  afterAll(() => drop());
  const get = (path: string, userId?: string) => h(new Request(`${API}${path}`, { headers: { origin: ORIGIN, ...(userId ? { authorization: `Bearer tok:${userId}` } : {}) } }));

  it('the three routes are owner-only', async () => {
    const a = await activeAgent(sql);
    const b = await activeAgent(sql);
    for (const p of ['overview', 'activity', 'earnings']) {
      const path = `/api/agents/${a.agentId}/${p}`;
      expect((await get(path)).status).toBe(401);
      expect((await get(path, b.userId)).status).toBe(404);
      const ok = await get(path, a.userId);
      expect([ok.status, ok.headers.get('access-control-allow-origin')]).toEqual([200, ORIGIN]);
    }
    expect(await (await get(`/api/agents/${a.agentId}/overview`, a.userId)).json()).toMatchObject({ name: 'test agent', status: 'watching' });
    expect((await get(`/api/agents/${crypto.randomUUID()}/overview`, a.userId)).status).toBe(404);
  });

  it('days is clamped to 1-30 and defaults to 7', async () => {
    const a = await activeAgent(sql);
    seen.length = 0;
    for (const q of ['99', '0', '-4', 'abc', '']) await get(`/api/agents/${a.agentId}/activity${q === '' ? '' : `?days=${q}`}`, a.userId);
    await get(`/api/agents/${a.agentId}/activity?days=12`, a.userId);
    expect(seen).toEqual([30, 1, 1, 7, 7, 12]);
  });

  it('/api/me carries the non-revoked agent, or null', async () => {
    const a = await activeAgent(sql);
    expect((await (await get('/api/me', a.userId)).json()).agent).toEqual({ id: a.agentId, name: 'test agent', status: 'active' });
    await sql`update app.agents set status = 'revoked' where id = ${a.agentId}`;
    expect((await (await get('/api/me', a.userId)).json()).agent).toBeNull();
  });
});

describe('gateway panel routes: the morning note answer', () => {
  let sql: Db;
  let drop: () => Promise<void>;
  let base: Omit<AppDeps, 'panel'>;
  beforeAll(async () => {
    ({ sql, drop } = await freshDb());
    const verify: AuthVerifier = async (t) => (t.startsWith('tok:') ? { id: t.slice(4), email: `${t.slice(4)}@example.com` } : null);
    base = { sql, verify, passkey: {} as never, signRequests: {} as never, provisioner: {} as never, appOrigin: ORIGIN };
  });
  afterAll(() => drop());
  const h = () => createApp({ ...base, panel: { agents: createAgents(sql), activity: createActivity(sql, { publicBaseUrl: 'https://agentenact.io' }) } });
  const post = (id: string, userId: string | undefined, body: unknown) =>
    h()(new Request(`${API}/api/agents/${id}/morning-note`, { method: 'POST', headers: { 'content-type': 'application/json', ...(userId ? { authorization: `Bearer tok:${userId}` } : {}) }, body: JSON.stringify(body) }));

  it('stores the answer (204), shows it on the overview, and is owner-only', async () => {
    const a = await activeAgent(sql);
    const b = await activeAgent(sql);
    expect((await post(a.agentId, a.userId, { on: true })).status).toBe(204);
    const ov = await h()(new Request(`${API}/api/agents/${a.agentId}/overview`, { headers: { authorization: `Bearer tok:${a.userId}` } }));
    expect(((await ov.json()) as { morningNote: boolean }).morningNote).toBe(true);
    expect((await post(a.agentId, b.userId, { on: false })).status).toBe(404);
    expect((await post(a.agentId, undefined, { on: false })).status).toBe(401);
  });

  it('refuses anything but a yes or a no', async () => {
    const a = await activeAgent(sql);
    for (const body of [{}, { on: 'yes' }, { on: null }, [], 'x']) expect((await post(a.agentId, a.userId, body)).status).toBe(400);
  });
});

describe('gateway panel routes: a new prompt revises the description (Task 18)', () => {
  setDefaultTimeout(30_000); // each case is several round trips to the test database
  let sql: Db;
  let drop: () => Promise<void>;
  let specs: Specs;
  beforeAll(async () => {
    ({ sql, drop } = await freshDb());
    specs = createSpecs(sql);
  });
  afterAll(() => drop());

  const verify: AuthVerifier = async (t) => (t.startsWith('tok:') ? { id: t.slice(4), email: `${t.slice(4)}@example.com` } : null);
  const SECRETS = { slug: 'owner-quote-svc', hire: 'https://hired.example/agent', hook: 'https://hooks.example/owner-hook', skill: 'owner-skill-body-unique', plan: 'owner plan step unique' };
  const owned = (): AgentSpec => {
    const base = xlmDrop().spec;
    return specOf(parseSpec({
      ...base,
      tools: [...base.tools, 'send_webhook', 'hire_agent'],
      services: [{ slug: SECRETS.slug, description: 'a quote', price_usdc: '0.01', input_schema: { type: 'object', properties: { q: { type: 'string' } }, required: ['q'] }, output_schema: { type: 'object', properties: { a: { type: 'string' } } }, persona: 'quoter', skill_body: '', tools: ['web_read'] }],
      hire_targets: [{ url: SECRETS.hire, max_usdc: '0.05' }],
      skills: [{ name: 'owner-skill', description: 'a skill', body: SECRETS.skill }],
      suggested_plan: [SECRETS.plan],
      delivery: { email: true, webhook_url: SECRETS.hook },
    }));
  };
  const viewOf = (d: DraftResult) => {
    const { name: _n, spec: _s, ...v } = d;
    return v;
  };
  const specOf = (p: ReturnType<typeof parseSpec>) => (p as { spec: AgentSpec }).spec;

  /** An agent with the owner's description approved as version 1. */
  async function agentWith(spec: AgentSpec, view: ReturnType<typeof viewOf> | null = viewOf(xlmDrop())) {
    const a = await activeAgent(sql);
    const v = await specs.saveDraft(a.userId, a.agentId, spec, undefined, view ?? undefined);
    await specs.approve(a.userId, a.agentId, v);
    return a;
  }
  const setup = (o: { strong?: ReturnType<typeof scriptedModel>; killed?: boolean } = {}) => {
    const strong = o.strong ?? scriptedModel([{ text: JSON.stringify(revised()) }]);
    const anon = scriptedModel([{ text: 'never' }]);
    const app = createApp({
      sql,
      verify,
      passkey: {} as never,
      signRequests: {} as never,
      provisioner: {} as never,
      appOrigin: ORIGIN,
      panel: {
        agents: createAgents(sql),
        activity: {} as never,
        revise: { builder: createBuilder({ models: { builder: strong, builderAnon: anon } }), limits: createBuilderLimits(sql), specs, killed: o.killed ?? false },
      },
    });
    return { app, strong, anon };
  };
  /** The model's answer: the same draft with the threshold moved to 7 (it never writes the owner's fields). */
  const revised = () => {
    const r = applyParam(xlmDrop(), 'drop', 7);
    if (!r.ok) throw new Error(r.problem);
    return r.draft;
  };
  const revise = (app: ReturnType<typeof setup>['app'], agentId: string, userId: string | undefined, body: unknown = { prompt: 'make it 7 percent' }) =>
    app(
      new Request(`${API}/api/agents/${agentId}/builder/draft`, {
        method: 'POST',
        headers: { origin: ORIGIN, 'content-type': 'application/json', ...(userId ? { authorization: `Bearer tok:${userId}` } : {}) },
        body: JSON.stringify(body),
      }),
      '203.0.113.9',
    );
  const versions = async (agentId: string) =>
    (await sql`select version, status, view is not null as has_view from app.agent_specs where agent_id = ${agentId} order by version`) as { version: number; status: string; has_view: boolean }[];
  const promptText = (m: ReturnType<typeof scriptedModel>) => JSON.stringify(m.doStreamCalls.map((c) => c.prompt));

  it('saves version N+1 as a draft with its view; the active version stays until approve', async () => {
    const a = await agentWith(owned());
    const { app, strong, anon } = setup();
    const r = await revise(app, a.agentId, a.userId);
    expect([r.status, r.headers.get('access-control-allow-origin')]).toEqual([200, ORIGIN]);
    const body = (await r.json()) as { version: number; createdAt: string; draft: DraftResult };
    expect(body.version).toBe(2);
    expect(body.draft.params[0]).toMatchObject({ id: 'drop', value: 7 });
    expect([strong.calls(), anon.calls()]).toEqual([1, 0]); // signed in: the Builder's own model
    expect(await versions(a.agentId)).toEqual([{ version: 1, status: 'approved', has_view: true }, { version: 2, status: 'draft', has_view: true }]);
    const shown = await specs.view(a.userId, a.agentId);
    expect(new Date(body.createdAt).getTime()).toBe(shown.draft!.createdAt.getTime()); // identifies this draft, for approve
    expect(shown.active!.version).toBe(1);
    expect(shown.active!.spec.triggers[0]).toMatchObject({ params: { drop_pct: 5 } });
    expect(shown.draft!.view).toEqual(viewOf(revised()));
    expect(shown.draft!.spec.triggers[0]).toMatchObject({ params: { drop_pct: 7 } });
    await specs.approve(a.userId, a.agentId, 2);
    expect((await specs.view(a.userId, a.agentId)).active!.spec.triggers[0]).toMatchObject({ params: { drop_pct: 7 } });
  });

  it('the model receives the stored active description as current, and nothing the owner added', async () => {
    const a = await agentWith(owned());
    const { app, strong } = setup();
    await revise(app, a.agentId, a.userId, { prompt: 'make it 7 percent', current: { name: 'spoof', spec: 'client says so' } }); // client input is ignored
    const sent = promptText(strong);
    expect(sent).toContain('drop_pct'); // the stored description
    expect(sent).toContain('A calm Stellar watcher.');
    expect(sent).not.toContain('spoof');
    for (const held of [SECRETS.slug, SECRETS.hire, SECRETS.hook, SECRETS.skill, SECRETS.plan, 'send_webhook', 'hire_agent']) expect(sent).not.toContain(held);
    const user = (strong.doStreamCalls[0]!.prompt as { role: string; content: { text: string }[] }[]).find((m) => m.role === 'user')!.content[0]!.text;
    const current = JSON.parse(user.split('The current draft:\n')[1]!.split('\n\nAnswer')[0]!);
    expect(current.spec).toMatchObject({ services: [], hire_targets: [], skills: [], suggested_plan: [], tools: ['send_email'], delivery: { email: true } });
    expect('webhook_url' in current.spec.delivery).toBe(false);
  });

  it('the saved draft carries the owner-added fields unchanged, copied back from the stored version', async () => {
    const stored = owned();
    const a = await agentWith(stored);
    const { app } = setup();
    const r = await revise(app, a.agentId, a.userId);
    const body = (await r.json()) as { version: number; draft: DraftResult };
    const saved = (await specs.view(a.userId, a.agentId)).draft!.spec;
    for (const s of [saved, body.draft.spec]) {
      expect(s.services).toEqual(stored.services);
      expect(s.hire_targets).toEqual(stored.hire_targets);
      expect(s.skills).toEqual(stored.skills);
      expect(s.suggested_plan).toEqual(stored.suggested_plan);
      expect(s.delivery).toEqual(stored.delivery);
      expect(s.tools.sort()).toEqual([...stored.tools].sort());
    }
  });

  it('a model answer that adds its own services is still refused by scope, and nothing is saved', async () => {
    const a = await agentWith(owned());
    const bad = revised();
    bad.spec.services = specOf(parseSpec({ ...bad.spec, services: owned().services })).services;
    const strong = scriptedModel([{ text: JSON.stringify(bad) }]);
    const { app } = setup({ strong });
    const r = await revise(app, a.agentId, a.userId);
    expect([r.status, await r.json()]).toEqual([502, { error: 'builder_failed', code: 'invalid' }]);
    expect(strong.calls()).toBe(2); // the first answer and one repair
    expect(promptText(strong)).toContain('services must be empty');
    expect(await versions(a.agentId)).toEqual([{ version: 1, status: 'approved', has_view: true }]);
  });

  it('a stored version saved without a view gets a minimal one-sentence view', async () => {
    const a = await agentWith(owned(), null);
    const { app, strong } = setup();
    expect((await revise(app, a.agentId, a.userId)).status).toBe(200);
    expect(promptText(strong)).toContain('test agent'); // the sentence is the agent's name
  });

  it('a new prompt never creates a second agent', async () => {
    const a = await agentWith(owned());
    const { app } = setup();
    await revise(app, a.agentId, a.userId);
    expect(((await sql`select count(*)::int as n from app.agents where user_id = ${a.userId}`) as { n: number }[])[0]!.n).toBe(1);
  });

  it('10 revisions a day, the 11th is daily_limit and calls no model', async () => {
    const a = await agentWith(owned());
    const strong = scriptedModel([{ text: JSON.stringify(revised()) }]);
    const { app } = setup({ strong });
    for (let i = 0; i < USER_DRAFTS; i++) expect((await revise(app, a.agentId, a.userId)).status).toBe(200);
    const r = await revise(app, a.agentId, a.userId);
    expect([r.status, await r.json()]).toEqual([429, { error: 'daily_limit' }]);
    expect(strong.calls()).toBe(USER_DRAFTS);
    const used = (await sql`select n, tokens::int as tokens from app.builder_usage where scope = ${`user:${a.userId}`} and kind = 'draft'`) as { n: number; tokens: number }[];
    expect(used[0]!.n).toBe(USER_DRAFTS);
    expect(used[0]!.tokens).toBeGreaterThan(0);
  });

  it('meters a failed revision and answers 502', async () => {
    const a = await agentWith(owned());
    const { app } = setup({ strong: scriptedModel([{ text: 'not json' }]) });
    const r = await revise(app, a.agentId, a.userId);
    expect([r.status, (await r.json()).error]).toEqual([502, 'builder_failed']);
    const used = (await sql`select n, tokens::int as tokens from app.builder_usage where scope = ${`user:${a.userId}`} and kind = 'draft'`) as { n: number; tokens: number }[];
    expect(used[0]!.n).toBe(1);
    expect(used[0]!.tokens).toBeGreaterThan(0);
  });

  it('another user\'s agent is 404, no bearer is 401, a bad prompt is 400, a killed Builder is 503; none calls a model or counts', async () => {
    const a = await agentWith(owned());
    const b = await activeAgent(sql);
    const { app, strong } = setup();
    expect((await revise(app, a.agentId, b.userId)).status).toBe(404);
    expect((await revise(app, a.agentId, undefined)).status).toBe(401);
    expect((await revise(app, a.agentId, a.userId, { prompt: '   ' })).status).toBe(400);
    expect((await revise(app, a.agentId, a.userId, { prompt: 'x'.repeat(2001) })).status).toBe(400);
    expect((await revise(setup({ killed: true }).app, a.agentId, a.userId)).status).toBe(503);
    expect(strong.calls()).toBe(0);
    expect(((await sql`select count(*)::int as n from app.builder_usage where scope = ${`user:${a.userId}`}`) as { n: number }[])[0]!.n).toBe(0);
  });

  it('409 agent_not_active unless the agent is active or paused; a paused agent may revise', async () => {
    const { app } = setup();
    const a = await agentWith(owned());
    await sql`update app.agents set status = 'paused' where id = ${a.agentId}`;
    expect((await revise(app, a.agentId, a.userId)).status).toBe(200);
    for (const status of ['provisioning', 'revoked']) {
      await sql`update app.agents set status = ${status} where id = ${a.agentId}`;
      const r = await revise(app, a.agentId, a.userId);
      expect([r.status, await r.json()]).toEqual([409, { error: 'agent_not_active' }]);
    }
  });

  it('after approve, the cooldown of an unchanged trigger is kept', async () => {
    const a = await agentWith(owned());
    await sql`update app.triggers set last_fired_at = '2026-10-05T09:00:00Z' where agent_id = ${a.agentId}`;
    const sameTrigger = revised();
    sameTrigger.spec.triggers = xlmDrop().spec.triggers;
    sameTrigger.params = xlmDrop().params;
    sameTrigger.bindings = xlmDrop().bindings;
    sameTrigger.sentence = xlmDrop().sentence;
    sameTrigger.spec.persona = 'A calmer Stellar watcher.';
    const { app } = setup({ strong: scriptedModel([{ text: JSON.stringify(sameTrigger) }]) });
    const r = await revise(app, a.agentId, a.userId);
    const { version } = (await r.json()) as { version: number };
    await specs.approve(a.userId, a.agentId, version);
    const t = (await sql`select last_fired_at from app.triggers where agent_id = ${a.agentId}`) as { last_fired_at: Date | null }[];
    expect(t.map((x) => x.last_fired_at)).toEqual([new Date('2026-10-05T09:00:00Z')]);
  });

  it('empty params from the model are omitted: the trigger key and its cooldown are unchanged', async () => {
    const a = await agentWith(watchAccount().spec, viewOf(watchAccount()));
    await sql`update app.triggers set last_fired_at = '2026-10-05T09:00:00Z' where agent_id = ${a.agentId}`;
    const answer = JSON.parse(JSON.stringify(watchAccount()));
    answer.spec.triggers[0].params = {};
    answer.spec.persona = 'A calmer Stellar watcher.';
    const { app } = setup({ strong: scriptedModel([{ text: JSON.stringify(answer) }]) });
    const r = await revise(app, a.agentId, a.userId);
    expect(r.status).toBe(200);
    const { version } = (await r.json()) as { version: number };
    expect('params' in (await specs.view(a.userId, a.agentId)).draft!.spec.triggers[0]!).toBe(false);
    await specs.approve(a.userId, a.agentId, version);
    const t = (await sql`select last_fired_at, condition from app.triggers where agent_id = ${a.agentId}`) as { last_fired_at: Date | null; condition: Record<string, unknown> }[];
    expect(t[0]!.last_fired_at).toEqual(new Date('2026-10-05T09:00:00Z'));
    expect('params' in t[0]!.condition).toBe(false);
  });
  it('a publish while the model runs makes the revise 409 version_changed: nothing saved, the new live version untouched, the call still metered', async () => {
    const a = await agentWith(owned());
    const real = createBuilder({ models: { builder: scriptedModel([{ text: JSON.stringify(revised()) }]), builderAnon: scriptedModel([{ text: 'never' }]) } });
    // The owner's other tab publishes version 2 (a new paid service) while this tab's model call is in flight.
    const publishing: Pick<typeof real, 'draft'> = {
      draft: async (args) => {
        const v2 = await specs.saveDraft(a.userId, a.agentId, specOf(parseSpec({ ...owned(), services: [{ ...owned().services[0]!, slug: 'published-meanwhile' }] })));
        await specs.approve(a.userId, a.agentId, v2);
        return real.draft(args);
      },
    };
    const app = createApp({
      sql, verify, passkey: {} as never, signRequests: {} as never, provisioner: {} as never, appOrigin: ORIGIN,
      panel: { agents: createAgents(sql), activity: {} as never, revise: { builder: publishing, limits: createBuilderLimits(sql), specs, killed: false } },
    });
    const r = await revise(app, a.agentId, a.userId);
    expect([r.status, await r.json()]).toEqual([409, { error: 'version_changed' }]);
    expect(await versions(a.agentId)).toEqual([{ version: 1, status: 'approved', has_view: true }, { version: 2, status: 'approved', has_view: false }]);
    expect((await specs.view(a.userId, a.agentId)).active!.version).toBe(2);
    expect((await specs.liveServices(a.agentId)).map((x) => x.slug)).toEqual(['published-meanwhile']);
    const used = (await sql`select n, tokens::int as tokens from app.builder_usage where scope = ${`user:${a.userId}`} and kind = 'draft'`) as { n: number; tokens: number }[];
    expect([used[0]!.n, used[0]!.tokens > 0]).toEqual([1, true]);
  });

  it('a stale draft (built before a publish) can no longer be approved over the newer live version', async () => {
    const a = await agentWith(owned());
    const { app } = setup();
    const { version: stale } = (await (await revise(app, a.agentId, a.userId)).json()) as { version: number };
    const newer = await specs.saveDraft(a.userId, a.agentId, owned());
    await specs.approve(a.userId, a.agentId, newer);
    expect(newer).toBeGreaterThan(stale);
    await expect(specs.approve(a.userId, a.agentId, stale)).rejects.toMatchObject({ status: 409, code: 'version_changed' });
    expect((await specs.view(a.userId, a.agentId)).active!.version).toBe(newer);
  });

  it("the response shows the name the agent keeps, not the model's", async () => {
    const a = await agentWith(owned());
    const renamed = revised();
    renamed.name = 'Model Picked Name';
    const { app } = setup({ strong: scriptedModel([{ text: JSON.stringify(renamed) }]) });
    const body = (await (await revise(app, a.agentId, a.userId)).json()) as { draft: DraftResult };
    expect(body.draft.name).toBe('test agent');
  });

  it('the global signed-in ceiling answers 429 capacity_reached (not daily_limit), calls no model and counts nobody', async () => {
    const a = await agentWith(owned());
    const day = new Date().toISOString().slice(0, 10);
    await sql`insert into app.builder_usage (scope, day, kind, n) values ('global:user', ${day}::date, 'draft', 500)
              on conflict (scope, day, kind) do update set n = 500`;
    const { app, strong } = setup();
    const r = await revise(app, a.agentId, a.userId);
    expect([r.status, await r.json()]).toEqual([429, { error: 'capacity_reached' }]);
    expect(strong.calls()).toBe(0);
    await sql`delete from app.builder_usage where scope = 'global:user'`;
  });
});

describe('gateway panel routes: the selling suggestion (Task 19)', () => {
  setDefaultTimeout(60_000);
  let sql: Db;
  let drop: () => Promise<void>;
  let specs: Specs;
  beforeAll(async () => {
    ({ sql, drop } = await freshDb());
    specs = createSpecs(sql);
  });
  afterAll(() => drop());

  const verify: AuthVerifier = async (t) => (t.startsWith('tok:') ? { id: t.slice(4), email: `${t.slice(4)}@example.com` } : null);
  const proposal = JSON.stringify({
    label: 'Sell my XLM price checks to other agents',
    slug: 'xlm-check',
    description: 'Tells another agent whether XLM fell recently.',
    price_usdc: '0.5',
    input_schema: { type: 'object', properties: {}, required: [] },
    output_schema: { type: 'object', properties: { fell: { type: 'boolean' } }, required: ['fell'] },
    tools: ['stellar_price_change'],
  });
  const setup = (o: { killed?: boolean } = {}) => {
    const model = scriptedModel([{ text: proposal }, { text: proposal }]);
    const app = createApp({
      sql,
      verify,
      passkey: {} as never,
      signRequests: {} as never,
      provisioner: {} as never,
      appOrigin: ORIGIN,
      services: { endpoint: { handle: async () => new Response(null, { status: 500 }), resourceUrl: (id: string, slug: string) => `${API}/a/${id}/s/${slug}` }, specs },
      panel: { agents: createAgents(sql), activity: {} as never, suggest: { suggest: createSuggest({ sql, specs, checks: createChecks(sql), model, limits: createBuilderLimits(sql) }), killed: o.killed ?? false } },
    });
    return { app, model };
  };
  const call = (app: ReturnType<typeof setup>['app'], method: string, path: string, userId?: string, body?: unknown) =>
    app(
      new Request(`${API}${path}`, {
        method,
        headers: { origin: ORIGIN, ...(userId ? { authorization: `Bearer tok:${userId}` } : {}), ...(body === undefined ? {} : { 'content-type': 'application/json' }) },
        body: body === undefined ? undefined : JSON.stringify(body),
      }),
      '203.0.113.9',
    );
  async function agent(days = 3) {
    const a = await activeAgent(sql);
    const v = await specs.saveDraft(a.userId, a.agentId, specOf(parseSpec(xlmDrop().spec)));
    await specs.approve(a.userId, a.agentId, v);
    for (let i = 0; i < days; i++) await sql`insert into app.check_days (agent_id, day, quiet) values (${a.agentId}, (now() at time zone 'utc')::date - ${i}::int, 3)`;
    return a;
  }
  const specOf = (p: ReturnType<typeof parseSpec>) => (p as { spec: AgentSpec }).spec;

  it('GET shows the card once eligible; not before; publish is 204, the service is live in agent.json, a second publish is 409', async () => {
    const { app, model } = setup();
    const few = await agent(2);
    const none = await call(app, 'GET', `/api/agents/${few.agentId}/suggestion`, few.userId);
    expect([none.status, await none.json(), model.calls()]).toEqual([200, { eligible: false }, 0]);

    const a = await agent();
    const r = await call(app, 'GET', `/api/agents/${a.agentId}/suggestion`, a.userId);
    expect([r.status, r.headers.get('access-control-allow-origin')]).toEqual([200, ORIGIN]);
    expect(await r.json()).toMatchObject({ eligible: true, suggestion: { version: 1, label: 'Sell my XLM price checks to other agents', service: { slug: 'xlm-check', price_usdc: '0.05', tools: ['stellar_price_change'] } } });

    const p = await call(app, 'POST', `/api/agents/${a.agentId}/suggestion/publish`, a.userId, { version: 1 });
    expect(p.status).toBe(204);
    const card = await (await app(new Request(`${API}/a/${a.agentId}/agent.json`))).json();
    expect(card).toMatchObject({ services: [{ slug: 'xlm-check', price_usdc: '0.05', url: `${API}/a/${a.agentId}/s/xlm-check` }] });

    const again = await call(app, 'POST', `/api/agents/${a.agentId}/suggestion/publish`, a.userId, { version: 1 });
    expect([again.status, await again.json(), again.headers.get('access-control-allow-origin')]).toEqual([409, { error: 'not_eligible' }, ORIGIN]);
    const gone = await call(app, 'GET', `/api/agents/${a.agentId}/suggestion`, a.userId);
    expect(await gone.json()).toEqual({ eligible: false });
    expect(model.calls()).toBe(1);
  });

  it('publish echoes the version shown: a missing or malformed one is 400, a stale one is 409 not_eligible, and nothing goes live', async () => {
    const { app } = setup();
    const a = await agent();
    await call(app, 'GET', `/api/agents/${a.agentId}/suggestion`, a.userId);
    const path = `/api/agents/${a.agentId}/suggestion/publish`;
    for (const body of [undefined, {}, { version: '1' }, { version: 1.5 }, { version: 0 }, [1]]) expect((await call(app, 'POST', path, a.userId, body)).status).toBe(400);
    const v = await specs.saveDraft(a.userId, a.agentId, specOf(parseSpec(xlmDrop().spec)));
    await specs.approve(a.userId, a.agentId, v); // the description moved on to version 2 after the card was shown
    const stale = await call(app, 'POST', path, a.userId, { version: 1 });
    expect([stale.status, await stale.json()]).toEqual([409, { error: 'not_eligible' }]);
    const card = await (await app(new Request(`${API}/a/${a.agentId}/agent.json`))).json();
    expect((card as { services?: unknown[] }).services ?? []).toEqual([]);
    const fresh = await call(app, 'GET', `/api/agents/${a.agentId}/suggestion`, a.userId);
    expect(await fresh.json()).toMatchObject({ eligible: true, suggestion: { version: 2 } });
    expect((await call(app, 'POST', path, a.userId, { version: 2 })).status).toBe(204);
  });

  it('another user\'s agent is 404, no bearer is 401, a killed Builder is 503; none calls a model', async () => {
    const { app, model } = setup();
    const a = await agent();
    const b = await activeAgent(sql);
    for (const [m, path, body] of [['GET', 'suggestion', undefined], ['POST', 'suggestion/publish', { version: 1 }]] as const) {
      expect((await call(app, m, `/api/agents/${a.agentId}/${path}`, b.userId, body)).status).toBe(404);
      expect((await call(app, m, `/api/agents/${a.agentId}/${path}`, undefined, body)).status).toBe(401);
      expect((await call(setup({ killed: true }).app, m, `/api/agents/${a.agentId}/${path}`, a.userId, body)).status).toBe(503);
    }
    expect(model.calls()).toBe(0);
  });
});

describe('gateway panel routes: the owner edits a knob (Task 29)', () => {
  setDefaultTimeout(30_000);
  let sql: Db;
  let drop: () => Promise<void>;
  let specs: Specs;
  let app: ReturnType<typeof createApp>;
  beforeAll(async () => {
    ({ sql, drop } = await freshDb());
    specs = createSpecs(sql);
    app = createApp({
      sql,
      verify,
      passkey: {} as never,
      signRequests: {} as never,
      provisioner: {} as never,
      appOrigin: ORIGIN,
      panel: {
        agents: createAgents(sql),
        activity: {} as never,
        revise: {
          builder: { draft: async () => (calls.model++, { ok: false, code: 'model_error', usage: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 } }) } as never,
          limits: createBuilderLimits(sql),
          specs,
          killed: false,
        },
      },
    });
  });
  afterAll(() => drop());

  const verify: AuthVerifier = async (t) => (t.startsWith('tok:') ? { id: t.slice(4), email: `${t.slice(4)}@example.com` } : null);
  const viewOf = (d: DraftResult) => {
    const { name: _n, spec: _s, ...v } = d;
    return v;
  };
  const owned = (): AgentSpec => {
    const base = xlmDrop().spec;
    const p = parseSpec({
      ...base,
      tools: [...base.tools, 'send_webhook', 'hire_agent'],
      services: [{ slug: 'owner-quote-svc', description: 'a quote', price_usdc: '0.01', input_schema: { type: 'object', properties: { q: { type: 'string' } }, required: ['q'] }, output_schema: { type: 'object', properties: { a: { type: 'string' } } }, persona: 'quoter', skill_body: '', tools: ['web_read'] }],
      hire_targets: [{ url: 'https://hired.example/agent', max_usdc: '0.05' }],
      skills: [{ name: 'owner-skill', description: 'a skill', body: 'owner-skill-body' }],
      suggested_plan: ['owner plan step'],
      delivery: { email: true, webhook_url: 'https://hooks.example/owner-hook' },
    });
    if (!p.ok) throw new Error(p.problem);
    return p.spec;
  };
  async function agentWith(spec: AgentSpec, view: ReturnType<typeof viewOf> | null = viewOf(xlmDrop())) {
    const a = await activeAgent(sql);
    const v = await specs.saveDraft(a.userId, a.agentId, spec, undefined, view ?? undefined);
    await specs.approve(a.userId, a.agentId, v);
    return a;
  }
  const calls = { model: 0 };
  const edit = (agentId: string, userId: string | undefined, body: unknown) =>
    app(
      new Request(`${API}/api/agents/${agentId}/builder/edit`, {
        method: 'POST',
        headers: { origin: ORIGIN, 'content-type': 'application/json', ...(userId ? { authorization: `Bearer tok:${userId}` } : {}) },
        body: JSON.stringify(body),
      }),
      '203.0.113.9',
    );

  it('edits the stored version, keeps everything the owner added, makes no model call and saves nothing', async () => {
    const a = await agentWith(owned());
    const r = await edit(a.agentId, a.userId, { param: 'drop', value: 7 });
    expect([r.status, r.headers.get('access-control-allow-origin')]).toEqual([200, ORIGIN]);
    const { draft } = (await r.json()) as { draft: DraftResult };
    expect(draft.params[0]).toMatchObject({ id: 'drop', value: 7 });
    expect(draft.spec.triggers[0]).toMatchObject({ params: { drop_pct: 7 } });
    expect(draft.spec.services.map((s) => s.slug)).toEqual(['owner-quote-svc']);
    expect(draft.spec.hire_targets.map((t) => t.url)).toEqual(['https://hired.example/agent']);
    expect(draft.spec.skills.map((s) => s.name)).toEqual(['owner-skill']);
    expect(draft.spec.suggested_plan).toEqual(['owner plan step']);
    expect(draft.spec.delivery.webhook_url).toBe('https://hooks.example/owner-hook');
    expect(draft.spec.tools).toEqual(expect.arrayContaining(['send_webhook', 'hire_agent']));
    expect(calls.model).toBe(0);
    expect(((await sql`select count(*)::int as n from app.agent_specs where agent_id = ${a.agentId}`) as { n: number }[])[0]!.n).toBe(1);
  });

  it('replays the taps already on screen first, so a second tap keeps the first', async () => {
    const a = await agentWith(bigUsdc().spec, viewOf(bigUsdc()));
    const other = `G${'B'.repeat(55)}`;
    const r = await edit(a.agentId, a.userId, { param: 'account', value: other, earlier: [{ param: 'size', value: '100000' }] });
    const d = ((await r.json()) as { draft: DraftResult }).draft;
    expect([r.status, d.params.find((p) => p.id === 'size')!.value, d.params.find((p) => p.id === 'account')!.value]).toEqual([200, '100000', other]);
    expect(JSON.stringify(d.spec.triggers[0])).toContain('100000');
    // an earlier tap that does not apply, or too many of them, is refused
    expect((await edit(a.agentId, a.userId, { param: 'account', value: other, earlier: [{ param: 'size', value: 'huge' }] })).status).toBe(400);
    expect((await edit(a.agentId, a.userId, { param: 'account', value: other, earlier: 'x' })).status).toBe(400);
    expect((await edit(a.agentId, a.userId, { param: 'account', value: other, earlier: Array.from({ length: 33 }, () => ({ param: 'size', value: '1000' })) })).status).toBe(400);
  });

  it('refuses an over-long or empty param, in the tap or in earlier, with 400', async () => {
    const a = await agentWith(owned());
    const long = 'x'.repeat(65);
    expect((await edit(a.agentId, a.userId, { param: long, value: 1 })).status).toBe(400);
    expect((await edit(a.agentId, a.userId, { param: 'drop', value: 7, earlier: [{ param: long, value: 1 }] })).status).toBe(400);
    expect((await edit(a.agentId, a.userId, { param: 'drop', value: 7, earlier: [{ param: '', value: 1 }] })).status).toBe(400);
    expect((await edit(a.agentId, a.userId, { param: 'drop', value: 7, earlier: [{ param: 'x'.repeat(64), value: 1 }] })).status).toBe(400); // 64 is allowed by length, then unknown
  });

  it('is rate limited per account like the other panel writes; another account is unaffected', async () => {
    const a = await agentWith(owned());
    const b = await agentWith(owned());
    for (let i = 0; i < PANEL_WRITES_PER_HOUR; i++) expect((await edit(a.agentId, a.userId, { value: 1 })).status).toBe(400);
    const limited = await edit(a.agentId, a.userId, { param: 'drop', value: 7 });
    expect([limited.status, await limited.json()]).toEqual([429, { error: 'rate_limited' }]);
    expect(Number(limited.headers.get('retry-after'))).toBeGreaterThan(0);
    expect((await edit(b.agentId, b.userId, { param: 'drop', value: 7 })).status).toBe(200);
  });

  it('ignores any draft the client sends: only the stored description is edited', async () => {
    const a = await agentWith(owned());
    const r = await edit(a.agentId, a.userId, { param: 'drop', value: 8, draft: { name: 'spoof', spec: 'client says so' } });
    expect(((await r.json()) as { draft: DraftResult }).draft.name).toBe('test agent');
  });

  it('refuses a bad value or parameter with 400 bad_edit', async () => {
    const a = await agentWith(owned());
    for (const body of [{ param: 'drop', value: 9999 }, { param: 'drop', value: 'x' }, { param: 'nope', value: 1 }]) {
      const r = await edit(a.agentId, a.userId, body);
      expect([r.status, ((await r.json()) as { error: string }).error]).toEqual([400, 'bad_edit']);
    }
    expect((await edit(a.agentId, a.userId, { value: 1 })).status).toBe(400);
  });

  it('is owner-only, and needs an active or paused agent with an active version', async () => {
    const a = await agentWith(owned());
    const b = await activeAgent(sql);
    expect((await edit(a.agentId, undefined, { param: 'drop', value: 7 })).status).toBe(401);
    expect((await edit(a.agentId, b.userId, { param: 'drop', value: 7 })).status).toBe(404);
    expect((await edit(b.agentId, b.userId, { param: 'drop', value: 7 })).status).toBe(409); // nothing approved yet
    await sql`update app.agents set status = 'paused' where id = ${a.agentId}`;
    expect((await edit(a.agentId, a.userId, { param: 'drop', value: 7 })).status).toBe(200); // a paused agent may be edited
    await sql`update app.agents set status = 'revoked' where id = ${a.agentId}`;
    expect((await edit(a.agentId, a.userId, { param: 'drop', value: 7 })).status).toBe(409);
  });
});

describe('gateway panel routes: the agent model', () => {
  let sql: Db;
  let drop: () => Promise<void>;
  let base: Omit<AppDeps, 'panel'>;
  beforeAll(async () => {
    ({ sql, drop } = await freshDb());
    const verify: AuthVerifier = async (t) => (t.startsWith('tok:') ? { id: t.slice(4), email: `${t.slice(4)}@example.com` } : null);
    base = { sql, verify, passkey: {} as never, signRequests: {} as never, provisioner: {} as never, appOrigin: ORIGIN };
  });
  afterAll(() => drop());
  const h = () => createApp({ ...base, panel: { agents: createAgents(sql), activity: createActivity(sql, { publicBaseUrl: 'https://agentenact.io', models: createModelDirectory({ defaultId: 'deepseek/deepseek-v4.1-flash' }) }) } });
  const post = (id: string, userId: string | undefined, body: unknown) =>
    h()(new Request(`${API}/api/agents/${id}/model`, { method: 'POST', headers: { 'content-type': 'application/json', ...(userId ? { authorization: `Bearer tok:${userId}` } : {}) }, body: JSON.stringify(body) }));
  const overview = async (a: { agentId: string; userId: string }) =>
    ((await (await h()(new Request(`${API}/api/agents/${a.agentId}/overview`, { headers: { authorization: `Bearer tok:${a.userId}` } }))).json()) as { model: { current: string; chosen: string | null; choices: { id: string; weight: number }[] } }).model;

  it('shows the default and the list, stores a pick (204), and is owner-only', async () => {
    const a = await activeAgent(sql);
    const b = await activeAgent(sql);
    const before = await overview(a);
    expect(before).toMatchObject({ current: 'deepseek/deepseek-v4.1-flash', chosen: null });
    expect(before.choices[0]).toMatchObject({ id: 'deepseek/deepseek-v4.1-flash', weight: 1 });
    expect((await post(a.agentId, a.userId, { model: 'anthropic/claude-sonnet-5.5' })).status).toBe(204);
    expect(await overview(a)).toMatchObject({ current: 'anthropic/claude-sonnet-5.5', chosen: 'anthropic/claude-sonnet-5.5' });
    expect((await post(a.agentId, b.userId, { model: null })).status).toBe(404);
    expect((await post(a.agentId, undefined, { model: null })).status).toBe(401);
    expect((await post(a.agentId, a.userId, { model: null })).status).toBe(204);
    expect((await overview(a)).chosen).toBeNull();
  });

  it('refuses a body that is not a slug or null, and a slug off the list', async () => {
    const a = await activeAgent(sql);
    for (const body of [{}, { model: 3 }, { model: 'x'.repeat(200) }, [], 'x']) expect((await post(a.agentId, a.userId, body)).status).toBe(400);
    expect((await post(a.agentId, a.userId, { model: 'openai/gpt-5.4-pro' })).status).toBe(400);
  });
});
