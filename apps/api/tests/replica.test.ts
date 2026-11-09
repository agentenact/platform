import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { SQL } from 'bun';
import {
  deployStamp,
  HANDOVER_CLASS,
  HANDOVER_WAIT_MS,
  INSTANCE_CLASS,
  joinReplicas,
  LEADER_KEY,
  REPLICA_JOIN_FAILED,
  SINGLE_REPLICA_KEY,
  SPONSOR_KEY,
  STAMP_EPOCH_MS,
  stampOf,
  startLeadership,
  startLockHeartbeat,
  type ReplicaSession,
} from '../src/db/index.js';
import { createLeases, createMemoryLeases } from '../src/db/leases.js';
import { createAdvisoryCrossLock } from '../src/chain/lock.js';
import { createDbRateLimiter, pruneRateWindows } from '../src/gateway/rate-limit.js';
import { CRITICAL_GRACE_MS, LAME_DUCK_MS, SHUTDOWN_STEP_MS } from '../src/lifecycle.js';
import { freshDb } from './support/db.js';

const INT4_MAX = 0x7fffffff;

describe('deploy stamp', () => {
  it('reads SERVEL_DEPLOY_TIME (RFC3339) as seconds since 2026-01-01, inside int4', () => {
    const s = deployStamp('2026-10-26T20:15:03Z', 0);
    expect(s).toEqual({ stamp: Math.floor((Date.parse('2026-10-26T20:15:03Z') - STAMP_EPOCH_MS) / 1000), source: 'deploy_time' });
    expect(deployStamp('2026-10-26T20:15:04Z', 0).stamp).toBe(s.stamp + 1);
    expect(deployStamp('2026-10-26T22:15:04+02:00', 0).stamp).toBe(s.stamp + 1);
    expect(deployStamp('2090-01-01T00:00:00Z', 0).stamp).toBeLessThanOrEqual(INT4_MAX);
  });

  it('falls back to the process start time (and says so) when the value is missing or not RFC3339', () => {
    const start = Date.parse('2026-10-26T20:00:00Z');
    for (const raw of [undefined, '', 'now', '1729973703', '2026-10-26']) expect(deployStamp(raw, start)).toEqual({ stamp: stampOf(start), source: 'process_start' });
  });

  it('clamps to [1, int4 max]', () => {
    expect(stampOf(0)).toBe(1);
    expect(stampOf(Number.MAX_SAFE_INTEGER)).toBe(INT4_MAX);
  });

  it('keys: distinct, int4, and INSTANCE_CLASS matches app.instance_alive in migration 0027', async () => {
    const keys = [SINGLE_REPLICA_KEY, HANDOVER_CLASS, LEADER_KEY, INSTANCE_CLASS, SPONSOR_KEY];
    expect(new Set(keys).size).toBe(keys.length);
    for (const k of keys) expect(k).toBeLessThanOrEqual(INT4_MAX);
    const migration = await Bun.file(new URL('../../../migrations/0027_replicas.sql', import.meta.url)).text();
    expect(migration).toContain(`classid::int8 = ${INSTANCE_CLASS}`);
  });
});

describe('servel.yaml: replicas and the drain', () => {
  it('runs 2 replicas; stop_grace_period outlasts the lame duck, CRITICAL_GRACE_MS and every bounded step; start_period covers a D12 handover', async () => {
    const yaml = await Bun.file(new URL('../servel.yaml', import.meta.url)).text();
    expect(/^replicas:\s*2\s*$/m.test(yaml)).toBe(true);
    const m = /^stop_grace_period:\s*(\d+)s\s*$/m.exec(yaml);
    expect(m).not.toBeNull();
    expect(Number(m![1]) * 1000).toBeGreaterThanOrEqual(LAME_DUCK_MS + CRITICAL_GRACE_MS + 4 * SHUTDOWN_STEP_MS + 10_000);
    const start = /^\s+start_period:\s*(\d+)s\s*$/m.exec(yaml);
    expect(Number(start![1]) * 1000).toBeGreaterThanOrEqual(HANDOVER_WAIT_MS);
    expect(yaml).toMatch(/order: start-first/);
  });
});

/** Waits until `cond` holds, polling. */
const until = async (cond: () => Promise<boolean> | boolean, ms = 10_000, what = 'condition') => {
  const end = Date.now() + ms;
  while (!(await cond())) {
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
    await Bun.sleep(20);
  }
};

