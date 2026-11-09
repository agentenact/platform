import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import type { Db } from '../src/db/index.js';
import { freshDb, MIGRATIONS_DIR } from './support/db.js';
import { activeAgent } from './support/specs.js';

describe('migration 0021 (skill approvals)', () => {
  let sql: Db;
  let drop: () => Promise<void>;
  beforeAll(async () => {
    ({ sql, drop } = await freshDb());
  });
  afterAll(() => drop());

  const row = (a: { agentId: string; userId: string }, over: Record<string, unknown> = {}) => ({
    agent_id: a.agentId, name: 'defi-digest', skill_id: 'acme/skills/defi-digest', content_hash: 'c'.repeat(64), pin: { kind: 'github' }, verdict: 'clear',
    body_sha256: 'd'.repeat(64), approved_by: a.userId, approved_at: new Date(), spec_version: 1, ...over,
  });
  const insert = (r: Record<string, unknown>) => sql`insert into app.skill_approvals ${sql(r)}`;

  it('holds one row per skill name and per skill id, and refuses bad hashes and verdicts', async () => {
    const a = await activeAgent(sql);
    await insert(row(a));
    await expect(Promise.resolve(insert(row(a, { skill_id: 'acme/skills/other' })))).rejects.toMatchObject({ errno: '23505' });
    await expect(Promise.resolve(insert(row(a, { name: 'other' })))).rejects.toMatchObject({ errno: '23505' });
    await expect(Promise.resolve(insert(row(a, { name: 'x', skill_id: 'a/b/x', content_hash: 'XYZ' })))).rejects.toMatchObject({ errno: '23514' });
    await expect(Promise.resolve(insert(row(a, { name: 'y', skill_id: 'a/b/y', verdict: 'fine' })))).rejects.toMatchObject({ errno: '23514' });
  });

  it('re-applies cleanly and keeps rows', async () => {
    const a = await activeAgent(sql);
    await insert(row(a));
    const text = await Bun.file(`${MIGRATIONS_DIR}0021_skill_approvals.sql`).text();
    await sql.unsafe(text);
    await sql.unsafe(text);
    expect(((await sql`select 1 from app.skill_approvals where agent_id = ${a.agentId}`) as unknown[]).length).toBe(1);
  });
});
