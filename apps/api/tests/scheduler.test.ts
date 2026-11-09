import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import type { Db } from '../src/db/index.js';
import { clip, CLAIM_LEASE_MIN, createScheduler, LOG_WAIT_MS, MAX_ERROR_STREAK, PLATFORM_RETRY_S, TICK_WORST_MS, type SchedulerDeps } from '../src/scheduler/index.js';
import { createChecks } from '../src/runs/checks.js';
import { createSpecs } from '../src/specs/index.js';
import type { TriggerSpec } from '../src/specs/schema.js';
import { runSandboxed, type SandboxResult } from '../src/tools/sandbox.js';
import { shutdownPool } from '../src/tools/isolate.js';
import { freshDb } from './support/db.js';
import { activeAgent, minimalSpec } from './support/specs.js';

interface Trig { id: string; next_run_at: Date; last_fired_at: Date | null; error_streak: number; enabled: boolean }

describe('scheduler', () => {
  let sql: Db;
  let drop: () => Promise<void>;
  beforeAll(async () => ({ sql, drop } = await freshDb()));
  afterAll(async () => {
    await shutdownPool();
    await drop();
  });

  const missions: { agentId: string; triggerId: string; text: string }[] = [];
  const notices: { agentId: string; text: string }[] = [];
  let fetchResult: unknown = { prices: { stellar: 0.4 } };
  let fetchFails = false;
  let verdict: SandboxResult = { ok: true, value: false };
  let killed = false;

  function scheduler(over: Partial<SchedulerDeps> = {}) {
    return createScheduler({
      sql,
      killed: () => killed,
      mission: async (agentId, triggerId, text) => (missions.push({ agentId, triggerId, text }), { status: 'done' }),
      conditionFetch: async () => {
        if (fetchFails) throw new Error('egress: timeout');
        return fetchResult;
      },
      sandbox: async () => verdict,
      notify: async (agentId, text) => void notices.push({ agentId, text }),
      ...over,
    });
  }

  /** An active agent with one approved trigger, made due now. Returns the trigger id. */
  async function dueTrigger(t: TriggerSpec): Promise<{ agentId: string; userId: string; id: string }> {
    const a = await activeAgent(sql);
    const specs = createSpecs(sql);
    await specs.approve(a.userId, a.agentId, await specs.saveDraft(a.userId, a.agentId, minimalSpec({ triggers: [t] })));
    const [row] = (await sql`update app.triggers set next_run_at = now() - interval '1 second' where agent_id = ${a.agentId} returning id`) as { id: string }[];
    return { ...a, id: row!.id };
  }
  const trig = async (id: string) => ((await sql`select id, next_run_at, last_fired_at, error_streak, enabled from app.triggers where id = ${id}`) as Trig[])[0]!;
  const condition = (every = 600, cooldown = 3600): TriggerSpec => ({ kind: 'condition', fetch: { tool: 'market_price', args: { ids: ['stellar'] } }, code: 'return input.prices.stellar > 0.3', every_s: every, cooldown_s: cooldown, mission: 'XLM is above 0.30.' });
  const runsOf = async (agentId: string) => ((await sql`select count(*)::int as n from app.runs where agent_id = ${agentId}`) as { n: number }[])[0]!.n;
  /** Leave no due trigger behind for the next test: each tick sees every due row in this database. */
  const park = () => sql`update app.triggers set next_run_at = now() + interval '1 day'`;

  it('fires a due cron trigger once and schedules its next run', async () => {
    const t = await dueTrigger({ kind: 'cron', cron: '*/15 * * * *', mission: 'Report XLM.' });
    const before = missions.length;
    const report = await scheduler().tick();
    expect(report).toMatchObject({ claimed: 1, missions: 1 });
    expect(missions.slice(before)).toEqual([{ agentId: t.agentId, triggerId: t.id, text: 'Report XLM.' }]);
    const row = await trig(t.id);
    // The next quarter hour after the fire time (computed from the clock just before last_fired_at was stamped).
    const next = row.next_run_at.getTime();
    expect(next).toBeGreaterThan(row.last_fired_at!.getTime() - 1_000);
    expect(next - row.last_fired_at!.getTime()).toBeLessThanOrEqual(15 * 60_000);
    expect([row.next_run_at.getUTCMinutes() % 15, row.next_run_at.getUTCSeconds()]).toEqual([0, 0]);
    expect((await scheduler().tick()).claimed).toBe(0); // not due again
    await park();
  });

  it('never claims a trigger another tick holds (FOR UPDATE SKIP LOCKED, deterministic)', async () => {
    const t = await dueTrigger({ kind: 'cron', cron: '0 * * * *', mission: 'm' });
    await sql.begin(async (tx) => {
      await tx`select id from app.triggers where id = ${t.id} for update`;
      expect((await scheduler().tick()).claimed).toBe(0); // the pool's other connection skips the locked row
    });
    expect((await scheduler().tick()).claimed).toBe(1);
    await park();
  });

  it('a false condition costs no model call and no run row', async () => {
    const t = await dueTrigger(condition(600));
    verdict = { ok: true, value: false };
    const before = missions.length;
    const report = await scheduler().tick();
    expect(report).toMatchObject({ claimed: 1, missions: 0, conditionsFalse: 1 });
    expect(missions.length).toBe(before);
    expect(await runsOf(t.agentId)).toBe(0);
    const row = await trig(t.id);
    expect(row.last_fired_at).toBeNull();
    expect(row.next_run_at.getTime() - Date.now()).toBeGreaterThan(590_000);
    await park();
  });

  describe('check counter', () => {
    const checks: [string, string][] = [];
    const record = async (a: string, k: 'quiet' | 'fired') => void checks.push([a, k]);
    const mine = (agentId: string) => checks.filter(([a]) => a === agentId).map(([, k]) => k);

    it('a false condition records one quiet check, zero tokens', async () => {
      const t = await dueTrigger(condition(600));
      verdict = { ok: true, value: false };
      await scheduler({ recordCheck: record }).tick();
      expect(mine(t.agentId)).toEqual(['quiet']);
      expect(await runsOf(t.agentId)).toBe(0);
      await park();
    });

    it('a true condition and a cron fire record fired', async () => {
      const c = await dueTrigger(condition(600, 3600));
      verdict = { ok: true, value: true };
      const k = await dueTrigger({ kind: 'cron', cron: '*/15 * * * *', mission: 'Report XLM.' });
      await scheduler({ recordCheck: record }).tick();
      expect(mine(c.agentId)).toEqual(['fired']);
      expect(mine(k.agentId)).toEqual(['fired']);
      await park();
      verdict = { ok: true, value: false };
    });

    it('a cooldown skip records nothing', async () => {
      const t = await dueTrigger(condition(600, 3600));
      await sql`update app.triggers set last_fired_at = now() where id = ${t.id}`;
      await scheduler({ recordCheck: record }).tick();
      expect(mine(t.agentId)).toEqual([]);
      await park();
    });

    it('a fetch failure, a sandbox fault, a code error and a declined mission record nothing', async () => {
      const fetchFail = await dueTrigger(condition(600));
      await scheduler({ recordCheck: record, conditionFetch: async () => Promise.reject(new Error('egress: timeout')) }).tick();
      const fault = await dueTrigger(condition(600));
      await scheduler({ recordCheck: record, sandbox: async () => ({ ok: false, error: 'busy', fault: 'platform' }) }).tick();
      const codeErr = await dueTrigger(condition(600));
      await scheduler({ recordCheck: record, sandbox: async () => ({ ok: false, error: 'nope', fault: 'code' }) }).tick();
      const declined = await dueTrigger({ kind: 'cron', cron: '*/15 * * * *', mission: 'Report XLM.' });
      await scheduler({ recordCheck: record, mission: async () => null }).tick();
      for (const t of [fetchFail, fault, codeErr, declined]) expect(mine(t.agentId)).toEqual([]);
      await park();
    });

    it('a throwing recordCheck does not change the tick report, and logs only a fixed event', async () => {
      const t = await dueTrigger(condition(600));
      verdict = { ok: true, value: false };
      const events: Record<string, string | number>[] = [];
      const report = await scheduler({ recordCheck: async () => Promise.reject(new Error('secret db detail')), log: (e) => void events.push(e) }).tick();
      expect(report).toMatchObject({ claimed: 1, conditionsFalse: 1, errors: 0 });
      expect(events.filter((e) => e.agent === t.agentId)).toEqual([{ event: 'check_record_failed', agent: t.agentId, trigger: t.id }]);
      expect(JSON.stringify(events)).not.toContain('secret');
      await park();
    });
  });

  describe('check log', () => {
    type Entry = { triggerId: string; held: boolean | null; reading: unknown };
    const logged: [string, Entry][] = [];
    const logCheck = async (a: string, e: Entry) => void logged.push([a, e]);
    const mine = (agentId: string) => logged.filter(([a]) => a === agentId).map(([, e]) => e);
    const price = { prices: { stellar: 0.1913 }, source: 'defillama' };

    it('a quiet check logs held false with the reading', async () => {
      const t = await dueTrigger(condition(600));
      verdict = { ok: true, value: false };
      fetchResult = price;
      await scheduler({ logCheck }).tick();
      expect(mine(t.agentId)).toEqual([{ triggerId: t.id, held: false, reading: { symbol: 'XLM', price: 0.1913 } }]);
      await park();
    });

    it('a fired check logs held true with the reading', async () => {
      const t = await dueTrigger(condition(600));
      verdict = { ok: true, value: true };
      fetchResult = price;
      await scheduler({ logCheck }).tick();
      expect(mine(t.agentId)).toEqual([{ triggerId: t.id, held: true, reading: { symbol: 'XLM', price: 0.1913 } }]);
      await park();
      verdict = { ok: true, value: false };
    });

    it('a failed fetch and a sandbox error log held null and reading null; a cooldown skip and a cron fire log nothing', async () => {
      const fetchFail = await dueTrigger(condition(600));
      await scheduler({ logCheck, conditionFetch: async () => Promise.reject(new Error('egress: timeout')) }).tick();
      const codeErr = await dueTrigger(condition(600));
      fetchResult = price;
      await scheduler({ logCheck, sandbox: async () => ({ ok: false, error: 'nope', fault: 'code' }) }).tick();
      const fault = await dueTrigger(condition(600));
      await scheduler({ logCheck, sandbox: async () => ({ ok: false, error: 'busy', fault: 'platform' }) }).tick();
      const cooling = await dueTrigger(condition(600, 3600));
      await sql`update app.triggers set last_fired_at = now() where id = ${cooling.id}`;
      await scheduler({ logCheck }).tick();
      const cron = await dueTrigger({ kind: 'cron', cron: '*/15 * * * *', mission: 'Report XLM.' });
      await scheduler({ logCheck }).tick();
      expect(mine(fetchFail.agentId)).toEqual([{ triggerId: fetchFail.id, held: null, reading: null }]);
      expect(mine(codeErr.agentId)).toEqual([{ triggerId: codeErr.id, held: null, reading: null }]);
      expect(mine(fault.agentId)).toEqual([{ triggerId: fault.id, held: null, reading: null }]);
      expect(mine(cooling.agentId)).toEqual([]);
      expect(mine(cron.agentId)).toEqual([]);
      await park();
    });

    it('unexpected data still logs the check, with a null reading', async () => {
      const t = await dueTrigger(condition(600));
      verdict = { ok: true, value: false };
      fetchResult = 'not an object';
      await scheduler({ logCheck }).tick();
      expect(mine(t.agentId)).toEqual([{ triggerId: t.id, held: false, reading: null }]);
      await park();
      fetchResult = { prices: { stellar: 0.4 } };
    });

    it('a slow logCheck never delays the fire or the reschedule', async () => {
      const t = await dueTrigger(condition(600));
      verdict = { ok: true, value: true };
      fetchResult = price;
      let logDone = false;
      let logDoneAtMission = null as boolean | null;
      const slowLog = () => new Promise<void>((r) => setTimeout(() => ((logDone = true), r()), 800));
      const before = Date.now();
      await scheduler({
        logCheck: slowLog,
        mission: async () => ((logDoneAtMission = logDone), { status: 'done' }),
      }).tick();
      expect(logDoneAtMission).toBe(false); // the mission started while the insert was still pending
      expect(logDone).toBe(true); // and the tick still waited for it before returning
      expect(Date.now() - before).toBeGreaterThanOrEqual(700);
      expect((await trig(t.id)).next_run_at.getTime() - Date.now()).toBeGreaterThan(590_000);
      await park();
      verdict = { ok: true, value: false };
    });

    it('a logCheck that never resolves delays the tick by at most LOG_WAIT_MS, and the fire and reschedule still happen', async () => {
      const t = await dueTrigger(condition(600));
      verdict = { ok: true, value: true };
      fetchResult = price;
      const before = missions.length;
      const t0 = Date.now();
      await scheduler({ logCheck: () => new Promise<void>(() => undefined) }).tick();
      expect(Date.now() - t0).toBeLessThan(LOG_WAIT_MS + 5_000);
      expect(missions.length).toBe(before + 1);
      const row = await trig(t.id);
      expect(row.last_fired_at).toBeInstanceOf(Date);
      expect(row.next_run_at.getTime() - Date.now()).toBeGreaterThan(590_000);
      await park();
      verdict = { ok: true, value: false };
    });

    it('a throwing logCheck never breaks the tick and logs only a fixed event', async () => {
      const t = await dueTrigger(condition(600));
      verdict = { ok: true, value: true };
      fetchResult = price;
      const events: Record<string, string | number>[] = [];
      const before = missions.length;
      const report = await scheduler({ logCheck: async () => Promise.reject(new Error('secret db detail')), log: (e) => void events.push(e) }).tick();
      expect(report).toMatchObject({ claimed: 1, missions: 1, errors: 0 });
      expect(missions.length).toBe(before + 1);
      expect(events.filter((e) => e.agent === t.agentId)).toEqual([{ event: 'check_log_failed', agent: t.agentId, trigger: t.id }]);
      expect(JSON.stringify(events)).not.toContain('secret');
      await park();
      verdict = { ok: true, value: false };
    });

    it('the real log lands in app.check_log, and each tick prunes (a throwing prune is swallowed)', async () => {
      const checks = createChecks(sql);
      const t = await dueTrigger(condition(600));
      verdict = { ok: true, value: false };
      fetchResult = price;
      await sql`insert into app.check_log (agent_id, at, held) values (${t.agentId}, now() - interval '8 days', true)`;
      await scheduler({ logCheck: (a, e) => checks.log(a, e), pruneChecks: () => checks.prune() }).tick();
      const rows = (await sql`select held, reading, at > now() - interval '1 minute' as fresh from app.check_log where agent_id = ${t.agentId}`) as { held: boolean; reading: unknown; fresh: boolean }[];
      expect(rows).toEqual([{ held: false, reading: { symbol: 'XLM', price: 0.1913 }, fresh: true }]);
      const events: Record<string, string | number>[] = [];
      const report = await scheduler({ pruneChecks: () => Promise.reject(new Error('secret db detail')), log: (e) => void events.push(e) }).tick();
      expect(report.claimed).toBe(0);
      expect(events).toEqual([{ event: 'check_prune_failed' }]);
      await park();
    });

    it('a prune that never resolves holds the tick at most LOG_WAIT_MS', async () => {
      const t0 = Date.now();
      await scheduler({ pruneChecks: () => new Promise(() => {}) }).tick();
      expect(Date.now() - t0).toBeLessThan(LOG_WAIT_MS + 2_000);
    }, LOG_WAIT_MS + 10_000);
  });

  it('a fired mission carries the person\'s settings, so the model never invents its own', async () => {
    await dueTrigger({ ...condition(600, 3600), params: { above: 0.3 }, code: 'return input.prices.stellar > params.above' } as TriggerSpec);
    verdict = { ok: true, value: true };
    fetchResult = { prices: { stellar: 0.42 } };
    const before = missions.length;
    await scheduler().tick();
    expect(missions.slice(before)[0]!.text).toContain("The person's settings, already applied by the check: above = 0.3.");
    await park();
  });

  it('a true condition fires the mission with the data, then the cooldown holds it back', async () => {
    const t = await dueTrigger(condition(600, 3600));
    verdict = { ok: true, value: true };
    fetchResult = { prices: { stellar: 0.42 } };
    const before = missions.length;
    expect(await scheduler().tick()).toMatchObject({ missions: 1 });
    const fired = missions.slice(before);
    expect(fired.length).toBe(1);
    expect(fired[0]!.text).toStartWith('XLM is above 0.30.\n\nThe condition held.');
    expect(fired[0]!.text).toContain('{"prices":{"stellar":0.42}}');
    expect((await trig(t.id)).last_fired_at).toBeInstanceOf(Date);
    await sql`update app.triggers set next_run_at = now() - interval '1 second' where id = ${t.id}`;
    expect(await scheduler().tick()).toMatchObject({ claimed: 1, missions: 0, cooldowns: 1 });
    expect(missions.length).toBe(before + 1);
    await park();
  });

  it(`three code errors in a row disable the trigger and notify the owner once`, async () => {
    const t = await dueTrigger(condition(300));
    verdict = { ok: false, error: 'nope', fault: 'code' };
    for (let i = 1; i <= MAX_ERROR_STREAK; i++) {
      await sql`update app.triggers set next_run_at = now() - interval '1 second' where id = ${t.id}`;
      expect(await scheduler().tick()).toMatchObject({ errors: 1 });
      expect((await trig(t.id)).error_streak).toBe(i);
    }
    expect((await trig(t.id)).enabled).toBe(false);
    expect(notices.filter((n) => n.agentId === t.agentId).length).toBe(1);
    await sql`update app.triggers set next_run_at = now() - interval '1 second' where id = ${t.id}`;
    expect((await scheduler().tick()).claimed).toBe(0); // disabled
    verdict = { ok: true, value: false };
  });

  it('a non-boolean result counts as a code error; a fetch failure does not', async () => {
    const t = await dueTrigger(condition(300));
    verdict = { ok: true, value: 'yes' };
    await scheduler().tick();
    expect((await trig(t.id)).error_streak).toBe(1);
    await sql`update app.triggers set next_run_at = now() - interval '1 second' where id = ${t.id}`;
    fetchFails = true;
    try {
      expect(await scheduler().tick()).toMatchObject({ errors: 1 });
    } finally {
      fetchFails = false;
    }
    expect((await trig(t.id)).error_streak).toBe(1);
    expect((await trig(t.id)).next_run_at.getTime()).toBeGreaterThan(Date.now());
    verdict = { ok: true, value: false };
    await park();
  });

  it('claims nothing under the kill switch, for an inactive agent, or for a stale spec version', async () => {
    const t = await dueTrigger({ kind: 'cron', cron: '0 * * * *', mission: 'm' });
    killed = true;
    try {
      expect((await scheduler().tick()).claimed).toBe(0);
    } finally {
      killed = false;
    }
    await sql`update app.agents set status = 'provisioning' where id = ${t.agentId}`;
    expect((await scheduler().tick()).claimed).toBe(0);
    await sql`update app.agents set status = 'active', active_spec_version = 99 where id = ${t.agentId}`;
    expect((await scheduler().tick()).claimed).toBe(0);
    await sql`update app.agents set active_spec_version = 1 where id = ${t.agentId}`;
    expect((await scheduler().tick()).claimed).toBe(1);
    await park();
  });

  it('claims nothing for a revoked agent: no fetch, no sandbox, no mission', async () => {
    const t = await dueTrigger(condition(600));
    await sql`update app.agents set status = 'revoked' where id = ${t.agentId}`;
    let calls = 0;
    const s = scheduler({
      mission: async () => (calls++, { status: 'done' }),
      conditionFetch: async () => (calls++, {}),
      sandbox: async () => (calls++, { ok: true, value: true }),
    });
    expect(await s.tick()).toMatchObject({ claimed: 0 });
    expect(calls).toBe(0);
    await park();
  });

  it('a mission that declines (null) is skipped: no last_fired_at, rescheduled, not counted as a mission', async () => {
    const t = await dueTrigger({ kind: 'cron', cron: '0 * * * *', mission: 'm' });
    const report = await scheduler({ mission: async () => null }).tick();
    expect(report).toMatchObject({ claimed: 1, missions: 0, errors: 1 });
    const row = await trig(t.id);
    expect(row.last_fired_at).toBeNull();
    expect(row.next_run_at.getTime()).toBeGreaterThan(Date.now());
    await park();
  });

  it('a mission is judged by status, not text: a non-done run is not counted as a mission but is stamped', async () => {
    const t = await dueTrigger({ kind: 'cron', cron: '0 * * * *', mission: 'm' });
    const report = await scheduler({ mission: async () => ({ status: 'error', text: 'partial answer' }) as { status: string } }).tick();
    expect(report).toMatchObject({ missions: 0, errors: 1 });
    expect((await trig(t.id)).last_fired_at).toBeInstanceOf(Date);
    await park();
  });

  it('a sandbox platform fault (busy, unavailable) never grows the error streak or disables; retried soon', async () => {
    const t = await dueTrigger(condition(600));
    for (const error of ['busy', 'unavailable', 'aborted', 'error']) {
      await sql`update app.triggers set next_run_at = now() - interval '1 second' where id = ${t.id}`;
      expect(await scheduler({ sandbox: async () => ({ ok: false, error, fault: 'platform' }) }).tick()).toMatchObject({ errors: 1, missions: 0 });
      const row = await trig(t.id);
      expect(row.error_streak).toBe(0);
      expect(row.enabled).toBe(true);
      const wait = row.next_run_at.getTime() - Date.now();
      expect(wait).toBeGreaterThan(0);
      expect(wait).toBeLessThanOrEqual(PLATFORM_RETRY_S * 1000);
    }
    expect(notices.filter((n) => n.agentId === t.agentId).length).toBe(0);
    await park();
  });

  it('a killed sandbox (code ran too long) is the owner code failing and counts toward the streak', async () => {
    const t = await dueTrigger(condition(600));
    await scheduler({ sandbox: async () => ({ ok: false, error: 'killed', fault: 'code' }) }).tick();
    expect((await trig(t.id)).error_streak).toBe(1);
    await park();
  });

  it('owner code that throws "busy" is a code error: the streak builds and the trigger is disabled (real sandbox)', async () => {
    const t = await dueTrigger({ ...condition(300), code: 'throw new Error("busy")' } as TriggerSpec);
    for (let i = 1; i <= MAX_ERROR_STREAK; i++) {
      await sql`update app.triggers set next_run_at = now() - interval '1 second' where id = ${t.id}`;
      expect(await scheduler({ sandbox: runSandboxed }).tick()).toMatchObject({ errors: 1 });
      const row = await trig(t.id);
      expect(row.error_streak).toBe(i);
      if (i < MAX_ERROR_STREAK) expect(row.next_run_at.getTime() - Date.now()).toBeGreaterThan(250_000); // every_s, not the 60 s platform retry
    }
    expect((await trig(t.id)).enabled).toBe(false);
    expect(notices.filter((n) => n.agentId === t.agentId).length).toBe(1);
  }, 30_000);

  describe('condition params', () => {
    const withParams = (params: Record<string, number | string | boolean> | undefined, code: string): TriggerSpec => ({ ...condition(600, 3600), code, ...(params ? { params } : {}) }) as TriggerSpec;

    it('the scheduler passes frozen params into the condition', async () => {
      await dueTrigger(withParams({ x: 7 }, 'params.x = 9; params.y = 1; return params.x === 7 && !("y" in params) && Object.isFrozen(params)'));
      const before = missions.length;
      expect(await scheduler({ sandbox: runSandboxed }).tick()).toMatchObject({ missions: 1, errors: 0 });
      expect(missions.length).toBe(before + 1);
      await park();
    });

    it('the sandbox receives the stored params; a spec without params gets none', async () => {
      const seen: unknown[] = [];
      const spy = async (_c: string, _i: unknown, o?: { params?: unknown }) => (seen.push(o?.params), { ok: true, value: false } as SandboxResult);
      await dueTrigger(withParams({ x: 7, s: 'a' }, 'return false'));
      await scheduler({ sandbox: spy }).tick();
      await dueTrigger(withParams(undefined, 'return false'));
      await scheduler({ sandbox: spy }).tick();
      expect(seen).toEqual([{ x: 7, s: 'a' }, undefined]);
      await park();
    });

    it('a spec without params still parses and runs', async () => {
      await dueTrigger(withParams(undefined, 'return typeof params === "undefined" && input.prices.stellar > 0.3'));
      const before = missions.length;
      expect(await scheduler({ sandbox: runSandboxed }).tick()).toMatchObject({ missions: 1 });
      expect(missions.length).toBe(before + 1);
      await park();
    });

    it('the stored condition of a no-params spec has no params key (history keeps its identity)', async () => {
      const t = await dueTrigger(withParams(undefined, 'return false'));
      const [row] = (await sql`select condition from app.triggers where id = ${t.id}`) as { condition: Record<string, unknown> }[];
      expect(Object.keys(row!.condition).sort()).toEqual(['code', 'every_s', 'fetch']);
      await park();
    });
  });

  it('a cooling condition skips the fetch and the sandbox, and keeps its streak', async () => {
    const t = await dueTrigger(condition(600, 3600));
    await sql`update app.triggers set last_fired_at = now(), error_streak = 2 where id = ${t.id}`;
    let calls = 0;
    const report = await scheduler({ conditionFetch: async () => (calls++, {}), sandbox: async () => (calls++, { ok: true, value: true }) }).tick();
    expect(report).toMatchObject({ claimed: 1, cooldowns: 1, missions: 0 });
    expect(calls).toBe(0);
    const row = await trig(t.id);
    expect(row.error_streak).toBe(2);
    expect(row.next_run_at.getTime() - Date.now()).toBeGreaterThan(590_000);
    await park();
  });

  it('a cron fires exactly once even when the process clock runs behind the database (DB clock only)', async () => {
    const t = await dueTrigger({ kind: 'cron', cron: '*/15 * * * *', mission: 'm' });
    // An every-second cron (set directly) due on a slot 1 s ago: a JS clock 2 s behind computes that slot again.
    const [slot] = (await sql`update app.triggers set cron_expr = '* * * * * *', next_run_at = date_trunc('second', now()) - interval '1 second' where id = ${t.id} returning next_run_at`) as { next_run_at: Date }[];
    const before = missions.length;
    // Really skew the JS clock: Date.now() and the argless constructor run 2 s behind (restored in finally).
    const RealDate = Date;
    const SKEW_MS = 2_000;
    const SkewedDate = new Proxy(RealDate, {
      construct: (target, args) => Reflect.construct(target, args.length === 0 ? [RealDate.now() - SKEW_MS] : args),
      get: (target, prop, receiver) => (prop === 'now' ? () => RealDate.now() - SKEW_MS : Reflect.get(target, prop, receiver)),
    });
    let report: Awaited<ReturnType<ReturnType<typeof scheduler>['tick']>>;
    globalThis.Date = SkewedDate;
    try {
      expect(Date.now()).toBeLessThan(RealDate.now() - SKEW_MS + 500);
      report = await scheduler().tick();
    } finally {
      globalThis.Date = RealDate;
    }
    expect(report).toMatchObject({ claimed: 1, missions: 1 });
    expect(missions.length).toBe(before + 1);
    expect((await trig(t.id)).next_run_at.getTime()).toBeGreaterThan(slot!.next_run_at.getTime());
    await park();
  });

  it('the claim lease outlasts the worst tick, and a long data string is cut without splitting a surrogate pair', () => {
    expect(CLAIM_LEASE_MIN * 60_000).toBeGreaterThan(TICK_WORST_MS);
    const s = 'a'.repeat(7) + '\u{1F600}'; // 7 units + a pair (units 7 and 8)
    expect(clip(s, 8)).toBe('a'.repeat(7)); // the cut would split the pair: drop it whole
    expect(clip(s, 9)).toBe(s);
    expect(clip('abc', 2)).toBe('ab');
  });

  it('runs at most CONCURRENCY fires at once and refills a slot as soon as one finishes', async () => {
    for (let i = 0; i < 6; i++) await dueTrigger({ kind: 'cron', cron: '0 * * * *', mission: 'm' });
    let active = 0;
    let peak = 0;
    const s = scheduler({
      mission: async () => {
        peak = Math.max(peak, ++active);
        await Bun.sleep(20);
        active--;
        return { status: 'done' };
      },
    });
    expect(await s.tick()).toMatchObject({ claimed: 6, missions: 6 });
    expect(peak).toBe(4);
    await park();
  });

  it('start ticks on an interval until stopped, and exposes the tick in flight', async () => {
    let ticks = 0;
    const s = scheduler({ killed: () => (ticks++, true) });
    const stop = s.start(5);
    await Bun.sleep(40);
    stop();
    const seen = ticks;
    expect(seen).toBeGreaterThan(1);
    await Bun.sleep(20);
    expect(ticks).toBe(seen);
    expect(Array.isArray(s.inflight())).toBe(true);
  });

  it('does not claim the triggers of a paused agent, and claims them again once it is active', async () => {
    const t = await dueTrigger({ kind: 'cron', cron: '*/15 * * * *', mission: 'Report XLM.' });
    await sql`update app.agents set status = 'paused' where id = ${t.agentId}`;
    const before = missions.length;
    expect((await scheduler().tick()).claimed).toBe(0);
    expect(missions.length).toBe(before);
    const row = await trig(t.id);
    expect(row.next_run_at.getTime()).toBeLessThan(Date.now()); // still overdue, untouched
    await sql`update app.agents set status = 'active' where id = ${t.agentId}`;
    expect((await scheduler().tick()).claimed).toBe(1);
    await park();
  });
});
