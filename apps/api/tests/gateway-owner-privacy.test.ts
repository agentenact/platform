import { afterAll, beforeAll, describe, expect, it, setDefaultTimeout } from 'bun:test';
import type { AuthVerifier } from '../src/account/auth.js';
import { createActivity } from '../src/activity/index.js';
import { createAgents } from '../src/agents/index.js';
import { xlmDrop } from '../src/builder/examples.js';
import { createBuilder } from '../src/builder/index.js';
import { createBuilderLimits } from '../src/builder/limits.js';
import { createSuggest } from '../src/builder/suggest.js';
import type { Db } from '../src/db/index.js';
import { createApp } from '../src/gateway/app.js';
import { createChecks } from '../src/runs/checks.js';
import { createOwnerRuns } from '../src/loop/owner.js';
import { createRuns } from '../src/runs/index.js';
import { createSpecs, type Specs } from '../src/specs/index.js';
import { parseSpec, type AgentSpec } from '../src/specs/schema.js';
import { freshDb } from './support/db.js';
import { scriptedModel } from './support/models.js';
import { activeAgent } from './support/specs.js';

const ORIGIN = 'https://app.agentenact.io';
const API = 'https://api.agentenact.io';

/**
 * T10 M2/M7: one user can read or change nothing of another user's agent, runs or drafts, through EVERY owner route that
 * carries an agent id. A foreign id is 404 (never 403, never a body), and the owner's rows are the same afterwards.
 */
