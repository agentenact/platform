import { afterAll, beforeAll, describe, expect, it, setSystemTime } from 'bun:test';
import type { Db } from '../src/db/index.js';
import { createAgents } from '../src/agents/index.js';
import { createScheduler } from '../src/scheduler/index.js';
import { createSpecs } from '../src/specs/index.js';
import type { TriggerSpec } from '../src/specs/schema.js';
import { freshDb } from './support/db.js';
import { insertAgent, insertUser } from './support/fixtures.js';
import { activeAgent, minimalSpec } from './support/specs.js';

interface Trig { id: string; kind: string; next_run_at: Date; last_fired_at: Date | null; error_streak: number; enabled: boolean }

describe('agents: pause and resume', () => {
  let sql: Db;
  let drop: () => Promise<void>;
  beforeAll(async () => ({ sql, drop } = await freshDb()));
  afterAll(() => drop());

  const agents = () => createAgents(sql);
  const status = async (id: string) => ((await sql`select status from app.agents where id = ${id}`) as { status: string }[])[0]!.status;
  const missions: string[] = [];
  const scheduler = () =>
    createScheduler({
      sql,
      killed: () => false,
      mission: async (agentId) => (missions.push(agentId), { status: 'done' }),
      conditionFetch: async () => ({}),
      sandbox: async () => ({ ok: true, value: false }),
      notify: async () => undefined,
    });
  const cron: TriggerSpec = { kind: 'cron', cron: '*/15 * * * *', mission: 'Report XLM.' };
  const condition: TriggerSpec = { kind: 'condition', fetch: { tool: 'market_price', args: { ids: ['stellar'] } }, code: 'return false', every_s: 600, cooldown_s: 3600, mission: 'Moved.' };

  /** An active agent with the given approved triggers. */
  async function withTriggers(...ts: TriggerSpec[]) {
    const a = await activeAgent(sql);
    const specs = createSpecs(sql);
    await specs.approve(a.userId, a.agentId, await specs.saveDraft(a.userId, a.agentId, minimalSpec({ triggers: ts })));
    return a;
  }
  const trigs = async (agentId: string) => (await sql`select id, kind, next_run_at, last_fired_at, error_streak, enabled from app.triggers where agent_id = ${agentId} order by kind`) as Trig[];
  const makeDue = (agentId: string, ago = "1 second") => sql`update app.triggers set next_run_at = now() - ${ago}::interval where agent_id = ${agentId}`;

  it('pause stops the scheduler claiming the agent\'s triggers', async () => {
    const a = await withTriggers(cron);
    await makeDue(a.agentId);
    await agents().pause(a.userId, a.agentId);
    expect(await status(a.agentId)).toBe('paused');
    const before = missions.length;
    expect((await scheduler().tick()).claimed).toBe(0);
    expect(missions.length).toBe(before);
    expect((await trigs(a.agentId))[0]!.enabled).toBe(true); // paused is not disabled
  });

  it('resume restores claiming', async () => {
    const a = await withTriggers(cron);
    await agents().pause(a.userId, a.agentId);
    await agents().resume(a.userId, a.agentId);
    expect(await status(a.agentId)).toBe('active');
    await makeDue(a.agentId); // due after the resume: the scheduler claims it again
    const report = await scheduler().tick();
    expect(report.claimed).toBe(1);
    expect(missions.at(-1)).toBe(a.agentId);
  });

  it('resume moves an overdue cron to a future time and does not fire the missed runs', async () => {
    const a = await withTriggers(cron);
    await makeDue(a.agentId, '3 days');
    await agents().pause(a.userId, a.agentId);
    await agents().resume(a.userId, a.agentId);
    const [t] = await trigs(a.agentId);
    expect(t!.next_run_at.getTime()).toBeGreaterThan(Date.now());
    expect(t!.next_run_at.getTime() - Date.now()).toBeLessThanOrEqual(15 * 60_000);
    expect([t!.next_run_at.getUTCMinutes() % 15, t!.next_run_at.getUTCSeconds()]).toEqual([0, 0]);
    expect((await scheduler().tick()).claimed).toBe(0);
  });

  it('resume keeps last_fired_at so a cooled-down condition stays cooled; touches no other trigger field', async () => {
    const a = await withTriggers(condition);
    const fired = new Date(Date.now() - 600_000); // 10 minutes ago, cooldown 1 h
    await sql`update app.triggers set last_fired_at = ${fired}, error_streak = 2, next_run_at = now() - interval '2 days' where agent_id = ${a.agentId}`;
    await agents().pause(a.userId, a.agentId);
    await agents().resume(a.userId, a.agentId);
    const [t] = await trigs(a.agentId);
    expect([t!.last_fired_at!.getTime(), t!.error_streak, t!.enabled]).toEqual([fired.getTime(), 2, true]);
    expect(t!.next_run_at.getTime()).toBeLessThanOrEqual(Date.now()); // due now: it only looks at current data
    const before = missions.length;
    const report = await scheduler().tick();
    expect(report.claimed).toBe(1);
    expect(missions.length).toBe(before); // condition false and cooled down: no mission
  });

  it('resume leaves a trigger that is not overdue, and a disabled one, untouched', async () => {
    const a = await withTriggers(cron, condition);
    const future = new Date(Date.now() + 3_600_000);
    await sql`update app.triggers set next_run_at = ${future} where agent_id = ${a.agentId} and kind = 'cron'`;
    await sql`update app.triggers set enabled = false, next_run_at = now() - interval '1 day' where agent_id = ${a.agentId} and kind = 'condition'`;
    const before = await trigs(a.agentId);
    await agents().pause(a.userId, a.agentId);
    await agents().resume(a.userId, a.agentId);
    expect(await trigs(a.agentId)).toEqual(before);
  });

  it('pause on a provisioning or revoked agent is 409 not_active, and a second pause too', async () => {
    const userId = await insertUser(sql);
    const prov = await insertAgent(sql, userId, {});
    await expect(agents().pause(userId, prov)).rejects.toMatchObject({ status: 409, code: 'not_active' });
    const a = await activeAgent(sql);
    await sql`update app.agents set status = 'revoked' where id = ${a.agentId}`;
    await expect(agents().pause(a.userId, a.agentId)).rejects.toMatchObject({ status: 409, code: 'not_active' });
    const b = await activeAgent(sql);
    await agents().pause(b.userId, b.agentId);
    await expect(agents().pause(b.userId, b.agentId)).rejects.toMatchObject({ status: 409, code: 'not_active' });
  });

  it('resume on an active, provisioning or revoked agent is 409 not_paused, and nothing is touched', async () => {
    const a = await withTriggers(cron);
    await makeDue(a.agentId, '3 days');
    const before = await trigs(a.agentId);
    await expect(agents().resume(a.userId, a.agentId)).rejects.toMatchObject({ status: 409, code: 'not_paused' });
    expect(await trigs(a.agentId)).toEqual(before); // a refused resume moved no trigger
    await sql`update app.agents set status = 'revoked' where id = ${a.agentId}`;
    await expect(agents().resume(a.userId, a.agentId)).rejects.toMatchObject({ status: 409, code: 'not_paused' });
  });

  it('another user\'s or an unknown agent is 404', async () => {
    const a = await activeAgent(sql);
    const b = await activeAgent(sql);
    await expect(agents().pause(b.userId, a.agentId)).rejects.toMatchObject({ status: 404, code: 'not_found' });
    await expect(agents().resume(b.userId, a.agentId)).rejects.toMatchObject({ status: 404, code: 'not_found' });
    await expect(agents().pause(a.userId, crypto.randomUUID())).rejects.toMatchObject({ status: 404 });
    expect(await status(a.agentId)).toBe('active');
  });

  it('a failure while moving triggers rolls the resume back: the agent stays paused', async () => {
    const a = await withTriggers(cron);
    await makeDue(a.agentId, '1 day');
    await agents().pause(a.userId, a.agentId);
    await sql`update app.triggers set cron_expr = 'not a cron' where agent_id = ${a.agentId}`;
    await expect(agents().resume(a.userId, a.agentId)).rejects.toThrow();
    expect(await status(a.agentId)).toBe('paused');
  });

  it('concurrent pause and resume calls end in one consistent state; exactly one of two pauses wins', async () => {
    const a = await activeAgent(sql);
    const r = await Promise.allSettled([agents().pause(a.userId, a.agentId), agents().pause(a.userId, a.agentId)]);
    expect(r.map((x) => x.status).sort()).toEqual(['fulfilled', 'rejected']);
    const r2 = await Promise.allSettled([agents().resume(a.userId, a.agentId), agents().resume(a.userId, a.agentId)]);
    expect(r2.map((x) => x.status).sort()).toEqual(['fulfilled', 'rejected']);
    expect(await status(a.agentId)).toBe('active');
  });

  it('pause racing the claim never fires a mission for the paused agent: the claim joins on status, and the mission re-checks it', async () => {
    const a = await withTriggers(cron);
    await makeDue(a.agentId);
    // The claim won first (the trigger is leased), then the pause lands before the mission starts: the real owner.mission returns null.
    let paused = false;
    const s = createScheduler({
      sql,
      killed: () => false,
      mission: async (agentId) => {
        if (!paused) {
          paused = true;
          await agents().pause(a.userId, agentId);
        }
        const [row] = (await sql`select status from app.agents where id = ${agentId}`) as { status: string }[];
        return row!.status === 'active' ? { status: 'done' } : null; // owner.mission's own first check
      },
      conditionFetch: async () => ({}),
      sandbox: async () => ({ ok: true, value: false }),
      notify: async () => undefined,
    });
    const report = await s.tick();
    expect(report).toMatchObject({ claimed: 1, missions: 0 });
    const [t] = await trigs(a.agentId);
    expect(t!.last_fired_at).toBeNull(); // a declined run is not stamped as fired
    expect(t!.next_run_at.getTime()).toBeGreaterThan(Date.now());
  });
  it('resume schedules from the DB clock: a skewed process clock moves nothing', async () => {
    const a = await withTriggers(cron, condition);
    await makeDue(a.agentId, '3 days');
    await agents().pause(a.userId, a.agentId);
    setSystemTime(new Date(Date.now() + 30 * 86_400_000)); // process clock a month ahead of the database
    try {
      await agents().resume(a.userId, a.agentId);
    } finally {
      setSystemTime();
    }
    const dbNow = ((await sql`select now() as t`) as { t: Date }[])[0]!.t;
    for (const t of await trigs(a.agentId)) {
      expect(t.next_run_at.getTime()).toBeLessThanOrEqual(dbNow.getTime() + 15 * 60_000);
      if (t.kind === 'condition') expect(t.next_run_at.getTime()).toBeLessThanOrEqual(dbNow.getTime() + 5_000);
    }
  });

  it('pause racing the claim of a condition trigger does not consume the cooldown', async () => {
    const a = await withTriggers(condition);
    await makeDue(a.agentId);
    let paused = false;
    const s = createScheduler({
      sql,
      killed: () => false,
      mission: async (agentId) => {
        if (agentId !== a.agentId) return { status: 'done' }; // other tests' leftovers in this shared database
        paused = true;
        await agents().pause(a.userId, agentId);
        return null; // owner.mission: the agent is no longer active
      },
      conditionFetch: async () => ({}),
      sandbox: async () => ({ ok: true, value: true }), // the condition holds
      notify: async () => undefined,
    });
    await s.tick();
    expect(paused).toBe(true); // this agent's trigger was claimed and its mission declined
    const [t] = await trigs(a.agentId);
    expect(t!.last_fired_at).toBeNull(); // a declined run does not start the cooldown
    expect(t!.error_streak).toBe(0);
    await agents().resume(a.userId, a.agentId);
    // Resumed and due again: with no cooldown consumed the next tick fires it.
    await makeDue(a.agentId);
    const before = missions.length;
    const fireNow = createScheduler({
      sql,
      killed: () => false,
      mission: async (agentId) => (missions.push(agentId), { status: 'done' }),
      conditionFetch: async () => ({}),
      sandbox: async () => ({ ok: true, value: true }),
      notify: async () => undefined,
    });
    await fireNow.tick();
    expect(missions.slice(before)).toContain(a.agentId);
  });
});

