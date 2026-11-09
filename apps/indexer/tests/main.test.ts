import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { checkNetwork } from '../src/main.js';
import { freshDb } from './support/db.js';

let db: Awaited<ReturnType<typeof freshDb>>;
beforeAll(async () => {
  db = await freshDb();
});
afterAll(async () => {
  await db.drop();
});

describe('checkNetwork', () => {
  it('sets testnet on an empty database and accepts it afterwards', async () => {
    await db.sql`delete from discovery.meta`;
    expect(await checkNetwork(db.sql)).toBe(true);
    expect(((await db.sql`select value from discovery.meta where key = 'network'`) as Array<{ value: string }>)[0]?.value).toBe('testnet');
    expect(await checkNetwork(db.sql)).toBe(true);
  });

  it('main refuses a database whose meta network is not testnet, and leaves it untouched', async () => {
    await db.sql`delete from discovery.meta`;
    await db.sql`insert into discovery.meta (key, value) values ('network', 'public')`;
    expect(await checkNetwork(db.sql)).toBe(false);
    expect(((await db.sql`select value from discovery.meta where key = 'network'`) as Array<{ value: string }>)[0]?.value).toBe('public');
  });

  it('importing main does not start anything', () => {
    expect(typeof checkNetwork).toBe('function');
  });
});
