import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import type { Db } from '../src/db/index.js';
import { freshDb, MIGRATIONS_DIR } from './support/db.js';

describe('migration 0010 (builder_usage accepts kind suggest)', () => {
  let sql: Db;
  let drop: () => Promise<void>;
  beforeAll(async () => {
    ({ sql, drop } = await freshDb());
  });
  afterAll(() => drop());

  it('accepts suggest, keeps the old kinds and still refuses an unknown one', async () => {
    for (const kind of ['draft', 'trial', 'edit', 'handoff', 'suggest']) await sql`insert into app.builder_usage (scope, day, kind) values ('m10', '2026-10-13', ${kind})`;
    await expect(Promise.resolve(sql`insert into app.builder_usage (scope, day, kind) values ('m10', '2026-10-13', 'chat')`)).rejects.toMatchObject({ errno: '23514' });
  });

  it('re-applies cleanly, keeps rows and keeps exactly one kind check', async () => {
    const text = await Bun.file(`${MIGRATIONS_DIR}0010_builder_suggest.sql`).text();
    await sql.unsafe(text);
    await sql.unsafe(text);
    const [n] = (await sql`select count(*)::int as n from app.builder_usage where scope = 'm10'`) as { n: number }[];
    expect(n?.n).toBe(5);
    const checks = (await sql`select conname from pg_constraint where conrelid = 'app.builder_usage'::regclass and contype = 'c'`) as { conname: string }[];
    expect(checks.map((c) => c.conname)).toEqual(['builder_usage_kind_check']);
  });
});
