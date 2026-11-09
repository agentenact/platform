import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import type { Db } from '../src/db/index.js';
import { createPolicy, DAILY_RUNS, DAILY_TOKENS, EGRESS_PER_HOUR, EMAILS_PER_DAY, PAID_SEARCH_GLOBAL_PER_DAY, PAID_SEARCH_PER_AGENT_PER_DAY, TRIAL_SEARCH_PER_DAY } from '../src/policy/index.js';
import { freshDb } from './support/db.js';
import { insertUser } from './support/fixtures.js';

describe('policy', () => {
  let sql: Db;
  let drop: () => Promise<void>;
  beforeAll(async () => ({ sql, drop } = await freshDb()));
  afterAll(() => drop());

  const usage = async (id: string) =>
    ((await sql`select daily_runs, daily_tokens from app.users where id = ${id}`) as { daily_runs: number; daily_tokens: number }[])[0]!;

  it('the first admission of a day resets the counters', async () => {
    const p = createPolicy(sql, { killSwitch: false });
    const id = await insertUser(sql);
    await sql`update app.users set daily_runs = ${DAILY_RUNS}, daily_tokens = ${DAILY_TOKENS}, daily_reset_at = now() - interval '2 days' where id = ${id}`;
    expect(await p.admitRun(id)).toBe(true);
    expect(await usage(id)).toEqual({ daily_runs: 1, daily_tokens: 0 });
  });

  it('refuses past the run cap and past the token cap', async () => {
    const p = createPolicy(sql, { killSwitch: false });
    const id = await insertUser(sql);
    expect(await p.admitRun(id)).toBe(true);
    await sql`update app.users set daily_runs = ${DAILY_RUNS} where id = ${id}`;
    expect(await p.admitRun(id)).toBe(false);
    await sql`update app.users set daily_runs = 0 where id = ${id}`;
    expect(await p.chargeTokens(id, DAILY_TOKENS)).toBe(false);
    expect(await p.admitRun(id)).toBe(false);
    expect(await p.admitRun(crypto.randomUUID())).toBe(false); // unknown user
  });

  it('a second admission waits on the row lock and then sees the first (exactly one slot admits)', async () => {
    const p = createPolicy(sql, { killSwitch: false });
    const id = await insertUser(sql);
    expect(await p.admitRun(id)).toBe(true);
    await sql`update app.users set daily_runs = ${DAILY_RUNS - 1} where id = ${id}`;
    let second!: Promise<boolean>;
    await sql.begin(async (tx) => {
      // The transaction takes the last slot and holds the row lock until it commits.
      const rows = (await tx`update app.users set daily_runs = daily_runs + 1 where id = ${id} and daily_runs < ${DAILY_RUNS} returning daily_runs`) as unknown[];
      expect(rows.length).toBe(1);
      second = p.admitRun(id);
      // Wait until the second statement is really blocked on a lock (not merely queued).
      for (let i = 0; i < 400; i++) {
        const w = (await sql`select 1 from pg_stat_activity where datname = current_database() and wait_event_type = 'Lock' and query like '%daily_runs%'`) as unknown[];
        if (w.length > 0) return;
        await Bun.sleep(5);
      }
      throw new Error('second admitRun never blocked on the row lock');
    });
    expect(await second).toBe(false);
    expect((await usage(id)).daily_runs).toBe(DAILY_RUNS);
  });

  it('chargeTokens adds to the day and reports whether the user is still under the cap', async () => {
    const p = createPolicy(sql, { killSwitch: false });
    const id = await insertUser(sql);
    await p.admitRun(id);
    expect(await p.chargeTokens(id, 1234)).toBe(true);
    expect(await p.chargeTokens(id, 0)).toBe(true);
    expect((await usage(id)).daily_tokens).toBe(1234);
    expect(await p.chargeTokens(id, DAILY_TOKENS - 1234 - 1)).toBe(true); // one token under
    expect(await p.chargeTokens(id, 1)).toBe(false); // crosses (reaches) the cap
    expect(await p.chargeTokens(id, 0)).toBe(false);
    expect((await usage(id)).daily_tokens).toBe(DAILY_TOKENS);
  });

  it('chargeTokens on a stale day resets to today and charges today', async () => {
    const p = createPolicy(sql, { killSwitch: false });
    const id = await insertUser(sql);
    await sql`update app.users set daily_runs = 7, daily_tokens = ${DAILY_TOKENS}, daily_reset_at = now() - interval '2 days' where id = ${id}`;
    expect(await p.chargeTokens(id, 500)).toBe(true);
    expect(await usage(id)).toEqual({ daily_runs: 0, daily_tokens: 500 });
    const [r] = (await sql`select daily_reset_at >= date_trunc('day', now(), 'UTC') as today from app.users where id = ${id}`) as { today: boolean }[];
    expect(r!.today).toBe(true);
  });

  it('chargeTokens returns false for an unknown user and throws on bad token counts', async () => {
    const p = createPolicy(sql, { killSwitch: false });
    expect(await p.chargeTokens(crypto.randomUUID(), 10)).toBe(false);
    const id = await insertUser(sql);
    for (const bad of [Number.NaN, Number.POSITIVE_INFINITY, -1]) {
      await expect(p.chargeTokens(id, bad)).rejects.toThrow('policy: bad_tokens');
    }
    expect((await usage(id)).daily_tokens).toBe(0);
  });

  it('exposes the kill switch', () => {
    expect(createPolicy(sql, { killSwitch: true }).killed).toBe(true);
    expect(createPolicy(sql, { killSwitch: false }).killed).toBe(false);
  });

  it('limits email per agent per day and egress per agent per hour', async () => {
    let t = 0;
    const p = createPolicy(sql, { killSwitch: false, now: () => t });
    for (let i = 0; i < EMAILS_PER_DAY; i++) expect(await p.delivery('a1', 'email')).toBe(true);
    expect(await p.delivery('a1', 'email')).toBe(false);
    expect(await p.delivery('a2', 'email')).toBe(true);
    expect(await p.delivery('a1', 'webhook')).toBe(true);
    for (let i = 0; i < EGRESS_PER_HOUR; i++) expect(await p.egress('a1')).toBe(true);
    expect(await p.egress('a1')).toBe(false);
    t = 86_400_000;
    expect(await p.delivery('a1', 'email')).toBe(true);
    expect(await p.egress('a1')).toBe(true);
  });

  it('caps paid search per agent and globally per day, and resets after a day', async () => {
    let t = 0;
    const p = createPolicy(sql, { killSwitch: false, now: () => t });
    expect([PAID_SEARCH_PER_AGENT_PER_DAY, PAID_SEARCH_GLOBAL_PER_DAY]).toEqual([20, 300]);
    for (let i = 0; i < PAID_SEARCH_PER_AGENT_PER_DAY; i++) expect(await p.paidSearch('a1')).toBe(true);
    expect(await p.paidSearch('a1')).toBe('agent');
    expect(await p.paidSearch('a2')).toBe(true);
    t = 86_400_000;
    expect(await p.paidSearch('a1')).toBe(true);
  });

  it('the global paid-search cap binds across agents, and a refused agent hit does not spend it', async () => {
    let t = 0;
    const p = createPolicy(sql, { killSwitch: false, now: () => t });
    for (let i = 0; i < PAID_SEARCH_GLOBAL_PER_DAY; i++) expect(await p.paidSearch(`agent-${i % 30}`)).toBe(true);
    expect(await p.paidSearch('fresh')).toBe('global');
    t = 86_400_000;
    expect(await p.paidSearch('fresh')).toBe(true);
  });

  it('the trial search bucket is separate: it caps at its own limit and never spends the agents paid-search counters', async () => {
    let t = 0;
    const p = createPolicy(sql, { killSwitch: false, now: () => t });
    for (let i = 0; i < TRIAL_SEARCH_PER_DAY; i++) expect(await p.trialSearch()).toBe(true);
    expect(await p.trialSearch()).toBe(false);
    for (let i = 0; i < PAID_SEARCH_GLOBAL_PER_DAY; i++) expect(await p.paidSearch(`agent-${i % 30}`)).toBe(true);
    t = 86_400_000;
    expect(await p.trialSearch()).toBe(true);
  });
});