describe('agents: create from a description', () => {
  let sql: Db;
  let drop: () => Promise<void>;
  beforeAll(async () => ({ sql, drop } = await freshDb()));
  afterAll(() => drop());

  it('the scheduler does not claim the new agent\'s triggers until it is active', async () => {
    const userId = await insertUser(sql);
    const { id } = await createAgents(sql).create(userId, 'Scout', minimalSpec({ triggers: [{ kind: 'cron', cron: '*/15 * * * *', mission: 'Report XLM.' }] }));
    await sql`update app.triggers set next_run_at = now() - interval '1 minute' where agent_id = ${id}`;
    const missions: string[] = [];
    const scheduler = createScheduler({
      sql,
      killed: () => false,
      mission: async (agentId) => (missions.push(agentId), { status: 'done' }),
      conditionFetch: async () => ({}),
      sandbox: async () => ({ ok: true, value: false }),
      notify: async () => undefined,
    });
    expect((await scheduler.tick()).claimed).toBe(0);
    expect(missions).toEqual([]);
    await sql`update app.agents set status = 'active' where id = ${id}`;
    expect((await scheduler.tick()).claimed).toBe(1);
    expect(missions).toEqual([id]);
  });

  it('without a key, a second agent for the same user is agent_exists and leaves one agent and one spec', async () => {
    const userId = await insertUser(sql);
    await createAgents(sql).create(userId, 'One', minimalSpec());
    await expect(createAgents(sql).create(userId, 'Two', minimalSpec())).rejects.toMatchObject({ status: 409, code: 'agent_exists' });
    const [r] = (await sql`select (select count(*)::int from app.agents where user_id = ${userId}) as a, (select count(*)::int from app.agent_specs s join app.agents g on g.id = s.agent_id where g.user_id = ${userId}) as s`) as { a: number; s: number }[];
    expect(r).toEqual({ a: 1, s: 1 });
  });

  it('with keys: several agents up to the live limit; over it 409 agent_limit leaves nothing behind', async () => {
    const userId = await insertUser(sql);
    // The platform sponsors the first: the second is the one unfunded agent FEE_MODEL=sponsor allows.
    const agents = createAgents(sql, { limits: { live: 2, perDay: 5 }, feeModel: 'sponsor' });
    const one = await agents.create(userId, 'One', minimalSpec(), undefined, crypto.randomUUID());
    const two = await agents.create(userId, 'Two', minimalSpec(), undefined, crypto.randomUUID());
    expect([one.resumed, two.resumed]).toEqual([false, false]);
    await expect(agents.create(userId, 'Three', minimalSpec(), undefined, crypto.randomUUID())).rejects.toMatchObject({ status: 409, code: 'agent_limit' });
    const [r] = (await sql`select (select count(*)::int from app.agents where user_id = ${userId}) as a, (select count(*)::int from app.agent_specs s join app.agents g on g.id = s.agent_id where g.user_id = ${userId}) as s`) as { a: number; s: number }[];
    expect(r).toEqual({ a: 2, s: 2 });
  });

  it('an account limit (app.users.agent_limit) replaces the live ceiling and lifts the daily one, for that account only', async () => {
    const agents = createAgents(sql, { limits: { live: 1, perDay: 1 }, feeModel: 'sponsor' });
    const userId = await insertUser(sql);
    await sql`update app.users set agent_limit = 3 where id = ${userId}`;
    await agents.create(userId, 'One', minimalSpec(), undefined, crypto.randomUUID());
    const two = await agents.create(userId, 'Two', minimalSpec(), undefined, crypto.randomUUID());
    await sql`update app.agents set reserve_state = 'self_paid' where id = ${two.id}`;
    await agents.create(userId, 'Three', minimalSpec(), undefined, crypto.randomUUID());
    await expect(agents.create(userId, 'Four', minimalSpec(), undefined, crypto.randomUUID())).rejects.toMatchObject({ status: 409, code: 'agent_limit' });
    const plain = await insertUser(sql);
    await agents.create(plain, 'One', minimalSpec(), undefined, crypto.randomUUID());
    await expect(agents.create(plain, 'Two', minimalSpec(), undefined, crypto.randomUUID())).rejects.toMatchObject({ status: 409, code: 'agent_limit' });
  });

  it('with keys: a paused agent holds its slot; the same key answers the agent it made, even at the limit', async () => {
    const userId = await insertUser(sql);
    const agents = createAgents(sql, { limits: { live: 1, perDay: 5 } });
    const key = crypto.randomUUID();
    const one = await agents.create(userId, 'One', minimalSpec(), undefined, key);
    await sql`update app.agents set status = 'paused' where id = ${one.id}`;
    await expect(agents.create(userId, 'Two', minimalSpec(), undefined, crypto.randomUUID())).rejects.toMatchObject({ status: 409, code: 'agent_limit' });
    expect(await agents.create(userId, 'One', minimalSpec(), undefined, key)).toEqual({ id: one.id, resumed: true });
  });
});

