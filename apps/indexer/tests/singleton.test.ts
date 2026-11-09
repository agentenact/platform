import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { acquireSingleton, INDEXER_LOCK_KEY, SINGLETON_LOCKED } from '../src/singleton.js';
import { freshDb } from './support/db.js';

let db: Awaited<ReturnType<typeof freshDb>>;
beforeAll(async () => {
  db = await freshDb();
});
afterAll(async () => {
  await db.drop();
});

describe('acquireSingleton', () => {
  it('a second instance is refused while the first holds the lock, and succeeds after release', async () => {
    const first = await acquireSingleton(db.url);
    await expect(acquireSingleton(db.url)).rejects.toThrow(SINGLETON_LOCKED);
    await first.release();
    const again = await acquireSingleton(db.url);
    await again.release();
  });

  it('the lock lives on its own connection, not in the shared pool', async () => {
    const first = await acquireSingleton(db.url);
    // pool traffic (and pool recycling) cannot give the lock away: it is still held after unrelated queries
    await db.sql`select 1`;
    await expect(acquireSingleton(db.url)).rejects.toThrow(SINGLETON_LOCKED);
    await first.release();
  });

  // pg_locks is cluster-wide: only this file's own database counts, or a concurrent run's lock holder (maybe another
  // role's, which pg_terminate_backend refuses) would show up here.
  const lockPids = async () =>
    ((await db.sql`select l.pid from pg_locks l join pg_database d on d.oid = l.database
      where l.locktype = 'advisory' and l.objid = ${INDEXER_LOCK_KEY} and l.granted and d.datname = current_database()`) as Array<{ pid: number }>).map((r) => r.pid);

  it('assertHeld is true while the lock session lives', async () => {
    const first = await acquireSingleton(db.url);
    expect(await first.assertHeld()).toBe(true);
    await first.release();
  });

  it('assertHeld turns false when the lock session is terminated, and never reconnects', async () => {
    const first = await acquireSingleton(db.url);
    const [pid] = await lockPids();
    await db.sql`select pg_terminate_backend(${pid})`;
    await Bun.sleep(300);
    expect(await first.assertHeld()).toBe(false);
    expect(await first.assertHeld()).toBe(false); // sticky: no new session is opened
    expect(await lockPids()).toEqual([]);
    await first.release();
  });

  it('a lost lock lets a second instance in, and the first instance release is a no-op for the second lock', async () => {
    const first = await acquireSingleton(db.url);
    const [pid] = await lockPids();
    await db.sql`select pg_terminate_backend(${pid})`;
    await Bun.sleep(300);
    const second = await acquireSingleton(db.url);
    expect(await first.assertHeld()).toBe(false);
    await first.release();
    expect(await second.assertHeld()).toBe(true);
    await expect(acquireSingleton(db.url)).rejects.toThrow(SINGLETON_LOCKED);
    await second.release();
  });
});
