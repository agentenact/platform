/**
 * Replicas (migration 0027). Every api process serves HTTP; what must happen once (the scheduler, sweeps, the
 * AgentKarma snapshot) runs on the one replica that holds the leader lock. Each process keeps ONE dedicated
 * connection (max 1, never idled out or recycled), its lock session, holding for its whole life:
 *
 * - the single-replica key 'AEC1' in SHARED mode. Plan D12's single-replica versions take it exclusively, so a process
 *   of that kind and a replica of this kind can never run side by side: a new replica asks a running D12 instance to
 *   hand over (the D12 protocol: hold (HANDOVER_CLASS, stamp)) and waits until it yields, and a D12 instance started
 *   next to replicas (a rollback) waits out its own deadline and fails its boot.
 * - (INSTANCE_CLASS, id): this process's instance id. Its liveness is that lock (app.instance_alive), so rows the
 *   process owns are recovered the moment it dies, with no heartbeat table.
 * - the leader key 'AEC3' while it leads (startLeadership).
 *
 * The lock connection is never shared with the app's pool. If it drops, every lock on it is gone: the heartbeat sees
 * that and exits, because another replica may already have recovered this process's rows as dead.
 */
import { SQL } from 'bun';

/** One-int key of plan D12's single-replica lock ('AEC1'). Replicas hold it shared; a D12 process wants it exclusive. */
export const SINGLE_REPLICA_KEY = 0x41454331;
/** Two-int class of the D12 handover request ('AEC2'): a starting replica asks a D12 holder to yield with it. */
export const HANDOVER_CLASS = 0x41454332;
/** One-int key of the leader lock ('AEC3'). */
export const LEADER_KEY = 0x41454333;
/** Two-int class of the instance locks ('AEC4'). Must match app.instance_alive in migrations/0027_replicas.sql. */
export const INSTANCE_CLASS = 0x41454334;
/** One-int key of the sponsor sequence lock ('AEC5', chain/lock.ts). */
export const SPONSOR_KEY = 0x41454335;

export const REPLICA_JOIN_FAILED = 'db: a single-replica api still holds the lock';
/** How long a starting replica waits for a D12 holder: its worst drain (lifecycle CRITICAL_GRACE_MS + steps) plus margin. */
export const HANDOVER_WAIT_MS = 240_000;

/** Stamps are seconds since 2026-01-01T00:00:00Z: second resolution, and int4 lasts until 2094. */
export const STAMP_EPOCH_MS = Date.UTC(2026, 0, 1);
const INT4_MAX = 0x7fffffff;
const RFC3339 = /^\d{4}-\d{2}-\d{2}[Tt ]\d{2}:\d{2}:\d{2}(\.\d+)?([Zz]|[+-]\d{2}:\d{2})$/;

export function stampOf(ms: number): number {
  return Math.min(INT4_MAX, Math.max(1, Math.floor((ms - STAMP_EPOCH_MS) / 1000)));
}

/**
 * This instance's deploy stamp, from SERVEL_DEPLOY_TIME (RFC3339, a servel build arg persisted by the Dockerfile).
 * Without a valid one it falls back to the process start time; the caller logs that. A D12 holder yields only to a
 * newer stamp, so the stamp still matters for the first rollout over a D12 instance.
 */
export function deployStamp(raw: string | undefined, processStartMs: number): { stamp: number; source: 'deploy_time' | 'process_start' } {
  const ms = raw && RFC3339.test(raw.trim()) ? Date.parse(raw.trim()) : NaN;
  return Number.isFinite(ms) ? { stamp: stampOf(ms), source: 'deploy_time' } : { stamp: stampOf(processStartMs), source: 'process_start' };
}

export interface ReplicaSession {
  /** This process's instance id: written on the rows it owns, alive while its lock is held. */
  readonly instance: number;
  readonly stamp: number;
  readonly leading: boolean;
  /** Takes the leader lock if it is free (one pg_try_advisory_lock). True when this process leads. Never throws. */
  tryLead(): Promise<boolean>;
  /** Gives the leader lock back (another replica takes it within its poll). Never throws. */
  stepDown(): Promise<void>;
  /** Whether the shared single-replica lock and the instance lock are still held on this session. Never throws. */
  check(): Promise<'held' | 'lost'>;
  /** Idempotent: unlocks everything and closes the lock connection. */
  release(): Promise<void>;
}

const advisoryHeld = (conn: SQL, where: { classid: number; objid: number; objsubid: 1 | 2 }) =>
  conn`select 1 from pg_locks where locktype = 'advisory' and classid::int8 = ${where.classid} and objid::int8 = ${where.objid}
       and objsubid = ${where.objsubid} and granted and pid = pg_backend_pid()`;

/**
 * Joins the replica set: the shared single-replica lock (asking a D12 holder to hand over, waiting up to
 * `timeoutMs`), then a fresh instance id and its lock. Throws REPLICA_JOIN_FAILED when a D12 holder never yields.
 */
