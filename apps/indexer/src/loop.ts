import type { Db } from './db.js';

export type StageName = 'registry' | 'events' | 'payments' | 'selfpub' | 'records';

/** Default intervals in ms. `payments` handles only the wallets that are due on each run. */
export const DEFAULT_EVERY: Record<StageName, number> = { registry: 60_000, events: 5_000, payments: 5_000, selfpub: 30_000, records: 10_000 };
/** Until the first registry tick succeeds, it is retried this often (independent of the registry stage's own interval). */
const STARTUP_RETRY_MS = 30_000;
/** How often `stage_stats` lines are written. */
const STATS_EVERY_MS = 10 * 60_000;

/**
 * A chain_reset from `registry` or `events` latches `meta.halted` and stops these stages. `registry` is included so a
 * halted process writes no further agent rows; `records` so it never credits a sale against an index that is stale after
 * a reset (the stage also reads the persisted marker itself, for restarts). Only an operator clears the latch (delete the row, restart).
 */
const HALTED_STAGES: ReadonlySet<string> = new Set<StageName>(['registry', 'events', 'payments', 'records']);
const HALT_WRITE_RETRY_MS = 200;
const HALT_WRITE_RETRY_MAX_MS = 30_000;
const RESET_SOURCES: ReadonlySet<string> = new Set<StageName>(['registry', 'events']);
const DRAIN_MS = 5_000;
/**
 * The longest one tick may take (lock check, stage, heartbeat). Nothing in a tick can be cancelled from outside (the
 * Soroban RPC client has no request timeout), so a tick past this is a hang and the process exits for a clean restart.
 * Seen live 2026-10-20: events stopped on a call that never settled, logged nothing and froze `heartbeat_at` for a week.
 */
const TICK_TIMEOUT_MS = 10 * 60_000;
const FINAL_WRITE_MS = 3_000;

export type Lock = { assertHeld(): Promise<boolean> };

export type LoopDeps = {
  stages: Record<StageName, () => Promise<unknown>>;
  every?: Partial<Record<StageName, number>>;
  sql: Db;
  /** Checked at the start of every tick, before any stage runs. */
  lock: Lock;
  /** Called with 1 when the lock is lost or a tick hangs; the process must die so the next instance re-takes the lock. */
  exit: (code: number) => void;
  now?: () => Date;
  sleep?: (ms: number) => Promise<void>;
  /** How long stop() waits for a running stage. */
  drainMs?: number;
  /** Bound on the last marker write at stop() and on lock loss. */
  finalWriteMs?: number;
  /** A tick still running after this is a hang: logged as `tick_hung` and the process exits 1. */
  tickTimeoutMs?: number;
  /** How often `stage_stats` is logged while running. */
  statsEveryMs?: number;
  /** Fixed events only: never pass an error object. */
  log: (e: Record<string, string | number>) => void;
};

export type Loop = {
  start(): void;
  stop(): Promise<void>;
  tick(name: string): Promise<void>;
  /** Logs one `stage_stats` line per stage that ticked since the last report (ticks, wall ms total and max) plus process CPU, then resets. */
  reportStats(): void;
};

const defaultSleep = (ms: number) =>
  new Promise<void>((r) => {
    const t = setTimeout(r, ms);
    (t as { unref?: () => void }).unref?.();
  });

async function setMeta(sql: Db, key: string, value: string): Promise<void> {
  await sql`insert into discovery.meta (key, value) values (${key}, ${value}) on conflict (key) do update set value = excluded.value`;
}

/** The ledger a TOID cursor (`<ledger << 32 | ...>-<n>`) points at; null when unparsable. */
function cursorLedger(cursor: string): number | null {
  try {
    return Number(BigInt(cursor.split('-')[0]!) >> 32n);
  } catch {
    return null;
  }
}

/** The newest ledger the events stage has processed: its cursor, else the ledger it started from. */
async function indexedLedger(sql: Db): Promise<number | null> {
  const rows = (await sql`select key, value from discovery.meta where key in ('events_cursor', 'events_ledger')`) as Array<{ key: string; value: string }>;
  const cur = rows.find((r) => r.key === 'events_cursor');
  const fromCursor = cur ? cursorLedger(cur.value) : null;
  if (fromCursor) return fromCursor;
  const led = rows.find((r) => r.key === 'events_ledger');
  return led ? Number(led.value) : null;
}

/** A payments result where wallets were due and every poll failed. */
function allPollsFailed(res: unknown): boolean {
  if (typeof res !== 'object' || res === null) return false;
  const { polled, failed } = res as { polled?: unknown; failed?: unknown };
  return typeof polled === 'number' && typeof failed === 'number' && polled > 0 && failed >= polled;
}

