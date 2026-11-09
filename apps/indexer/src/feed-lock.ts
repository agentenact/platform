import type { Db } from './db.js';

/**
 * Transaction-scoped advisory-lock key serialising every `discovery.feed` insert ('AEFD'). Distinct from the
 * single-instance session key INDEXER_LOCK_KEY ('AEI1') and from 0x41455331.
 */
export const FEED_LOCK_KEY = 0x41454644;

/**
 * Take it immediately before each `insert into discovery.feed`, inside the writing transaction. The bigserial seq is
 * drawn after the lock and the lock is held until commit, so seq order equals commit order: a poller reading
 * `seq > after` can never see N+1 before N and skip N for good.
 */
export async function lockFeed(q: Db): Promise<void> {
  await q`select pg_advisory_xact_lock(${FEED_LOCK_KEY})`;
}

/**
 * Lock order: any transaction that may insert into `discovery.feed` calls `lockFeed(tx)` as its FIRST statement, before
 * any row lock or `for update`. Taking the feed lock after a row lock (or a row lock after it, in another writer) makes
 * a cycle: Postgres aborts one side with 40P01. The per-insert calls stay; they are no-ops once the lock is held.
 */

/** A deadlock (40P01) or serialization failure (40001): the work is fine, the attempt lost a race. Retry, never skip. */
export function isTransientPg(err: unknown): boolean {
  for (let e: unknown = err, i = 0; e && typeof e === 'object' && i < 4; i++, e = (e as { cause?: unknown }).cause) {
    const o = e as { errno?: unknown; code?: unknown; sqlState?: unknown };
    for (const c of [o.errno, o.code, o.sqlState]) if (c === '40P01' || c === '40001') return true;
  }
  return false;
}
