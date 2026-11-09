import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import type { Db } from '../src/db/index.js';
import { createChecks } from '../src/runs/checks.js';
import { freshDb } from './support/db.js';
import { activeAgent } from './support/specs.js';

describe('checks: the per-day quiet-check count', () => {
  let sql: Db;
  let drop: () => Promise<void>;
  beforeAll(async () => ({ sql, drop } = await freshDb()));
  afterAll(() => drop());

  const utcToday = async () => ((await sql`select to_char(now() at time zone 'utc', 'YYYY-MM-DD') as d`) as { d: string }[])[0]!.d;

  it('record adds up per agent per UTC day concurrently', async () => {
    const a = await activeAgent(sql);
    const b = await activeAgent(sql);
    const checks = createChecks(sql);
    await Promise.all([...Array.from({ length: 20 }, () => checks.record(a.agentId, 'quiet')), ...Array.from({ length: 3 }, () => checks.record(a.agentId, 'fired')), checks.record(b.agentId, 'quiet')]);
    const since = new Date(Date.now() - 86_400_000);
    expect(await checks.days(a.agentId, since)).toEqual([{ day: await utcToday(), quiet: 20, fired: 3, lastAt: expect.any(Date) }]);
    expect((await checks.days(b.agentId, since)).map((d) => [d.quiet, d.fired])).toEqual([[1, 0]]);
  });

  it('a second day is a second row', async () => {
    const a = await activeAgent(sql);
    const checks = createChecks(sql);
    await sql`insert into app.check_days (agent_id, day, quiet, fired) values (${a.agentId}, (now() at time zone 'utc')::date - 1, 5, 1)`;
    await checks.record(a.agentId, 'quiet');
    const rows = (await sql`select count(*)::int as n from app.check_days where agent_id = ${a.agentId}`) as { n: number }[];
    expect(rows[0]!.n).toBe(2);
  });

  it('days returns newest first and honors since', async () => {
    const a = await activeAgent(sql);
    const checks = createChecks(sql);
    await sql`insert into app.check_days (agent_id, day, quiet, fired) values
              (${a.agentId}, (now() at time zone 'utc')::date - 1, 5, 1), (${a.agentId}, (now() at time zone 'utc')::date - 10, 2, 0)`;
    await checks.record(a.agentId, 'fired');
    const week = await checks.days(a.agentId, new Date(Date.now() - 7 * 86_400_000));
    expect(week.map((d) => [d.quiet, d.fired])).toEqual([[0, 1], [5, 1]]);
    expect(week[0]!.day > week[1]!.day).toBe(true);
    expect((await checks.days(a.agentId, new Date(Date.now() - 30 * 86_400_000))).length).toBe(3);
  });

  describe('check log', () => {
    const trigger = async (agentId: string) => ((await sql`insert into app.triggers (agent_id, spec_version, kind, cron_expr, mission, next_run_at) select ${agentId}, 1, 'cron', '0 * * * *', 'm', now() + interval '1 day' returning id`) as { id: string }[])[0]!.id;
    const rows = async (agentId: string) => (await sql`select trigger_id, held, reading from app.check_log where agent_id = ${agentId} order by id`) as { trigger_id: string; held: boolean | null; reading: unknown }[];

    it('log writes one row per check, with held and the reading', async () => {
      const a = await activeAgent(sql);
      const t = await trigger(a.agentId);
      const checks = createChecks(sql);
      await checks.log(a.agentId, { triggerId: t, held: false, reading: { symbol: 'XLM', price: 0.1913 } });
      await checks.log(a.agentId, { triggerId: t, held: null, reading: null });
      expect(await rows(a.agentId)).toEqual([
        { trigger_id: t, held: false, reading: { symbol: 'XLM', price: 0.1913 } },
        { trigger_id: t, held: null, reading: null },
      ]);
      expect(await checks.days(a.agentId, new Date(Date.now() - 86_400_000))).toEqual([]); // the counters are untouched
    });

    it('prune deletes at most `limit` rows older than 7 days, oldest first, and keeps newer ones', async () => {
      const a = await activeAgent(sql);
      await sql`delete from app.check_log where at < now() - interval '7 days'`;
      await sql`insert into app.check_log (agent_id, at, held) select ${a.agentId}, now() - interval '8 days' - make_interval(secs => g), true from generate_series(1, 25) g`;
      await sql`insert into app.check_log (agent_id, at, held) values (${a.agentId}, now() - interval '6 days', true), (${a.agentId}, now(), false)`;
      const checks = createChecks(sql);
      expect(await checks.prune(10)).toBe(10);
      expect(await checks.prune(10)).toBe(10);
      expect(await checks.prune(10)).toBe(5);
      expect(await checks.prune(10)).toBe(0);
      expect((await rows(a.agentId)).map((r) => r.held)).toEqual([true, false]);
    });

    it('prune defaults to 1000 rows per call', async () => {
      const a = await activeAgent(sql);
      await sql`delete from app.check_log where at < now() - interval '7 days'`;
      await sql`insert into app.check_log (agent_id, at, held) select ${a.agentId}, now() - interval '9 days' - make_interval(secs => g), true from generate_series(1, 1200) g`;
      const checks = createChecks(sql);
      expect(await checks.prune()).toBe(1000);
      expect(await checks.prune()).toBe(200);
    });
  });
});
