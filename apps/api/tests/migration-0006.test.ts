import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import type { Db } from '../src/db/index.js';
import { freshDb, MIGRATIONS_DIR } from './support/db.js';
import { activeAgent, minimalSpec } from './support/specs.js';

describe('migration 0006 (builder schema)', () => {
  let sql: Db;
  let drop: () => Promise<void>;
  beforeAll(async () => {
    ({ sql, drop } = await freshDb());
  });
  afterAll(() => drop());

  it('view and service_suggestion are nullable jsonb', async () => {
    const a = await activeAgent(sql);
    await sql`insert into app.agent_specs (agent_id, version, spec) values (${a.agentId}, 1, ${minimalSpec()})`;
    const [row] = (await sql`select view, service_suggestion from app.agent_specs where agent_id = ${a.agentId}`) as { view: unknown; service_suggestion: unknown }[];
    expect(row).toEqual({ view: null, service_suggestion: null });
    await sql`update app.agent_specs set view = ${{ sentence: ['x'] }}, service_suggestion = ${{ slug: 'y' }} where agent_id = ${a.agentId}`;
    const [after] = (await sql`select view, service_suggestion from app.agent_specs where agent_id = ${a.agentId}`) as { view: unknown; service_suggestion: unknown }[];
    expect(after).toEqual({ view: { sentence: ['x'] }, service_suggestion: { slug: 'y' } });
  });

  it('builder_usage refuses an unknown kind and a duplicate key, and defaults counters to 0', async () => {
    await sql`insert into app.builder_usage (scope, day, kind) values ('u1', '2026-10-12', 'draft')`;
    const [row] = (await sql`select n, tokens from app.builder_usage where scope = 'u1'`) as { n: number; tokens: string | number }[];
    expect(row?.n).toBe(0);
    expect(Number(row?.tokens)).toBe(0);
    await expect(Promise.resolve(sql`insert into app.builder_usage (scope, day, kind) values ('u1', '2026-10-12', 'draft')`)).rejects.toMatchObject({ errno: '23505' });
    await expect(Promise.resolve(sql`insert into app.builder_usage (scope, day, kind) values ('u1', '2026-10-12', 'chat')`)).rejects.toMatchObject({ errno: '23514' });
    for (const kind of ['trial', 'edit', 'handoff']) await sql`insert into app.builder_usage (scope, day, kind) values ('u1', '2026-10-12', ${kind})`;
  });

  it('draft_handoffs refuses a short id and a bad character', async () => {
    const exp = new Date(Date.now() + 600_000);
    await sql`insert into app.draft_handoffs (id, draft, expires_at) values (${'a'.repeat(22)}, ${{ name: 'x' }}, ${exp})`;
    await expect(Promise.resolve(sql`insert into app.draft_handoffs (id, draft, expires_at) values (${'a'.repeat(21)}, ${{}}, ${exp})`)).rejects.toMatchObject({ errno: '23514' });
    await expect(Promise.resolve(sql`insert into app.draft_handoffs (id, draft, expires_at) values (${'a'.repeat(21) + '!'}, ${{}}, ${exp})`)).rejects.toMatchObject({ errno: '23514' });
  });

  it('re-applies cleanly and keeps the data', async () => {
    await sql.unsafe(await Bun.file(`${MIGRATIONS_DIR}0006_builder.sql`).text());
    const [row] = (await sql`select count(*)::int as n from app.draft_handoffs`) as { n: number }[];
    expect(row?.n).toBe(1);
  });
});
