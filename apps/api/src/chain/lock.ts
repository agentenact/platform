import { SQL } from 'bun';

/**
 * A process-local FIFO mutex. A holder that never releases is freed when its lease runs out.
 * A waiter that is not admitted within the acquire timeout is refused with `chain_busy`; its place
 * in the queue then passes straight through, so later waiters keep their order and nobody deadlocks.
 */
export interface LeaseLock {
  /** `onRelease` runs once when the hold ends, by release or by lease expiry. Never for a refused waiter. */
  acquire(leaseMs?: number, onRelease?: () => void): Promise<() => void>;
  readonly held: boolean;
}

/**
 * Default cap on the wait for the lock. With the 120 s wallet-deploy lease, wait + lease stays well
 * under the 10 min passkey stale-claim window (account/passkey STALE_CLAIM_MS).
 */
export const DEFAULT_ACQUIRE_TIMEOUT_MS = 120_000;

export const chainBusy = () => Object.assign(new Error('chain: chain_busy'), { code: 'chain_busy' as const });

export function createLeaseLock(defaultLeaseMs = 30_000, acquireTimeoutMs = DEFAULT_ACQUIRE_TIMEOUT_MS): LeaseLock {
  let tail: Promise<void> = Promise.resolve();
  let held = false;
  return {
    get held() {
      return held;
    },
    acquire(leaseMs = defaultLeaseMs, onRelease?: () => void) {
      let open!: () => void;
      const gate = new Promise<void>((r) => {
        open = r;
      });
      const prev = tail;
      tail = prev.then(() => gate);
      return new Promise<() => void>((resolve, reject) => {
        let refused = false;
        const waitTimer = setTimeout(() => {
          refused = true;
          reject(chainBusy());
        }, acquireTimeoutMs);
        void prev.then(() => {
          if (refused) {
            open(); // our turn came after we gave up: pass it on
            return;
          }
          clearTimeout(waitTimer);
          held = true;
          let done = false;
          const timer = setTimeout(() => release(), leaseMs);
          function release() {
            if (done) return;
            done = true;
            clearTimeout(timer);
            held = false;
            try {
              onRelease?.();
            } finally {
              open();
            }
          }
          resolve(release);
        });
      });
    },
  };
}

/**
 * The cross-replica half of the sponsor lock (replicas, migration 0027): a session advisory lock on ONE dedicated
 * connection per process. The process-local FIFO above still orders this process's waiters, so at most one of them
 * normally waits in Postgres and the pool is never tied up; Postgres queues the replicas' holders in arrival order.
 * `lock` waits at most `timeoutMs` (lock_timeout), then throws `chain_busy`; it resolves to that hold's unlock, which
 * runs once. Session locks count, so every successful lock is matched by exactly one unlock even if two holds of
 * this process ever overlap (a lease that ran out). Unlock is fire-and-forget: queries on the one connection run in
 * the order they are sent. A dropped connection drops the lock; the next tx then fails on a stale sequence number.
 */
export interface CrossLock {
  lock(timeoutMs: number): Promise<() => void>;
  close(): Promise<void>;
}

export function createAdvisoryCrossLock(url: string, key: number, log?: (e: Record<string, string>) => void): CrossLock {
  const conn = new SQL(url, { max: 1, idleTimeout: 0, maxLifetime: 0 });
  return {
    async lock(timeoutMs) {
      try {
        await conn`select set_config('lock_timeout', ${`${Math.max(1, Math.round(timeoutMs))}ms`}, false)`;
        await conn`select pg_advisory_lock(${key})`;
      } catch (e) {
        if ((e as { errno?: string } | null)?.errno !== '55P03') log?.({ event: 'sponsor_lock_failed' });
        throw chainBusy();
      }
      let done = false;
      return () => {
        if (done) return;
        done = true;
        conn`select pg_advisory_unlock(${key})`.catch(() => log?.({ event: 'sponsor_unlock_failed' }));
      };
    },
    close: () => conn.close(),
  };
}