describe.skipIf(!process.env.TEST_DATABASE_URL)('replicas (real Postgres)', () => {
  let url: string;
  let sql: SQL;
  let drop: () => Promise<void>;
  let admin: SQL;
  const open: ReplicaSession[] = [];
  const join = async (stamp = 100, o: { timeoutMs?: number } = {}) => {
    const s = await joinReplicas(url, { stamp, pollMs: 20, ...o });
    open.push(s);
    return s;
  };
  beforeAll(async () => {
    ({ url, sql, drop } = await freshDb());
    admin = new SQL(url, { max: 1 });
  });
  afterAll(async () => {
    for (const s of open) await s.release().catch(() => undefined);
    await admin.close();
    await drop();
  });
  const alive = async (id: number) => ((await admin`select app.instance_alive(${id}) as ok`) as { ok: boolean }[])[0]!.ok;
  /** A single-replica (plan D12) instance: the exclusive lock, yielding when a handover request appears (or never). */
  const d12Holder = async (yields: boolean) => {
    const conn = new SQL(url, { max: 1, idleTimeout: 0, maxLifetime: 0 });
    expect(((await conn`select pg_try_advisory_lock(${SINGLE_REPLICA_KEY}) as ok`) as { ok: boolean }[])[0]!.ok).toBe(true);
    let stopped = false;
    const watch = (async () => {
      while (!stopped && yields) {
        const req = (await conn`select 1 from pg_locks where locktype = 'advisory' and classid::int8 = ${HANDOVER_CLASS} and objsubid = 2 and granted`) as unknown[];
        if (req.length) {
          await conn`select pg_advisory_unlock(${SINGLE_REPLICA_KEY})`;
          return;
        }
        await Bun.sleep(20);
      }
    })();
    return {
      conn,
      close: async () => {
        stopped = true;
        await watch;
        await conn.close();
      },
    };
  };

  it('replicas join side by side, each with its own live instance id; a released one is dead at once', async () => {
    const [a, b] = await Promise.all([join(), join()]);
    expect(a.instance).not.toBe(b.instance);
    expect([await alive(a.instance), await alive(b.instance)]).toEqual([true, true]);
    expect([await a.check(), await b.check()]).toEqual(['held', 'held']);
    await a.release();
    expect(await alive(a.instance)).toBe(false);
    expect(await alive(b.instance)).toBe(true);
    expect(await alive(null as unknown as number)).toBe(false); // rows from before 0027 count as dead
    await b.release();
  });

  it('a running single-replica (D12) instance is asked to hand over; the replica joins once it yields', async () => {
    const holder = await d12Holder(true);
    const s = await join(200);
    expect(await s.check()).toBe('held');
    // the request is gone once joined
    expect(((await admin`select 1 from pg_locks where locktype = 'advisory' and classid::int8 = ${HANDOVER_CLASS} and objsubid = 2`) as unknown[]).length).toBe(0);
    await holder.close();
    await s.release();
  });

  it('a D12 instance that never yields: the replica fails with the fixed message at its deadline, leaving nothing held', async () => {
    const holder = await d12Holder(false);
    const err = (await joinReplicas(url, { stamp: 300, pollMs: 20, timeoutMs: 200 }).catch((e: Error) => e)) as Error;
    expect(err.message).toBe(REPLICA_JOIN_FAILED);
    await until(async () => ((await admin`select 1 from pg_locks where locktype = 'advisory' and classid::int8 = ${HANDOVER_CLASS} and objsubid = 2`) as unknown[]).length === 0, 5_000, 'request gone');
    await holder.close();
  });

  it('a D12 instance (a rollback) can never take the exclusive lock while a replica runs', async () => {
    const s = await join();
    const conn = new SQL(url, { max: 1 });
    expect(((await conn`select pg_try_advisory_lock(${SINGLE_REPLICA_KEY}) as ok`) as { ok: boolean }[])[0]!.ok).toBe(false);
    await conn.close();
    await s.release();
  });

  it('one leader at a time; when it steps down another replica leads within its poll', async () => {
    const [a, b] = await Promise.all([join(), join()]);
    const led: number[] = [];
    const stopA = startLeadership(a, { onLead: () => void led.push(a.instance), intervalMs: 20 });
    await until(() => led.length === 1, 5_000, 'first leader');
    const stopB = startLeadership(b, { onLead: () => void led.push(b.instance), intervalMs: 20 });
    await Bun.sleep(150);
    expect(led).toEqual([a.instance]);
    expect([a.leading, b.leading]).toEqual([true, false]);
    stopA();
    await a.stepDown();
    await until(() => led.length === 2, 5_000, 'second leader');
    expect(led).toEqual([a.instance, b.instance]);
    stopB();
    await a.release();
    await b.release();
  });

  it('a leader that dies hands leadership on with its session', async () => {
    const [a, b] = await Promise.all([join(), join()]);
    expect(await a.tryLead()).toBe(true);
    expect(await b.tryLead()).toBe(false);
    await a.release();
    expect(await b.tryLead()).toBe(true);
    await b.release();
  });

  it('heartbeat: held → nothing; a killed lock session → lock_lost, exit 1 (never re-taken: the leader may have recovered its rows)', async () => {
    const s = await join();
    let tick!: () => Promise<void>;
    const exits: number[] = [];
    const events: Record<string, string | number>[] = [];
    let interval = 0;
    const stop = startLockHeartbeat(s, { every: (fn, ms) => ((tick = fn), (interval = ms), () => undefined), exit: (c) => void exits.push(c), log: (e) => events.push(e) });
    expect(interval).toBe(10_000);
    await tick();
    expect(exits).toEqual([]);
    await admin`select pg_terminate_backend(pid) from pg_locks where locktype = 'advisory' and classid::int8 = ${INSTANCE_CLASS} and objid::int8 = ${s.instance}`;
    await until(async () => !(await alive(s.instance)), 5_000, 'session gone');
    await tick();
    expect(exits).toEqual([1]);
    expect(events).toEqual([{ event: 'lock_lost' }]);
    stop();
    await s.release().catch(() => undefined);
  });

  describe('leases', () => {
    it('one holder per key; release frees it; another key is independent', async () => {
      const s = await join();
      const l = createLeases(sql, s.instance);
      const r1 = await l.take('chat:a', 60_000);
      expect(r1).not.toBeNull();
      expect(await l.take('chat:a', 60_000)).toBeNull();
      expect(await l.take('chat:b', 60_000)).not.toBeNull();
      await r1!();
      expect(await l.take('chat:a', 60_000)).not.toBeNull();
      await s.release();
    });

    it('a dead instance frees its leases at once; an expired lease is free; a stale release never drops the new holder', async () => {
      const a = await join();
      const b = await join();
      const la = createLeases(sql, a.instance);
      const lb = createLeases(sql, b.instance);
      const ra = await la.take('provision:x', 60_000);
      expect(await lb.take('provision:x', 60_000)).toBeNull();
      await a.release(); // instance a dies
      const rb = await lb.take('provision:x', 60_000);
      expect(rb).not.toBeNull();
      await ra!(); // a's late release: b keeps it
      expect(await lb.take('provision:x', 60_000)).toBeNull();
      expect(await lb.take('paid:y', 1)).not.toBeNull();
      await Bun.sleep(20);
      expect(await lb.take('paid:y', 60_000)).not.toBeNull(); // the 1 ms lease ran out
      await rb!();
      await b.release();
      expect(await createLeases(sql, 0).sweep()).toBeGreaterThanOrEqual(1);
    });

    it('memory leases keep the same contract', async () => {
      let t = 0;
      const l = createMemoryLeases(() => t);
      const r = await l.take('k', 10);
      expect(await l.take('k', 10)).toBeNull();
      t = 10;
      expect(await l.take('k', 10)).not.toBeNull();
      await r!(); // the old holder's release does not free the new one
      expect(await l.take('k', 10)).toBeNull();
    });
  });

  describe('shared rate windows', () => {
    it('two replicas count in one window per name and key; another name or key is separate; prune drops old windows', async () => {
      const a = createDbRateLimiter(sql, { name: 't.writes', limit: 2, windowMs: 60_000 });
      const b = createDbRateLimiter(sql, { name: 't.writes', limit: 2, windowMs: 60_000 });
      const other = createDbRateLimiter(sql, { name: 't.reads', limit: 2, windowMs: 60_000 });
      expect(await a.hit('u1')).toBe(0);
      expect(await b.hit('u1')).toBe(0);
      const wait = await a.hit('u1');
      expect(wait).toBeGreaterThan(0);
      expect(wait).toBeLessThanOrEqual(60);
      expect(await b.hit('u2')).toBe(0);
      expect(await other.hit('u1')).toBe(0);
      await admin`update app.rate_windows set started = now() - interval '2 days' where key = 't.writes:u1'`;
      expect(await a.hit('u1')).toBe(0); // the window ran out: it restarts at 1
      await admin`update app.rate_windows set started = now() - interval '2 days' where key = 't.reads:u1'`;
      expect(await pruneRateWindows(sql)).toBe(1);
    });

    it('a short window resets', async () => {
      const l = createDbRateLimiter(sql, { name: 't.short', limit: 1, windowMs: 200 });
      expect(await l.hit('k')).toBe(0);
      expect(await l.hit('k')).toBe(1);
      await Bun.sleep(250);
      expect(await l.hit('k')).toBe(0);
    });
  });

  describe('sponsor lock across replicas', () => {
    it('two processes hold it one at a time; a waiter past its timeout gets chain_busy; unlock lets the next in', async () => {
      const a = createAdvisoryCrossLock(url, SPONSOR_KEY);
      const b = createAdvisoryCrossLock(url, SPONSOR_KEY);
      const unlockA = await a.lock(1_000);
      const err = (await b.lock(100).catch((e: Error & { code?: string }) => e)) as Error & { code?: string };
      expect(err.code).toBe('chain_busy');
      const waiting = b.lock(5_000);
      await Bun.sleep(50);
      unlockA();
      unlockA(); // once only
      const unlockB = await waiting;
      expect(((await admin`select count(*)::int as n from pg_locks where locktype = 'advisory' and classid = 0 and objid = ${SPONSOR_KEY} and granted`) as { n: number }[])[0]!.n).toBe(1);
      unlockB();
      await Bun.sleep(50);
      expect(((await admin`select count(*)::int as n from pg_locks where locktype = 'advisory' and classid = 0 and objid = ${SPONSOR_KEY} and granted`) as { n: number }[])[0]!.n).toBe(0);
      await a.close();
      await b.close();
    });
  });
});
