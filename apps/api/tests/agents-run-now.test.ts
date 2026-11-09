import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import type { AuthVerifier } from '../src/account/auth.js';
import type { Db } from '../src/db/index.js';
import { createActivity } from '../src/activity/index.js';
import { createAgents } from '../src/agents/index.js';
import { createApp, type AppDeps } from '../src/gateway/app.js';
import { RUN_NOW_PER_HOUR } from '../src/gateway/panel-routes.js';
import { DAILY_RUNS } from '../src/policy/index.js';
import { CLAIM_LEASE_MIN, createScheduler } from '../src/scheduler/index.js';
import { createSpecs } from '../src/specs/index.js';
import type { TriggerSpec } from '../src/specs/schema.js';
import { freshDb } from './support/db.js';
import { activeAgent, minimalSpec } from './support/specs.js';

const ORIGIN = 'https://app.agentenact.io';
const API = 'https://api.agentenact.io';

describe('agents: run now', () => {
  let sql: Db;
  let drop: () => Promise<void>;
  beforeAll(async () => ({ sql, drop } = await freshDb()));
  afterAll(() => drop());

  const agents = () => createAgents(sql);
  const missions: string[] = [];
  const scheduler = (o: { held?: boolean } = {}) =>
    createScheduler({
      sql,
      killed: () => false,
      mission: async (agentId) => (missions.push(agentId), { status: 'done' }),
      conditionFetch: async () => ({}),
      sandbox: async () => ({ ok: true, value: o.held ?? false }),
      notify: async () => undefined,
    });
  // Daily at 18:00 in Istanbul: in the future for most of any test run, never due by accident.
  const evening: TriggerSpec = { kind: 'cron', cron: '0 18 * * *', tz: 'Europe/Istanbul', mission: 'Write the digest.' };
  const morning: TriggerSpec = { kind: 'cron', cron: '0 8 * * *', tz: 'Europe/Istanbul', mission: 'Write the morning note.' };
  const condition: TriggerSpec = { kind: 'condition', fetch: { tool: 'market_price', args: { ids: ['stellar'] } }, code: 'return true', every_s: 600, cooldown_s: 3600, mission: 'Moved.' };

  async function withTriggers(...ts: TriggerSpec[]) {
    const a = await activeAgent(sql);
    const specs = createSpecs(sql);
    await specs.approve(a.userId, a.agentId, await specs.saveDraft(a.userId, a.agentId, minimalSpec({ triggers: ts })));
    // Push every trigger safely into the future so nothing is due unless a test makes it so.
    await sql`update app.triggers set next_run_at = now() + interval '3 hours' + (random() * interval '1 hour') where agent_id = ${a.agentId}`;
    return a;
  }
  const trigs = async (agentId: string) =>
    (await sql`select id, kind, cron_expr, next_run_at, last_fired_at, claimed_at, next_run_at <= now() as due from app.triggers where agent_id = ${agentId} order by next_run_at, id`) as {
      id: string; kind: string; cron_expr: string | null; next_run_at: Date; last_fired_at: Date | null; claimed_at: Date | null; due: boolean;
    }[];

  it('pulls only the soonest trigger to now; the scheduler runs it and the schedule after it is unchanged', async () => {
    const a = await withTriggers(evening, morning);
    const before = await trigs(a.agentId);
    const out = await agents().runNow(a.userId, a.agentId);
    expect(out.state).toBe('queued');
    const after = await trigs(a.agentId);
    expect(after.filter((t) => t.due).map((t) => t.id)).toEqual([before[0]!.id]);
    expect(after.find((t) => t.id === before[1]!.id)!.next_run_at.getTime()).toBe(before[1]!.next_run_at.getTime());

    const n = missions.length;
    const report = await scheduler().tick();
    expect(report.missions).toBeGreaterThanOrEqual(1);
    expect(missions.slice(n)).toContain(a.agentId);
    const fired = (await trigs(a.agentId)).find((t) => t.id === before[0]!.id)!;
    expect(fired.last_fired_at).not.toBeNull();
    expect(fired.claimed_at).not.toBeNull();
    expect(fired.due).toBe(false); // back on its own schedule: the next 18:00 / 08:00 slot
  });

  it('a second press before the scheduler picks it up, or while it runs, never makes a second fire', async () => {
    const a = await withTriggers(evening);
    expect((await agents().runNow(a.userId, a.agentId)).state).toBe('queued');
    expect(await agents().runNow(a.userId, a.agentId)).toEqual({ state: 'running' });
    // Simulate the scheduler's claim (the lease) without finishing the fire.
    await sql`update app.triggers set next_run_at = now() + make_interval(mins => ${CLAIM_LEASE_MIN}), claimed_at = now() where agent_id = ${a.agentId}`;
    expect(await agents().runNow(a.userId, a.agentId)).toEqual({ state: 'running' });
    expect((await trigs(a.agentId))[0]!.due).toBe(false);
  });

  it('an old claim whose fire already rescheduled the trigger does not block a new run', async () => {
    const a = await withTriggers(evening);
    await sql`update app.triggers set claimed_at = now() - interval '2 hours' where agent_id = ${a.agentId}`;
    expect((await agents().runNow(a.userId, a.agentId)).state).toBe('queued');
  });

  it('a condition agent inside its cooldown answers cooling_down with when it ends, and moves nothing', async () => {
    const a = await withTriggers(condition);
    await sql`update app.triggers set last_fired_at = now() - interval '10 minutes' where agent_id = ${a.agentId}`;
    const out = await agents().runNow(a.userId, a.agentId);
    expect(out.state).toBe('cooling_down');
    if (out.state === 'cooling_down') expect(Date.parse(out.until) - Date.now()).toBeGreaterThan(49 * 60_000);
    expect((await trigs(a.agentId))[0]!.due).toBe(false);
    await sql`update app.triggers set last_fired_at = now() - interval '2 hours' where agent_id = ${a.agentId}`;
    expect((await agents().runNow(a.userId, a.agentId)).state).toBe('queued');
  });

  it('refuses a paused agent, a foreign one, an agent with no checks, and a spent daily budget', async () => {
    const a = await withTriggers(evening);
    const b = await withTriggers(evening);
    await expect(agents().runNow(b.userId, a.agentId)).rejects.toMatchObject({ status: 404, code: 'not_found' });
    await agents().pause(a.userId, a.agentId);
    await expect(agents().runNow(a.userId, a.agentId)).rejects.toMatchObject({ status: 409, code: 'agent_paused' });
    expect((await trigs(a.agentId))[0]!.due).toBe(false);

    await sql`update app.users set daily_runs = ${DAILY_RUNS}, daily_reset_at = now() where id = ${b.userId}`;
    await expect(agents().runNow(b.userId, b.agentId)).rejects.toMatchObject({ status: 429, code: 'daily_limit' });
    // Yesterday's count is no longer today's.
    await sql`update app.users set daily_reset_at = now() - interval '2 days' where id = ${b.userId}`;
    expect((await agents().runNow(b.userId, b.agentId)).state).toBe('queued');

    const c = await withTriggers(evening);
    await sql`update app.triggers set enabled = false where agent_id = ${c.agentId}`;
    await expect(agents().runNow(c.userId, c.agentId)).rejects.toMatchObject({ status: 409, code: 'no_checks' });
  });

  it('the overview says running while a check is due or claimed, and never shows the claim lease as the next check', async () => {
    const a = await withTriggers(evening, morning);
    const overview = () => createActivity(sql, { publicBaseUrl: 'https://agentenact.io' }).overview(a.userId, a.agentId);
    const idle = await overview();
    expect(idle.running).toBe(false);
    const [first, second] = await trigs(a.agentId);
    expect(idle.nextCheckAt).toBe(first!.next_run_at.toISOString());

    await agents().runNow(a.userId, a.agentId);
    expect((await overview()).running).toBe(true);
    // Claimed: the lease is left out, so the next check shown is the other trigger's own slot.
    await sql`update app.triggers set next_run_at = now() + make_interval(mins => ${CLAIM_LEASE_MIN}), claimed_at = now() where id = ${first!.id}`;
    const busy = await overview();
    expect(busy.running).toBe(true);
    expect(busy.nextCheckAt).toBe(second!.next_run_at.toISOString());
    // The fire finished and rescheduled: idle again.
    await sql`update app.triggers set next_run_at = now() + interval '1 day' where id = ${first!.id}`;
    expect((await overview()).running).toBe(false);
  });

  it('the overview names the newest finished mission as the last run, with its id for the feed link', async () => {
    const a = await withTriggers(evening);
    const overview = () => createActivity(sql, { publicBaseUrl: 'https://agentenact.io' }).overview(a.userId, a.agentId);
    expect((await overview()).lastRun).toBeNull();
    const add = async (status: string, ago: string, mode = 'mission') =>
      ((await sql`insert into app.runs (agent_id, mode, status, started_at, ended_at)
                  values (${a.agentId}, ${mode}, ${status}, now() - ${ago}::interval, now() - ${ago}::interval) returning id`) as { id: string }[])[0]!.id;
    await add('done', '2 hours');
    const failed = await add('error', '5 minutes');
    await add('running', '1 minute'); // still going: not a result yet
    await add('done', '30 seconds', 'chat'); // a chat turn is not a run
    const last = (await overview()).lastRun!;
    expect([last.runId, last.ok]).toEqual([failed, false]);
    expect(Date.now() - Date.parse(last.at)).toBeGreaterThan(4 * 60_000);
    const done = await add('done', '10 seconds');
    expect((await overview()).lastRun).toMatchObject({ runId: done, ok: true });
  });

  describe('POST /api/agents/:id/run', () => {
    let base: Omit<AppDeps, 'panel'>;
    beforeAll(() => {
      const verify: AuthVerifier = async (t) => (t.startsWith('tok:') ? { id: t.slice(4), email: `${t.slice(4)}@example.com` } : null);
      base = { sql, verify, passkey: {} as never, signRequests: {} as never, provisioner: {} as never, appOrigin: ORIGIN };
    });
    const app = (o: { killed?: boolean; now?: () => number } = {}) =>
      createApp({ ...base, panel: { agents: createAgents(sql), activity: {} as never, killed: () => o.killed ?? false, ...(o.now ? { now: o.now } : {}) } });
    const run = (h: ReturnType<typeof app>, agentId: string, userId?: string) =>
      h(new Request(`${API}/api/agents/${agentId}/run`, { method: 'POST', headers: { origin: ORIGIN, ...(userId ? { authorization: `Bearer tok:${userId}` } : {}) } }));

    it('answers the state, is owner-only, and keeps the CORS', async () => {
      const a = await withTriggers(evening);
      const h = app();
      expect((await run(h, a.agentId)).status).toBe(401);
      const r = await run(h, a.agentId, a.userId);
      expect([r.status, r.headers.get('access-control-allow-origin')]).toEqual([200, ORIGIN]);
      expect((await r.json()).state).toBe('queued');
      expect(await (await run(h, a.agentId, a.userId)).json()).toEqual({ state: 'running' });
    });

    it('is 503 while the kill switch is on, and moves nothing', async () => {
      const a = await withTriggers(evening);
      const r = await run(app({ killed: true }), a.agentId, a.userId);
      expect([r.status, await r.json()]).toEqual([503, { error: 'killed' }]);
      expect((await trigs(a.agentId))[0]!.due).toBe(false);
    });

    it(`allows ${RUN_NOW_PER_HOUR} presses per agent per hour`, async () => {
      const a = await withTriggers(evening);
      let t = 1_000_000;
      const h = app({ now: () => t });
      for (let i = 0; i < RUN_NOW_PER_HOUR; i++) expect((await run(h, a.agentId, a.userId)).status).toBe(200);
      const r = await run(h, a.agentId, a.userId);
      expect([r.status, await r.json()]).toEqual([429, { error: 'rate_limited' }]);
      t += 3_600_000;
      expect((await run(h, a.agentId, a.userId)).status).toBe(200);
    });
  });
});