export async function joinReplicas(
  url: string,
  o: { stamp: number; timeoutMs?: number; pollMs?: number; log?: (e: Record<string, string | number>) => void },
): Promise<ReplicaSession> {
  const pollMs = o.pollMs ?? 200;
  const deadline = Date.now() + (o.timeoutMs ?? HANDOVER_WAIT_MS);
  const conn = new SQL(url, { max: 1, idleTimeout: 0, maxLifetime: 0 });
  let requested = false;
  let instance = 0;
  try {
    for (;;) {
      const [r] = (await conn`select pg_try_advisory_lock_shared(${SINGLE_REPLICA_KEY}) as ok`) as { ok: boolean }[];
      if (r!.ok) break;
      if (!requested) {
        // Another requester with the same stamp may hold this key: then retry each poll (it may give up first).
        const [q] = (await conn`select pg_try_advisory_lock(${HANDOVER_CLASS}::int4, ${o.stamp}::int4) as ok`) as { ok: boolean }[];
        if (q!.ok) {
          requested = true;
          o.log?.({ event: 'handover_waiting', stamp: o.stamp });
        }
      }
      if (Date.now() + pollMs > deadline) throw new Error(REPLICA_JOIN_FAILED);
      await Bun.sleep(pollMs);
    }
    if (requested) await conn`select pg_advisory_unlock(${HANDOVER_CLASS}::int4, ${o.stamp}::int4)`;
    // The sequence cycles: an id still held by a live process (after 2^31 boots) is skipped.
    for (;;) {
      const [n] = (await conn`select nextval('app.api_instance_seq')::int4 as id`) as { id: number }[];
      const [l] = (await conn`select pg_try_advisory_lock(${INSTANCE_CLASS}::int4, ${n!.id}::int4) as ok`) as { ok: boolean }[];
      if (l!.ok) {
        instance = n!.id;
        break;
      }
    }
  } catch (e) {
    await conn.close(); // the session ends: the handover request and any lock go with it
    throw e;
  }
  let leading = false;
  let released: Promise<void> | undefined;
  return {
    instance,
    stamp: o.stamp,
    get leading() {
      return leading;
    },
    async tryLead() {
      if (leading) return true;
      if (released) return false;
      try {
        const [r] = (await conn`select pg_try_advisory_lock(${LEADER_KEY}) as ok`) as { ok: boolean }[];
        leading = r?.ok === true;
      } catch {
        leading = false;
      }
      return leading;
    },
    async stepDown() {
      if (!leading) return;
      leading = false;
      try {
        await conn`select pg_advisory_unlock(${LEADER_KEY})`;
      } catch {
        // the connection is gone, and the lock with it
      }
    },
    async check() {
      try {
        const shared = (await advisoryHeld(conn, { classid: 0, objid: SINGLE_REPLICA_KEY, objsubid: 1 })) as unknown[];
        const own = (await advisoryHeld(conn, { classid: INSTANCE_CLASS, objid: instance, objsubid: 2 })) as unknown[];
        return shared.length > 0 && own.length > 0 ? 'held' : 'lost';
      } catch {
        return 'lost';
      }
    },
    release() {
      return (released ??= (async () => {
        leading = false;
        try {
          await conn`select pg_advisory_unlock_all()`;
        } finally {
          await conn.close();
        }
      })());
    },
  };
}

export const LOCK_HEARTBEAT_MS = 10_000;

/**
 * Every 10 s, confirms this process's locks are still held. A lost session cannot be re-taken safely (the leader may
 * already have recovered this instance's rows as dead), so the process logs `lock_lost` and exits 1. `every` and
 * `exit` are injected for tests. Returns the stop function (call it before releasing the session).
 */
export function startLockHeartbeat(
  lock: Pick<ReplicaSession, 'check'>,
  d: {
    exit: (code: number) => void;
    log?: (e: Record<string, string | number>) => void;
    every?: (fn: () => Promise<void>, ms: number) => () => void;
    intervalMs?: number;
  },
): () => void {
  const every = d.every ?? defaultEvery;
  let stopped = false;
  let busy = false;
  const stop = every(async () => {
    if (stopped || busy) return;
    busy = true;
    try {
      const state = await lock.check();
      if (stopped) return;
      if (state === 'lost') {
        d.log?.({ event: 'lock_lost' });
        d.exit(1);
      }
    } finally {
      busy = false;
    }
  }, d.intervalMs ?? LOCK_HEARTBEAT_MS);
  return () => {
    stopped = true;
    stop();
  };
}

export const LEADER_POLL_MS = 2_000;

/**
 * Polls for the leader lock every LEADER_POLL_MS until this process gets it, then calls `onLead` once (start the
 * leader's jobs there). Leadership ends only by `stepDown` at shutdown or the process dying; a dropped lock session
 * ends the process (heartbeat). Returns the stop function.
 */
export function startLeadership(
  session: Pick<ReplicaSession, 'tryLead' | 'instance'>,
  d: { onLead: () => void; log?: (e: Record<string, string | number>) => void; every?: (fn: () => Promise<void>, ms: number) => () => void; intervalMs?: number },
): () => void {
  const every = d.every ?? defaultEvery;
  let stopped = false;
  let busy = false;
  let led = false;
  const attempt = async () => {
    if (stopped || busy || led) return;
    busy = true;
    try {
      if (!(await session.tryLead()) || stopped) return;
      led = true;
      d.log?.({ event: 'leader', instance: session.instance });
      d.onLead();
    } finally {
      busy = false;
    }
  };
  void attempt();
  const stop = every(attempt, d.intervalMs ?? LEADER_POLL_MS);
  return () => {
    stopped = true;
    stop();
  };
}

function defaultEvery(fn: () => Promise<void>, ms: number): () => void {
  const t = setInterval(() => void fn(), ms);
  t.unref();
  return () => clearInterval(t);
}
