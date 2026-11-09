import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import type { Db } from '../src/db/index.js';
import { freshDb, MIGRATIONS_DIR } from './support/db.js';

describe('migration 0024 (several agents per account)', () => {
  let sql: Db;
  let drop: () => Promise<void>;
  beforeAll(async () => ({ sql, drop } = await freshDb()));
  afterAll(() => drop());

  const indexes = async () =>
    ((await sql`select indexname from pg_indexes where schemaname = 'app' and tablename = 'agents' order by indexname`) as { indexname: string }[]).map((r) => r.indexname);

  it('drops the one-per-user index and adds the live count index and the per-user creation key', async () => {
    const names = await indexes();
    expect(names).not.toContain('agents_one_per_user');
    expect(names).toEqual(expect.arrayContaining(['agents_live_by_user', 'agents_creation_key']));
  });

  it('re-applies cleanly', async () => {
    await sql.unsafe(await Bun.file(`${MIGRATIONS_DIR}0024_several_agents.sql`).text());
    expect(await indexes()).toEqual(expect.arrayContaining(['agents_live_by_user', 'agents_creation_key']));
  });
});
