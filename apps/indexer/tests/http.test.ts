import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import type { Db } from '../src/db.js';
import { createHealth } from '../src/http.js';
import { freshDb } from './support/db.js';

let db: Awaited<ReturnType<typeof freshDb>>;
beforeAll(async () => {
  db = await freshDb();
});
afterAll(async () => {
  await db.drop();
});

const NOW = new Date('2026-10-12T12:00:00Z');
const get = (path = '/health', method = 'GET') => new Request(`http://x${path}`, { method });

describe('createHealth', () => {
  it('returns 200 with the heartbeat age', async () => {
    await db.sql`delete from discovery.meta`;
    await db.sql`insert into discovery.meta (key, value) values ('heartbeat_at', ${new Date(NOW.getTime() - 42_500).toISOString()})`;
    const res = await createHealth({ sql: db.sql, now: () => NOW })(get());
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, heartbeatAgeS: 42 });
  });

  it('answers 200 with a null age before the first heartbeat', async () => {
    await db.sql`delete from discovery.meta`;
    const res = await createHealth({ sql: db.sql, now: () => NOW })(get());
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, heartbeatAgeS: null });
  });

  it('says so when a chain reset halted the pollers', async () => {
    await db.sql`delete from discovery.meta`;
    await db.sql`insert into discovery.meta (key, value) values ('halted', 'chain_reset')`;
    const body = (await (await createHealth({ sql: db.sql, now: () => NOW })(get())).json()) as { ok: boolean; halted: string };
    expect(body).toMatchObject({ ok: true, halted: 'chain_reset' });
  });

  it('returns 503 when the db throws, without leaking the error', async () => {
    const broken = (() => Promise.reject(new Error('postgres://u:hunter2@h/db'))) as unknown as Db;
    const res = await createHealth({ sql: broken })(get());
    expect(res.status).toBe(503);
    const text = await res.text();
    expect(text).not.toContain('hunter2');
    expect(JSON.parse(text)).toEqual({ ok: false });
  });

  it('serves no other route', async () => {
    const h = createHealth({ sql: db.sql, now: () => NOW });
    for (const [p, m] of [['/', 'GET'], ['/health/x', 'GET'], ['/agents', 'GET'], ['/health', 'POST']] as const) {
      expect((await h(get(p, m))).status).toBe(404);
    }
  });
});
