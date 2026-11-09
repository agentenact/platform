import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import type { Db } from '../src/db/index.js';
import { freshDb, MIGRATIONS_DIR } from './support/db.js';

describe('migration 0011 (check readings, run model, handoff email hash)', () => {
  let sql: Db;
  let drop: () => Promise<void>;
  let agentId: string;
  beforeAll(async () => {
    ({ sql, drop } = await freshDb());
    const [u] = (await sql`insert into app.users (id, email) values (gen_random_uuid(), 'm11@example.com') returning id`) as { id: string }[];
    const [a] = (await sql`insert into app.agents (user_id, name) values (${u!.id}, 'm11') returning id`) as { id: string }[];
    agentId = a!.id;
  });
  afterAll(() => drop());

  it('re-applies cleanly and keeps rows', async () => {
    await sql`insert into app.check_log (agent_id, held, reading) values (${agentId}, true, ${{ a: 1 }}::jsonb)`;
    const text = await Bun.file(`${MIGRATIONS_DIR}0011_run_readings.sql`).text();
    await sql.unsafe(text);
    await sql.unsafe(text);
    const [n] = (await sql`select count(*)::int as n from app.check_log where agent_id = ${agentId}`) as { n: number }[];
    expect(n?.n).toBe(1);
  });

  it('check_log: held may be null, reading null or at most 512 bytes, trigger_id is a plain uuid (no foreign key: deleting triggers must never scan check_log)', async () => {
    await sql`insert into app.check_log (agent_id) values (${agentId})`;
    await sql`insert into app.check_log (agent_id, held, reading) values (${agentId}, null, ${JSON.stringify({ x: 'y'.repeat(300) })}::jsonb)`;
    await expect(Promise.resolve(sql`insert into app.check_log (agent_id, reading) values (${agentId}, ${JSON.stringify({ x: 'y'.repeat(600) })}::jsonb)`)).rejects.toMatchObject({ errno: '23514' });
    await expect(Promise.resolve(sql`insert into app.check_log (agent_id) values (${crypto.randomUUID()})`)).rejects.toMatchObject({ errno: '23503' });
    await sql`insert into app.check_log (agent_id, trigger_id) values (${agentId}, ${crypto.randomUUID()})`;
    const idx = (await sql`select indexdef from pg_indexes where schemaname = 'app' and tablename = 'check_log'`) as { indexdef: string }[];
    expect(idx.some((i) => /\(agent_id, at DESC\)/.test(i.indexdef))).toBe(true);
  });

  it('runs.model is optional and at most 100 chars', async () => {
    await sql`insert into app.runs (agent_id, mode) values (${agentId}, 'chat')`;
    await sql`insert into app.runs (agent_id, mode, model) values (${agentId}, 'chat', 'claude-x')`;
    await expect(Promise.resolve(sql`insert into app.runs (agent_id, mode, model) values (${agentId}, 'chat', ${'m'.repeat(101)})`)).rejects.toMatchObject({ errno: '23514' });
  });

  it('draft_handoffs.email_sha256 is optional and must be 64 lowercase hex', async () => {
    const id = (s: string) => `m11-${s}`.padEnd(22, 'x');
    await sql`insert into app.draft_handoffs (id, draft, expires_at) values (${id('a')}, '{}'::jsonb, now() + interval '1 hour')`;
    await sql`insert into app.draft_handoffs (id, draft, expires_at, email_sha256) values (${id('b')}, '{}'::jsonb, now() + interval '1 hour', ${'a'.repeat(64)})`;
    for (const bad of ['A'.repeat(64), 'a'.repeat(63)])
      await expect(Promise.resolve(sql`insert into app.draft_handoffs (id, draft, expires_at, email_sha256) values (${id('c')}, '{}'::jsonb, now() + interval '1 hour', ${bad})`)).rejects.toMatchObject({ errno: '23514' });
  });
});
