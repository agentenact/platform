import { createDedicatedDb } from './db.js';

/** Session advisory-lock key that makes the indexer a single instance. Arbitrary, fixed: 'AEI1'. Distinct from the api's 'AEC1'. */
export const INDEXER_LOCK_KEY = 0x41454931;
export const SINGLETON_LOCKED = 'indexer: another instance holds the single-instance lock';

export interface Singleton {
  /**
   * True only while the lock-holding session is alive AND still owns the lock (`pg_locks` for this backend pid).
   * False once the session is gone; that is sticky, and it never reconnects. The caller MUST check it every tick and
   * exit when it is false: a second instance may already have taken the lock.
   */
  assertHeld(): Promise<boolean>;
  /** Unlocks and closes. A no-op for the lock once it is lost (it never touches a lock another session holds). */
  release(): Promise<void>;
}

/**
 * Takes the single-instance advisory lock on a DEDICATED connection (never pooled, idled out or recycled), which
 * holds it while that session lives (a database restart, failover or `pg_terminate_backend` drops it silently: poll
 * `assertHeld()`). Keep the returned handle referenced for the process lifetime. Two indexers would race on cursors and double-apply events. Throws
 * SINGLETON_LOCKED at once if another session holds it. `url` must be a direct session connection, not a
 * transaction-mode pooler.
 */
export async function acquireSingleton(url: string): Promise<Singleton> {
  const conn = createDedicatedDb(url);
  try {
    const [r] = (await conn`select pg_try_advisory_lock(${INDEXER_LOCK_KEY}) as ok`) as { ok: boolean }[];
    if (!r?.ok) throw new Error(SINGLETON_LOCKED);
  } catch (e) {
    await conn.close();
    throw e;
  }
  let lost = false;
  const assertHeld = async (): Promise<boolean> => {
    if (lost) return false;
    try {
      const [r] = (await conn`
        select exists (
          select 1 from pg_locks
          where locktype = 'advisory' and classid = 0 and objid = ${INDEXER_LOCK_KEY} and objsubid = 1
            and pid = pg_backend_pid() and granted
        ) as held`) as { held: boolean }[];
      if (r?.held) return true;
    } catch {
      // connection gone
    }
    lost = true;
    return false;
  };
  return {
    assertHeld,
    async release() {
      try {
        if (await assertHeld()) await conn`select pg_advisory_unlock(${INDEXER_LOCK_KEY})`;
      } finally {
        await conn.close().catch(() => {});
      }
    },
  };
}