describe('agents: the morning note answer', () => {
  let sql: Db;
  let drop: () => Promise<void>;
  beforeAll(async () => ({ sql, drop } = await freshDb()));
  afterAll(() => drop());
  const answer = async (id: string) => ((await sql`select morning_note from app.agents where id = ${id}`) as { morning_note: boolean | null }[])[0]!.morning_note;

  it('starts unanswered, stores yes and no, and can change its mind', async () => {
    const a = await activeAgent(sql);
    expect(await answer(a.agentId)).toBeNull();
    await createAgents(sql).setMorningNote(a.userId, a.agentId, true);
    expect(await answer(a.agentId)).toBe(true);
    await createAgents(sql).setMorningNote(a.userId, a.agentId, false);
    expect(await answer(a.agentId)).toBe(false);
  });

  it("another user's or an unknown agent is a 404 and nothing changes", async () => {
    const a = await activeAgent(sql);
    const b = await activeAgent(sql);
    await expect(createAgents(sql).setMorningNote(b.userId, a.agentId, true)).rejects.toMatchObject({ status: 404 });
    await expect(createAgents(sql).setMorningNote(a.userId, crypto.randomUUID(), true)).rejects.toMatchObject({ status: 404 });
    expect(await answer(a.agentId)).toBeNull();
  });
});