export function createLoop(d: LoopDeps): Loop {
  const now = d.now ?? (() => new Date());
  const sleep = d.sleep ?? defaultSleep;
  const every: Record<StageName, number> = { ...DEFAULT_EVERY, ...d.every };
  const names = Object.keys(DEFAULT_EVERY) as StageName[];

  let started = false;
  let stopped = false;
  let halted = false;
  let lost = false;
  const okTicks: Record<string, number> = {};
  /**
   * Pending naps, woken at stop. Not a race against one never-settling promise: every race would add a reaction to it
   * that is never released, one per sleep for the life of the process.
   */
  const nappers = new Set<() => void>();
  const wakeAll = () => {
    for (const wake of [...nappers]) wake();
  };
  /** Sleeps `ms`, or less if the loop stops meanwhile. */
  const nap = (ms: number, via: (ms: number) => Promise<void> = sleep) =>
    new Promise<void>((resolve) => {
      if (stopped) return resolve();
      const wake = () => {
        nappers.delete(wake);
        resolve();
      };
      nappers.add(wake);
      void via(ms).then(wake);
    });
  type Stat = { ticks: number; msTotal: number; msMax: number };
  const stats = new Map<string, Stat>();
  let cpuMark = process.cpuUsage();
  const running = new Map<string, Promise<void>>();
  const runners: Promise<void>[] = [];
  const persisting = new Set<Promise<void>>();
  /** The halt reason while its marker is not yet in the database. */
  let unpersisted: string | null = null;

  /** Latches in memory first (stops the stages at once), then persists the marker, retrying; a restart reads it back. */
  async function halt(reason = 'chain_reset'): Promise<void> {
    if (halted) return;
    halted = true;
    unpersisted = reason;
    d.log({ event: 'indexer_halted', reason });
    try {
      await setMeta(d.sql, 'halted', reason);
      unpersisted = null;
      return;
    } catch {
      d.log({ event: 'halt_marker_failed' });
    }
    // Never give up and never exit: the live process holding the latch in memory is the safest place for it.
    const bg = persistHalt(reason);
    persisting.add(bg);
    void bg.finally(() => persisting.delete(bg));
  }

  /** Retries the marker write with capped exponential backoff until it lands or the loop stops. */
  async function persistHalt(reason: string): Promise<void> {
    let wait = HALT_WRITE_RETRY_MS;
    while (!stopped) {
      await nap(wait);
      if (stopped) return;
      try {
        await setMeta(d.sql, 'halted', reason);
        unpersisted = null;
        return;
      } catch {
        d.log({ event: 'halt_marker_failed' });
        wait = Math.min(wait * 2, HALT_WRITE_RETRY_MAX_MS);
      }
    }
  }

  /** One last marker write for a halt that never landed, bounded so it fits inside the stop grace. Never throws. */
  async function finalHaltWrite(): Promise<void> {
    const reason = unpersisted;
    if (reason === null) return;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<'timeout'>((r) => (timer = setTimeout(() => r('timeout'), d.finalWriteMs ?? FINAL_WRITE_MS)));
    try {
      const res = await Promise.race([setMeta(d.sql, 'halted', reason).then(() => 'ok' as const), timeout]);
      if (res === 'ok') unpersisted = null;
      else d.log({ event: 'halt_lost_on_shutdown', reason: 'timeout' });
    } catch {
      d.log({ event: 'halt_lost_on_shutdown', reason: 'write_failed' }); // never the error object
    } finally {
      clearTimeout(timer);
    }
  }

  /** The stored halt reason, null when absent. An unreadable marker counts as halted (fail closed). */
  async function readHalt(): Promise<string | null> {
    try {
      const rows = (await d.sql`select value from discovery.meta where key = 'halted'`) as Array<{ value: string }>;
      return rows.length ? (rows[0]!.value === 'chain_reset' ? 'chain_reset' : 'halt_marker_present') : null;
    } catch {
      return 'halt_marker_unreadable';
    }
  }

  /** A tick that never settles blocks its stage forever and logs nothing, so a hang ends the process (servel restarts it). */
  async function onHung(name: string): Promise<void> {
    if (lost) return;
    lost = true;
    stopped = true;
    wakeAll();
    d.log({ event: 'tick_hung', stage: name });
    await finalHaltWrite();
    d.exit(1);
  }

  /** Runs one tick under the hang deadline. The hung promise itself is abandoned: only the exit can end it. */
  async function watched(name: StageName): Promise<void> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const hung = new Promise<'hung'>((r) => (timer = setTimeout(() => r('hung'), d.tickTimeoutMs ?? TICK_TIMEOUT_MS)));
    try {
      if ((await Promise.race([run(name).then(() => 'done' as const), hung])) === 'hung') await onHung(name);
    } finally {
      clearTimeout(timer);
    }
  }

  async function onLockLost(): Promise<void> {
    if (lost) return;
    lost = true;
    stopped = true;
    wakeAll();
    d.log({ event: 'singleton_lost' });
    await finalHaltWrite();
    d.exit(1);
  }

  /**
   * Freshness is chain freshness, not process liveness: only a successful events tick (the registry events and their
   * ledger) writes `heartbeat_at` / `indexed_ledger`, and only a payments tick that was not a swallowed outage writes
   * `payments_ok_at`. selfpub, records and registry touch our own database or api and prove nothing about the chain.
   * The api's `stale` reads both, and the halt marker.
   */
  async function heartbeat(name: string): Promise<void> {
    try {
      if (name === 'events') {
        await setMeta(d.sql, 'heartbeat_at', now().toISOString());
        const led = await indexedLedger(d.sql);
        if (led !== null) await setMeta(d.sql, 'indexed_ledger', String(led));
      } else if (name === 'payments') {
        await setMeta(d.sql, 'payments_ok_at', now().toISOString());
      }
    } catch {
      d.log({ event: 'heartbeat_failed', stage: name });
    }
  }

  async function run(name: StageName): Promise<void> {
    if (lost) return;
    let held = false;
    try {
      held = await d.lock.assertHeld();
    } catch {
      held = false; // fail closed
    }
    if (!held) return onLockLost();
    if (halted && HALTED_STAGES.has(name)) return;
    if (name === 'payments' && !okTicks.events) return; // never poll payments before events has proved the chain is the one we know

    let res: unknown;
    try {
      res = await d.stages[name]();
    } catch {
      d.log({ event: 'stage_failed', stage: name }); // the error object may carry URLs or row values
      return;
    }
    const status = typeof res === 'object' && res !== null ? (res as { status?: unknown }).status : undefined;
    if (RESET_SOURCES.has(name) && status === 'chain_reset') return halt();
    if (halted && HALTED_STAGES.has(name)) return; // finished after the halt: not a healthy tick
    if (status === 'suspect') return; // the RPC looked behind: the tick did nothing, so it proves nothing
    if (name === 'payments' && allPollsFailed(res)) return; // every wallet's poll threw (Horizon outage): not an OK tick
    okTicks[name] = (okTicks[name] ?? 0) + 1;
    await heartbeat(name);
  }

  function tick(name: string): Promise<void> {
    if (!names.includes(name as StageName)) return Promise.reject(new Error(`unknown stage: ${name}`));
    const existing = running.get(name);
    if (existing) return existing; // a stage never overlaps itself
    const t0 = performance.now();
    const p = watched(name as StageName).finally(() => {
      running.delete(name);
      const ms = performance.now() - t0;
      const st = stats.get(name) ?? { ticks: 0, msTotal: 0, msMax: 0 };
      st.ticks++;
      st.msTotal += ms;
      st.msMax = Math.max(st.msMax, ms);
      stats.set(name, st);
    });
    running.set(name, p);
    return p;
  }

  function reportStats(): void {
    for (const [stage, st] of stats) d.log({ event: 'stage_stats', stage, ticks: st.ticks, ms_total: Math.round(st.msTotal), ms_max: Math.round(st.msMax) });
    stats.clear();
    const cpu = process.cpuUsage(cpuMark);
    cpuMark = process.cpuUsage();
    d.log({ event: 'process_stats', cpu_user_ms: Math.round(cpu.user / 1000), cpu_sys_ms: Math.round(cpu.system / 1000), rss_mb: Math.round(process.memoryUsage.rss() / 1e6) });
  }

  async function statsRunner(): Promise<void> {
    for (;;) {
      // A real timer, never the injected sleep: a test's instant sleep would turn this into a spin.
      await nap(d.statsEveryMs ?? STATS_EVERY_MS, defaultSleep);
      if (stopped) return;
      reportStats();
    }
  }

  async function runner(name: StageName, skipFirst: boolean): Promise<void> {
    let first = skipFirst;
    while (!stopped) {
      if (!first) await tick(name);
      first = false;
      if (stopped) break;
      await nap(every[name]);
    }
  }

  return {
    start() {
      if (started) return;
      started = true;
      runners.push(
        (async () => {
          // A persisted halt is a latch: it is never cleared here, and an unreadable marker counts as set.
          const stored = await readHalt();
          if (stopped) return;
          if (stored !== null) {
            halted = true;
            d.log({ event: 'indexer_halted', reason: stored });
          } else {
            // The registry stage goes first so that a reset is seen before events or payments touch anything.
            // Nothing else starts until it has succeeded once (or halted): a failing first tick is retried, never skipped.
            for (;;) {
              await tick('registry');
              if (stopped) return;
              if (halted || okTicks.registry) break;
              await nap(Math.min(every.registry, STARTUP_RETRY_MS));
              if (stopped) return;
            }
          }
          for (const n of names) runners.push(runner(n, n === 'registry' && stored === null));
          runners.push(statsRunner());
        })(),
      );
    },
    async stop() {
      stopped = true;
      wakeAll();
      let timer: ReturnType<typeof setTimeout> | undefined;
      const limit = new Promise<void>((r) => (timer = setTimeout(r, d.drainMs ?? DRAIN_MS)));
      await Promise.race([Promise.allSettled([...running.values(), ...runners, ...persisting, finalHaltWrite()]), limit]);
      clearTimeout(timer);
    },
    tick,
    reportStats,
  };
}
