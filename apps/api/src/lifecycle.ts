/** Process lifecycle: graceful shutdown. Kept out of main.ts so it can be tested with fakes. */
import type { Provisioner, StartOutcome } from './provision/index.js';

/** Wraps a provisioner so the in-flight `start`s can be awaited at shutdown. */
export function trackStarts(p: Pick<Provisioner, 'start'>): Pick<Provisioner, 'start'> & { inflight(): Promise<StartOutcome>[] } {
  const running = new Set<Promise<StartOutcome>>();
  return {
    start(id) {
      const run = p.start(id);
      running.add(run);
      const forget = () => void running.delete(run);
      run.then(forget, forget);
      return run;
    },
    inflight: () => [...running],
  };
}

// Best-effort work (the scheduler's running tick) gets SHUTDOWN_GRACE_MS, as before. Money, on-chain work and open
// responses (a paid call that is settling, a provision start, a chat stream) get up to CRITICAL_GRACE_MS, after
// LAME_DUCK_MS of still serving. servel.yaml sets stop_grace_period: 170s (Docker's default was 10 s):
// 20 s + 120 s + 4 x 400 ms = 141.6 s leaves 28 s before SIGKILL, so the release and exit still run.
// tests/lifecycle.test.ts checks the numbers against servel.yaml.
/** Still serving after SIGTERM: Traefik's swarm provider refreshes every 15 s, so it stops routing here within that. */
export const LAME_DUCK_MS = 20_000;
export const SHUTDOWN_GRACE_MS = 7_000;
export const CRITICAL_GRACE_MS = 120_000;
/** Bound for each step after the grace race (force stop, tools, db, release). */
export const SHUTDOWN_STEP_MS = 400;

/** Runs one step; a throw, a hang past `ms` or a sync error never stops the steps after it. */
async function bounded(step: (() => void | Promise<unknown>) | undefined, ms: number): Promise<void> {
  if (!step) return;
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([Promise.resolve().then(step), new Promise<void>((r) => (timer = setTimeout(r, ms)))]);
  } catch {
    // each step is best effort: the next one still runs
  } finally {
    clearTimeout(timer);
  }
}

/** Waits for `pending` to settle, at most `ms`. */
async function settleWithin(pending: () => Promise<unknown>[], ms: number): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([Promise.allSettled(pending()), new Promise<void>((r) => (timer = setTimeout(r, ms)))]);
  } catch {
    // pending() threw: nothing to wait for
  } finally {
    clearTimeout(timer);
  }
}

/**
 * The drain, run once on SIGTERM/SIGINT. With replicas another instance is already serving, so the drain may take
 * its time: first `unready` (health answers 503, the leader's jobs stop) while requests are still served for
 * `lameDuckMs`, long enough for the router to stop sending new ones here; then stop accepting requests WITHOUT
 * waiting (Bun's `server.stop()` resolves only once open responses finish), wait up to `graceMs` for best-effort work
 * (the scheduler tick) and, at the same time, up to `criticalGraceMs` for money, on-chain work and open responses
 * (settling paid calls, provision starts, chat streams); force-close what is left (aborts request signals, so chat
 * runs end), stop the tool pool, close the app's pool, then release the replica session (last: its instance lock is
 * what keeps this process's rows from being recovered as dead). Every step is bounded and runs even if an earlier
 * one threw or hung. Then exit 0.
 */
export function createShutdown(o: {
  /** Leaves the router's rotation (health 503) and stops leader-only jobs. Requests are still served. */
  unready?: () => void;
  /** How long requests are still served after `unready`. Default 0. */
  lameDuckMs?: number;
  /** Stops accepting new work. Not awaited: it may only resolve once open responses finish. */
  stop: () => void | Promise<void>;
  /** Best-effort work, waited for up to `graceMs`. */
  inflight: () => Promise<unknown>[];
  /** Money, on-chain work and open responses, waited for up to `criticalGraceMs`. */
  critical?: () => Promise<unknown>[];
  /** Closes the connections still open after the grace wait (Bun: `server.stop(true)`). */
  forceStop?: () => void | Promise<void>;
  /** The app's pool: closed FIRST, so nothing writes once the session is released. */
  closeDb: () => Promise<void>;
  /** Stops the isolate pool's child processes (optional: nothing to do if no tool ran). */
  stopTools?: () => Promise<void>;
  /** Releases the replica session: LAST, after the pool is closed. */
  release: () => Promise<void>;
  exit: (code: number) => void;
  graceMs?: number;
  criticalGraceMs?: number;
  /** Bound for each step after the grace wait. */
  stepMs?: number;
  sleep?: (ms: number) => Promise<void>;
  log?: (e: Record<string, string | number>) => void;
}): () => Promise<void> {
  let exiting: Promise<void> | undefined;
  const sleep = o.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  return () =>
    (exiting ??= (async () => {
      const stepMs = o.stepMs ?? SHUTDOWN_STEP_MS;
      try {
        o.unready?.();
      } catch {
        // best effort: the drain goes on
      }
      if (o.lameDuckMs) await sleep(o.lameDuckMs);
      let pending = 0;
      try {
        pending = o.inflight().length + (o.critical?.().length ?? 0);
      } catch {
        // wait for nothing
      }
      o.log?.({ event: 'shutdown', inflight: pending });
      try {
        // Not awaited, and a rejection or sync throw is swallowed: already stopped.
        void Promise.resolve(o.stop()).catch(() => undefined);
      } catch {
        // already stopped
      }
      await Promise.all([settleWithin(o.inflight, o.graceMs ?? SHUTDOWN_GRACE_MS), o.critical ? settleWithin(o.critical, o.criticalGraceMs ?? CRITICAL_GRACE_MS) : undefined]);
      await bounded(o.forceStop, stepMs); // children also exit on their own when our stdin pipe closes
      await bounded(o.stopTools, stepMs);
      await bounded(o.closeDb, stepMs); // closing failed or hung: release the session anyway
      await bounded(o.release, stepMs); // the connection is gone, and with it the locks
      o.exit(0);
    })());
}