describe('agents: the model the owner picks', () => {
  let sql: Db;
  let drop: () => Promise<void>;
  beforeAll(async () => ({ sql, drop } = await freshDb()));
  afterAll(() => drop());
  const model = async (id: string) => ((await sql`select model from app.agents where id = ${id}`) as { model: string | null }[])[0]!.model;

  it('starts on the default, stores a listed pick, and goes back to the default with null', async () => {
    const a = await activeAgent(sql);
    expect(await model(a.agentId)).toBeNull();
    await createAgents(sql).setModel(a.userId, a.agentId, 'anthropic/claude-haiku-5.5');
    expect(await model(a.agentId)).toBe('anthropic/claude-haiku-5.5');
    await createAgents(sql).setModel(a.userId, a.agentId, null);
    expect(await model(a.agentId)).toBeNull();
  });

  it('refuses a model off the list (400) and another user or an unknown agent (404); nothing changes', async () => {
    const a = await activeAgent(sql);
    const b = await activeAgent(sql);
    await expect(createAgents(sql).setModel(a.userId, a.agentId, 'openai/gpt-5.4-pro')).rejects.toMatchObject({ status: 400, code: 'bad_model' });
    await expect(createAgents(sql).setModel(b.userId, a.agentId, 'anthropic/claude-haiku-5.5')).rejects.toMatchObject({ status: 404 });
    await expect(createAgents(sql).setModel(a.userId, crypto.randomUUID(), null)).rejects.toMatchObject({ status: 404 });
    expect(await model(a.agentId)).toBeNull();
  });
});
