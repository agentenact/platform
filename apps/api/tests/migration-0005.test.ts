import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import type { Db } from '../src/db/index.js';
import { createRuns, type Runs } from '../src/runs/index.js';
import { freshDb, MIGRATIONS_DIR } from './support/db.js';
import { activeAgent } from './support/specs.js';

const hash = (c: string) => c.repeat(64);

describe('migration 0005 (panel schema)', () => {
  let sql: Db;
  let drop: () => Promise<void>;
  let runs: Runs;
  beforeAll(async () => {
    ({ sql, drop } = await freshDb());
    runs = createRuns(sql);
  });
  afterAll(() => drop());

  it('an agent can be paused and still cannot take an unknown status', async () => {
    const a = await activeAgent(sql);
    await sql`update app.agents set status = 'paused' where id = ${a.agentId}`;
    const [row] = (await sql`select status from app.agents where id = ${a.agentId}`) as { status: string }[];
    expect(row?.status).toBe('paused');
    await expect(Promise.resolve(sql`update app.agents set status = 'sleeping' where id = ${a.agentId}`)).rejects.toMatchObject({ errno: '23514' });
  });

  it('runs.summary over 400 chars is refused', async () => {
    const a = await activeAgent(sql);
    const runId = await runs.start({ agentId: a.agentId, mode: 'chat' });
    await sql`update app.runs set summary = ${'x'.repeat(400)} where id = ${runId}`;
    await expect(Promise.resolve(sql`update app.runs set summary = ${'x'.repeat(401)} where id = ${runId}`)).rejects.toMatchObject({ errno: '23514' });
  });

  it('check_days is unique per agent per day and refuses negative counts', async () => {
    const a = await activeAgent(sql);
    await sql`insert into app.check_days (agent_id, day) values (${a.agentId}, '2026-10-12')`;
    const [row] = (await sql`select quiet, fired from app.check_days where agent_id = ${a.agentId}`) as { quiet: number; fired: number }[];
    expect(row).toEqual({ quiet: 0, fired: 0 });
    await expect(Promise.resolve(sql`insert into app.check_days (agent_id, day) values (${a.agentId}, '2026-10-12')`)).rejects.toMatchObject({ errno: '23505' });
    await expect(Promise.resolve(sql`insert into app.check_days (agent_id, day, quiet) values (${a.agentId}, '2026-10-13', -1)`)).rejects.toMatchObject({ errno: '23514' });
    await expect(Promise.resolve(sql`insert into app.check_days (agent_id, day, fired) values (${a.agentId}, '2026-10-13', -1)`)).rejects.toMatchObject({ errno: '23514' });
  });

  it('records refuses a non-hex tx hash and a duplicate tx hash', async () => {
    const a = await activeAgent(sql);
    const doc = { v: '0.1' };
    await sql`insert into app.records (tx_hash, agent_id, record) values (${hash('a')}, ${a.agentId}, ${doc})`;
    await expect(Promise.resolve(sql`insert into app.records (tx_hash, agent_id, record) values (${hash('a')}, ${a.agentId}, ${doc})`)).rejects.toMatchObject({ errno: '23505' });
    await expect(Promise.resolve(sql`insert into app.records (tx_hash, agent_id, record) values (${'not-a-hash'}, ${a.agentId}, ${doc})`)).rejects.toMatchObject({ errno: '23514' });
    await expect(Promise.resolve(sql`insert into app.records (tx_hash, agent_id, record) values (${hash('A')}, ${a.agentId}, ${doc})`)).rejects.toMatchObject({ errno: '23514' });
    // a deleted run leaves the record behind
    const runId = await runs.start({ agentId: a.agentId, mode: 'chat' });
    await sql`insert into app.records (tx_hash, agent_id, run_id, record) values (${hash('b')}, ${a.agentId}, ${runId}, ${doc})`;
    await sql`delete from app.runs where id = ${runId}`;
    const [row] = (await sql`select run_id from app.records where tx_hash = ${hash('b')}`) as { run_id: string | null }[];
    expect(row?.run_id).toBeNull();
  });

  it('re-applies cleanly and keeps every earlier status valid', async () => {
    await sql.unsafe(await Bun.file(`${MIGRATIONS_DIR}0005_panel.sql`).text());
    const a = await activeAgent(sql);
    for (const status of ['draft', 'provisioning', 'active', 'paused', 'revoked']) {
      await sql`update app.agents set status = ${status} where id = ${a.agentId}`;
    }
    const idx = (await sql`select 1 from pg_indexes where schemaname = 'app' and indexname = 'records_by_agent_time'`) as unknown[];
    expect(idx.length).toBe(1);
  });
});