describe('gateway owner routes: a second user sees and changes nothing of the first user\'s agent', () => {
  setDefaultTimeout(60_000);
  let sql: Db;
  let drop: () => Promise<void>;
  let specs: Specs;
  let handler: ReturnType<typeof createApp>;
  const models = { builder: scriptedModel([{ text: 'never' }]), builderAnon: scriptedModel([{ text: 'never' }]), suggest: scriptedModel([{ text: 'never' }]) };
  const chatOpened: string[] = [];
  const MARK = { name: 'Alpha-Private-Name-7741', persona: 'persona-marker-7741', draft: 'draft-persona-marker-7741', secret: 'webhook-secret-marker-7741' };

  let a: { userId: string; agentId: string };
  let b: { userId: string; agentId: string };
  let runId: string;
  let bRunId: string;

  beforeAll(async () => {
    ({ sql, drop } = await freshDb());
    specs = createSpecs(sql);
    const verify: AuthVerifier = async (t) => (t.startsWith('tok:') ? { id: t.slice(4), email: `${t.slice(4)}@example.com` } : null);
    const runs = createRuns(sql);
    // The real owner chat: its ownership check runs before anything else, so the runner/toolbox/memory it would use are never touched.
    const real = createOwnerRuns({ sql, specs, memory: {} as never, runs, runner: {} as never, toolbox: {} as never, policy: {} as never });
    const owner = { openChat: (u: string, id: string) => (chatOpened.push(`${u}:${id}`), real.openChat(u, id)) };
    handler = createApp({
      sql, verify, passkey: {} as never, signRequests: {} as never, provisioner: { start: async () => ({ outcome: 'busy' as const }) } as never, appOrigin: ORIGIN,
      runtime: { specs, runs, chat: owner, webhookSecret: () => MARK.secret, killed: false },
      panel: {
        agents: createAgents(sql),
        activity: createActivity(sql, { publicBaseUrl: 'https://agentenact.io' }),
        revise: { builder: createBuilder({ models: { builder: models.builder, builderAnon: models.builderAnon } }), limits: createBuilderLimits(sql), specs, killed: false },
        suggest: { suggest: createSuggest({ sql, specs, checks: createChecks(sql), model: models.suggest, limits: createBuilderLimits(sql) }), killed: false },
      },
    });
    const specOf = (persona: string): AgentSpec => {
      const r = parseSpec({ ...xlmDrop().spec, persona });
      if (!r.ok) throw new Error(r.problem);
      return r.spec;
    };
    a = await activeAgent(sql);
    b = await activeAgent(sql);
    await sql`update app.agents set name = ${MARK.name} where id = ${a.agentId}`;
    const v1 = await specs.saveDraft(a.userId, a.agentId, specOf(MARK.persona));
    await specs.approve(a.userId, a.agentId, v1);
    await specs.saveDraft(a.userId, a.agentId, specOf(MARK.draft)); // A's pending draft
    await specs.approve(b.userId, b.agentId, await specs.saveDraft(b.userId, b.agentId, specOf('b persona')));
    runId = await runs.start({ agentId: a.agentId, mode: 'chat' });
    bRunId = await runs.start({ agentId: b.agentId, mode: 'chat' });
    await sql`insert into app.check_days (agent_id, day, quiet) values (${a.agentId}, (now() at time zone 'utc')::date, 3)`;
  });
  afterAll(() => drop());

  const call = (method: string, path: string, userId?: string, body?: unknown) =>
    handler(
      new Request(`${API}${path}`, {
        method,
        headers: { ...(userId ? { authorization: `Bearer tok:${userId}` } : {}), ...(body === undefined ? {} : { 'content-type': 'application/json' }) },
        body: body === undefined ? undefined : JSON.stringify(body),
      }),
      '203.0.113.9',
    );

  /** Every owner route that carries the agent id. `own` is the caller's own agent id, used for the cross-agent run routes. */
  const routes = (agent: string): { method: string; path: string; body?: unknown; readsData: boolean }[] => [
    { method: 'GET', path: `/api/agents/${agent}`, readsData: true },
    { method: 'POST', path: `/api/agents/${agent}/retry`, readsData: false },
    { method: 'POST', path: `/api/agents/${agent}/pause`, readsData: false },
    { method: 'POST', path: `/api/agents/${agent}/resume`, readsData: false },
    { method: 'GET', path: `/api/agents/${agent}/overview`, readsData: true },
    { method: 'GET', path: `/api/agents/${agent}/activity?days=30`, readsData: true },
    { method: 'GET', path: `/api/agents/${agent}/earnings`, readsData: true },
    { method: 'GET', path: `/api/agents/${agent}/spec`, readsData: true },
    { method: 'PUT', path: `/api/agents/${agent}/spec`, body: { spec: xlmDrop().spec, buildPrompt: 'intrusion' }, readsData: false },
    { method: 'POST', path: `/api/agents/${agent}/spec/2/approve`, readsData: false },
    { method: 'DELETE', path: `/api/agents/${agent}/spec/2`, readsData: false },
    { method: 'GET', path: `/api/agents/${agent}/runs`, readsData: true },
    { method: 'GET', path: `/api/agents/${agent}/runs/${runId}`, readsData: true },
    { method: 'GET', path: `/api/agents/${agent}/webhook-secret`, readsData: true },
    { method: 'POST', path: `/api/chat/${agent}`, body: { messages: [{ role: 'user', content: 'hi' }] }, readsData: false },
    { method: 'POST', path: `/api/agents/${agent}/builder/edit`, body: { param: 'drop', value: 9 }, readsData: false },
    { method: 'POST', path: `/api/agents/${agent}/builder/draft`, body: { prompt: 'make it different' }, readsData: false },
    { method: 'GET', path: `/api/agents/${agent}/suggestion`, readsData: true },
    { method: 'POST', path: `/api/agents/${agent}/suggestion/publish`, body: { version: 1 }, readsData: false },
  ];

  const snapshot = async () => ({
    agent: await sql`select id, name, status, active_spec_version, provision_state from app.agents order by id`,
    specs: await sql`select agent_id, version, status, spec, view from app.agent_specs order by agent_id, version`,
    runs: await sql`select id, agent_id, status from app.runs order by id`,
    usage: await sql`select scope, kind, n from app.builder_usage order by scope, kind`,
    services: await sql`select agent_id, slug, status from app.services order by agent_id, slug`,
  });

  it('control: the owner reaches the same data routes (the test can fail)', async () => {
    for (const r of routes(a.agentId).filter((x) => x.readsData && x.method === 'GET' && !x.path.endsWith('/suggestion'))) {
      const res = await call(r.method, r.path, a.userId);
      expect([r.path, res.status]).toEqual([r.path, 200]);
    }
    expect(JSON.stringify(await (await call('GET', `/api/agents/${a.agentId}/spec`, a.userId)).json())).toContain(MARK.draft);
    expect(await (await call('GET', `/api/agents/${a.agentId}/overview`, a.userId)).text()).toContain(MARK.name);
  });

  it('every owner route answers another user 404 with none of the owner\'s data, and changes nothing', async () => {
    const before = await snapshot();
    const texts: string[] = [];
    for (const r of routes(a.agentId)) {
      const res = await call(r.method, r.path, b.userId, r.body);
      const text = await res.text();
      texts.push(text);
      expect([r.method, r.path, res.status]).toEqual([r.method, r.path, 404]);
      expect(JSON.parse(text)).toEqual({ error: 'not_found' });
    }
    for (const t of texts) for (const m of Object.values(MARK)) expect(t).not.toContain(m);
    expect(chatOpened.every((c) => c.startsWith(`${b.userId}:`))).toBe(true); // only B's own attempts, each refused 404 before a session existed
    for (const m of Object.values(models)) expect(m.calls()).toBe(0); // nobody else's request spent model money
    expect(await snapshot()).toEqual(before);
  });

  it('no bearer is 401 on every owner route', async () => {
    for (const r of routes(a.agentId)) {
      const res = await call(r.method, r.path, undefined, r.body);
      expect([r.method, r.path, res.status]).toEqual([r.method, r.path, 401]);
    }
  });

  it('a run is reachable only through its own agent and its owner: a foreign run id under my own agent is 404', async () => {
    expect((await call('GET', `/api/agents/${b.agentId}/runs/${runId}`, b.userId)).status).toBe(404); // A's run under B's agent
    expect((await call('GET', `/api/agents/${a.agentId}/runs/${bRunId}`, a.userId)).status).toBe(404); // B's run under A's agent
    expect((await call('GET', `/api/agents/${b.agentId}/runs/${bRunId}`, b.userId)).status).toBe(200);
    const list = (await (await call('GET', `/api/agents/${b.agentId}/runs`, b.userId)).json()) as { runs: { id: string }[] };
    expect(list.runs.map((x) => x.id)).toEqual([bRunId]);
  });

  it("each user's own lists hold only their own rows", async () => {
    const mine = JSON.stringify(await (await call('GET', `/api/agents/${b.agentId}/spec`, b.userId)).json());
    expect(mine).toContain('b persona');
    for (const m of [MARK.persona, MARK.draft]) expect(mine).not.toContain(m);
    const me = JSON.stringify(await (await call('GET', '/api/me', b.userId)).json());
    expect(me).toContain(b.agentId);
    expect(me).not.toContain(a.agentId);
    expect(me).not.toContain(MARK.name);
  });
});
