import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import type { Db } from '../src/db/index.js';
import { createActivity, type FeedItem } from '../src/activity/index.js';
import { createRecords } from '../src/records/index.js';
import { DAILY_RUNS, DAILY_TOKENS } from '../src/policy/index.js';
import { freshDb } from './support/db.js';
import { signedRecord } from './support/records.js';
import { activeAgent } from './support/specs.js';
import { Keypair } from '@stellar/stellar-sdk';

const BASE = 'https://agentenact.io';
const tx = () => crypto.randomUUID().replaceAll('-', '').repeat(2);

describe('activity read models', () => {
  let sql: Db;
  let drop: () => Promise<void>;
  beforeAll(async () => {
    ({ sql, drop } = await freshDb());
  });
  afterAll(() => drop());
  const act = () => createActivity(sql, { publicBaseUrl: BASE });

  /** An ended run; `ago` is a Postgres interval string like '1 hour'. */
  async function run(agentId: string, o: { mode?: string; status?: string; summary?: string | null; tx?: string | null; earned?: string; ago?: string }) {
    const rows = (await sql`insert into app.runs (agent_id, mode, status, summary, settlement_tx, usdc_earned, started_at, ended_at)
                            values (${agentId}, ${o.mode ?? 'mission'}, ${o.status ?? 'done'}, ${o.summary ?? null}, ${o.tx ?? null},
                                    ${o.earned ?? '0'}::numeric, now() - ${o.ago ?? '1 minute'}::interval, now() - ${o.ago ?? '1 minute'}::interval)
                            returning id`) as { id: string }[];
    return rows[0]!.id;
  }
  const checkDay = (agentId: string, ago: number, quiet: number, fired: number) =>
    sql`insert into app.check_days (agent_id, day, quiet, fired, last_at)
        values (${agentId}, (now() at time zone 'utc')::date - ${ago}::int, ${quiet}, ${fired}, now() - ${ago + ' days'}::interval)`;

  it("overview counts today's quiet and fired checks and this week's alerts", async () => {
    const a = await activeAgent(sql);
    await checkDay(a.agentId, 0, 7, 2);
    await checkDay(a.agentId, 1, 50, 5); // yesterday does not count
    await run(a.agentId, { status: 'done' });
    await run(a.agentId, { status: 'done', ago: '6 days' });
    await run(a.agentId, { status: 'done', ago: '9 days' }); // too old
    await run(a.agentId, { status: 'error' }); // not an alert
    await run(a.agentId, { mode: 'chat', status: 'done' }); // not a mission
    const o = await act().overview(a.userId, a.agentId);
    expect(o).toMatchObject({ name: 'test agent', status: 'watching', checksToday: 9, alertsThisWeek: 2, earnedUsdc: '0.0000000', salesCount: 0 });
    expect(o.lastAlertAt).not.toBeNull();
  });

  it('an agent over the daily token cap is stopped_today, a stale reset day is not', async () => {
    const a = await activeAgent(sql);
    await sql`update app.users set daily_tokens = ${DAILY_TOKENS}, daily_reset_at = now() where id = ${a.userId}`;
    expect((await act().overview(a.userId, a.agentId)).status).toBe('stopped_today');
    await sql`update app.users set daily_tokens = 0, daily_runs = ${DAILY_RUNS}, daily_reset_at = now() where id = ${a.userId}`;
    expect((await act().overview(a.userId, a.agentId)).status).toBe('stopped_today');
    await sql`update app.users set daily_tokens = ${DAILY_TOKENS}, daily_runs = ${DAILY_RUNS}, daily_reset_at = now() - interval '2 days' where id = ${a.userId}`;
    const o = await act().overview(a.userId, a.agentId);
    expect([o.status, o.budgetUsedPct]).toEqual(['watching', 0]);
  });

  it('budgetUsedPct is 100 at most', async () => {
    const a = await activeAgent(sql);
    await sql`update app.users set daily_tokens = ${DAILY_TOKENS * 3}, daily_runs = 1, daily_reset_at = now() where id = ${a.userId}`;
    expect((await act().overview(a.userId, a.agentId)).budgetUsedPct).toBe(100);
    await sql`update app.users set daily_tokens = ${DAILY_TOKENS / 4}, daily_runs = ${DAILY_RUNS / 5} where id = ${a.userId}`;
    expect((await act().overview(a.userId, a.agentId)).budgetUsedPct).toBe(25);
    await sql`update app.users set daily_tokens = 0, daily_runs = ${DAILY_RUNS / 2} where id = ${a.userId}`;
    expect((await act().overview(a.userId, a.agentId)).budgetUsedPct).toBe(50);
  });

  it('shows setting_up, paused and stopped for the other states', async () => {
    const a = await activeAgent(sql);
    const status = async () => (await act().overview(a.userId, a.agentId)).status;
    await sql`update app.agents set status = 'paused' where id = ${a.agentId}`;
    expect(await status()).toBe('paused');
    await sql`update app.agents set status = 'provisioning' where id = ${a.agentId}`;
    expect(await status()).toBe('setting_up');
    await sql`update app.agents set status = 'revoked' where id = ${a.agentId}`;
    expect(await status()).toBe('stopped');
  });

  it('awaitingFunds is true only while the agent is paused for want of its first USDC', async () => {
    const a = await activeAgent(sql);
    const waits = async () => (await act().overview(a.userId, a.agentId)).awaitingFunds;
    expect(await waits()).toBe(false);
    await sql`update app.agents set status = 'paused' where id = ${a.agentId}`;
    expect(await waits()).toBe(false);
    await sql`update app.agents set paused_for_funds = true where id = ${a.agentId}`;
    expect(await waits()).toBe(true);
    // The reserve worker's flip: active again, the flag cleared in the same update; a stale flag on a live row says nothing.
    await sql`update app.agents set status = 'active' where id = ${a.agentId}`;
    expect(await waits()).toBe(false);
  });

  describe('what the agent page needs to show a first check and a quiet day', () => {
    const logRow = (agentId: string, secondsAgo: number, held: boolean | null, reading: Record<string, number | string> | null) =>
      sql`insert into app.check_log (agent_id, trigger_id, at, held, reading)
          values (${agentId}, ${crypto.randomUUID()}, now() - ${secondsAgo + ' seconds'}::interval, ${held}, ${reading})`;

    it('a brand-new agent has no check, no condition and no answer about the morning note', async () => {
      const a = await activeAgent(sql);
      const o = await act().overview(a.userId, a.agentId);
      expect(o).toMatchObject({ checksTotal: 0, watchesCondition: false, latestCheck: null, morningNote: null });
      expect(Date.now() - Date.parse(o.watchingSince)).toBeLessThan(60_000);
    });

    it('watchesCondition is true only for an enabled condition trigger', async () => {
      const a = await activeAgent(sql);
      const ins = (kind: 'cron' | 'condition', enabled: boolean) =>
        kind === 'cron'
          ? sql`insert into app.triggers (agent_id, spec_version, kind, cron_expr, mission, next_run_at, enabled) values (${a.agentId}, 1, 'cron', '*/5 * * * *', 'm', now(), ${enabled})`
          : sql`insert into app.triggers (agent_id, spec_version, kind, condition, mission, next_run_at, enabled) values (${a.agentId}, 1, 'condition', ${{ fetch: { tool: 'market_price', args: {} }, code: 'return false', every_s: 300 }}, 'm', now(), ${enabled})`;
      await ins('cron', true);
      await ins('condition', false);
      expect((await act().overview(a.userId, a.agentId)).watchesCondition).toBe(false);
      await ins('condition', true);
      expect((await act().overview(a.userId, a.agentId)).watchesCondition).toBe(true);
    });

    it('checksTotal sums every day, today and earlier', async () => {
      const a = await activeAgent(sql);
      await checkDay(a.agentId, 0, 3, 1);
      await checkDay(a.agentId, 2, 10, 0);
      expect((await act().overview(a.userId, a.agentId)).checksTotal).toBe(14);
    });

    it('latestCheck is the newest logged check with its reading, and a failed one has held null', async () => {
      const a = await activeAgent(sql);
      await logRow(a.agentId, 600, false, { symbol: 'XLM', changePct: -0.2, from: 0.1, to: 0.099 });
      await logRow(a.agentId, 30, false, { symbol: 'XLM', changePct: -0.4, from: 0.1, to: 0.0996 });
      expect((await act().overview(a.userId, a.agentId)).latestCheck).toMatchObject({ held: false, reading: { symbol: 'XLM', changePct: -0.4 } });
      await logRow(a.agentId, 5, null, null);
      const o = await act().overview(a.userId, a.agentId);
      expect(o.latestCheck).toMatchObject({ held: null, reading: null });
      expect(Date.parse(o.latestCheck!.at)).toBeGreaterThan(Date.now() - 60_000);
    });

    it("another agent's log never leaks in", async () => {
      const a = await activeAgent(sql);
      const b = await activeAgent(sql);
      await logRow(b.agentId, 5, false, { symbol: 'BTC', changePct: 1, from: 1, to: 2 });
      expect((await act().overview(a.userId, a.agentId)).latestCheck).toBeNull();
    });
  });

  it('earned and sales count only service runs with a settlement tx', async () => {
    const a = await activeAgent(sql);
    await run(a.agentId, { mode: 'service', tx: tx(), earned: '0.0100000' });
    await run(a.agentId, { mode: 'service', tx: tx(), earned: '0.0250000' });
    await run(a.agentId, { mode: 'service', earned: '0.5' }); // no settlement
    await run(a.agentId, { mode: 'mission', earned: '9' }); // not a service
    const o = await act().overview(a.userId, a.agentId);
    expect([o.earnedUsdc, o.salesCount]).toEqual(['0.0350000', 2]);
  });

  it('nextCheckAt is the earliest enabled trigger', async () => {
    const a = await activeAgent(sql);
    expect((await act().overview(a.userId, a.agentId)).nextCheckAt).toBeNull();
    const ins = (at: string, enabled: boolean) =>
      sql`insert into app.triggers (agent_id, spec_version, kind, cron_expr, mission, next_run_at, enabled)
          values (${a.agentId}, 1, 'cron', '*/5 * * * *', 'm', ${at}::timestamptz, ${enabled})`;
    await ins('2031-01-01T00:10:00Z', true);
    await ins('2031-01-01T00:05:00Z', true);
    await ins('2031-01-01T00:01:00Z', false);
    expect((await act().overview(a.userId, a.agentId)).nextCheckAt).toBe('2031-01-01T00:05:00.000Z');
  });

  it('feed groups twenty quiet checks of one day into one item with count 20 and shows an alert and a sale in time order', async () => {
    const a = await activeAgent(sql);
    await checkDay(a.agentId, 0, 20, 1);
    await run(a.agentId, { summary: 'XLM fell 6% in an hour.', ago: '3 hours' });
    const t = tx();
    await run(a.agentId, { mode: 'service', tx: t, earned: '0.0100000', ago: '2 hours' });
    await sql`update app.check_days set last_at = now() - interval '1 hour' where agent_id = ${a.agentId}`;
    const items = await act().feed(a.userId, a.agentId, {});
    expect(items.map((i) => i.type)).toEqual(['quiet', 'sale', 'alert']);
    expect(items[0]).toMatchObject({ type: 'quiet', count: 20 });
    expect(items[2]).toMatchObject({ type: 'alert', text: 'XLM fell 6% in an hour.' });
    expect(items[1]).toMatchObject({ type: 'sale', usdc: '0.0100000' });
    const times = items.map((i) => Date.parse(i.at));
    expect(times).toEqual([...times].sort((x, y) => y - x));
  });

  describe('quiet rows carry what the day\'s checks read', () => {
    const logRow = (agentId: string, secondsAgo: number, held: boolean | null, reading: Record<string, number | string> | null) =>
      sql`insert into app.check_log (agent_id, at, held, reading) values (${agentId}, now() - ${secondsAgo + ' seconds'}::interval, ${held}, ${reading})`;
    const quiet = async (a: { userId: string; agentId: string }) => (await act().feed(a.userId, a.agentId, {})).find((i) => i.type === 'quiet') as Extract<FeedItem, { type: 'quiet' }>;

    it('a price change day gives the first quiet check and the range between the smallest and the biggest move', async () => {
      const a = await activeAgent(sql);
      await checkDay(a.agentId, 0, 3, 0);
      await logRow(a.agentId, 30, false, { symbol: 'XLM', changePct: -1.1, from: 0.2, to: 0.19 });
      await logRow(a.agentId, 90, false, { symbol: 'XLM', changePct: -0.2, from: 0.2, to: 0.19 });
      await logRow(a.agentId, 60, false, { symbol: 'XLM', changePct: -0.5, from: 0.2, to: 0.19 });
      const q = await quiet(a);
      expect(q.range).toBe('XLM between −0.2% and −1.1%');
      const first = (await sql`select min(at) as t from app.check_log where agent_id = ${a.agentId}`)[0]!.t as Date;
      expect(q.since).toBe(first.toISOString());
    });

    it('after an alert the row says since the first quiet check after it, counts and ranges only those checks', async () => {
      const a = await activeAgent(sql);
      await checkDay(a.agentId, 0, 9, 1);
      await logRow(a.agentId, 600, false, { symbol: 'XLM', changePct: -3.9, from: 1, to: 2 });
      await logRow(a.agentId, 500, false, { symbol: 'XLM', changePct: -4.5, from: 1, to: 2 });
      await logRow(a.agentId, 400, true, { symbol: 'XLM', changePct: -5.3, from: 1, to: 2 });
      await logRow(a.agentId, 300, false, { symbol: 'XLM', changePct: -0.4, from: 1, to: 2 });
      await logRow(a.agentId, 200, false, null);
      await logRow(a.agentId, 100, false, { symbol: 'XLM', changePct: -0.9, from: 1, to: 2 });
      const q = await quiet(a);
      expect(q.range).toBe('XLM between −0.4% and −0.9%');
      expect(q.count).toBe(3);
      const first = (await sql`select (now() - interval '300 seconds') as t`)[0]!.t as Date;
      expect(Math.abs(Date.parse(q.since!) - first.getTime())).toBeLessThan(5000);
    });

    it('a day whose last check was an alert has no quiet-since line', async () => {
      const a = await activeAgent(sql);
      await checkDay(a.agentId, 0, 2, 1);
      await logRow(a.agentId, 300, false, { symbol: 'XLM', changePct: -0.4, from: 1, to: 2 });
      await logRow(a.agentId, 100, true, { symbol: 'XLM', changePct: -6, from: 1, to: 2 });
      const q = await quiet(a);
      expect(q.range).toBeUndefined();
      expect(q.count).toBe(2);
    });

    it('a price day gives the lowest and the highest price', async () => {
      const a = await activeAgent(sql);
      await checkDay(a.agentId, 0, 2, 0);
      await logRow(a.agentId, 60, false, { symbol: 'XLM', price: 0.1934 });
      await logRow(a.agentId, 30, false, { symbol: 'XLM', price: 0.1901 });
      expect((await quiet(a)).range).toBe('XLM between $0.1901 and $0.1934');
    });

    it('a payments day gives the total count', async () => {
      const a = await activeAgent(sql);
      await checkDay(a.agentId, 0, 2, 0);
      await logRow(a.agentId, 60, false, { count: 2, largest: '5 USDC' });
      await logRow(a.agentId, 30, false, { count: 1, largest: '3 USDC' });
      expect((await quiet(a)).range).toBe('3 payments seen');
    });

    it('no readings, a fired check, held null, other symbols, or a stale price give no range', async () => {
      const none = await activeAgent(sql);
      await checkDay(none.agentId, 0, 2, 0);
      const q0 = await quiet(none);
      expect(q0.range).toBeUndefined();
      expect(q0.since).toBeUndefined();

      const odd = await activeAgent(sql);
      await checkDay(odd.agentId, 0, 4, 1);
      await logRow(odd.agentId, 60, true, { symbol: 'XLM', changePct: -9, from: 1, to: 2 });
      await logRow(odd.agentId, 50, null, null);
      await logRow(odd.agentId, 40, false, { symbol: 'XLM', changePct: -0.3, from: 1, to: 2, stale: 1 });
      expect((await quiet(odd)).range).toBeUndefined();

      const mixed = await activeAgent(sql);
      await checkDay(mixed.agentId, 0, 2, 0);
      await logRow(mixed.agentId, 60, false, { symbol: 'XLM', changePct: -0.3, from: 1, to: 2 });
      await logRow(mixed.agentId, 30, false, { symbol: 'BTC', changePct: -0.4, from: 1, to: 2 });
      expect((await quiet(mixed)).range).toBeUndefined();
    });

    it("another agent's readings never leak in, and each day has its own range", async () => {
      const a = await activeAgent(sql);
      const b = await activeAgent(sql);
      await checkDay(a.agentId, 0, 1, 0);
      await checkDay(a.agentId, 1, 1, 0);
      await logRow(b.agentId, 30, false, { symbol: 'XLM', price: 9 });
      await logRow(a.agentId, 30, false, { symbol: 'XLM', price: 0.2 });
      await sql`insert into app.check_log (agent_id, at, held, reading) values (${a.agentId}, now() - interval '1 day', false, ${{ symbol: 'XLM', price: 0.3 }})`;
      const items = (await act().feed(a.userId, a.agentId, {})).filter((i) => i.type === 'quiet') as Extract<FeedItem, { type: 'quiet' }>[];
      expect(items.map((i) => i.range)).toEqual(['XLM at $0.2000', 'XLM at $0.3000']);
    });
  });

  it('a sale has a proofUrl only when a record is stored, and a service run without settlement is not a sale', async () => {
    const a = await activeAgent(sql);
    const kp = Keypair.random();
    await sql`update app.agents set stellar_address = ${kp.publicKey()} where id = ${a.agentId}`;
    const withRec = tx();
    const without = tx();
    const r1 = await run(a.agentId, { mode: 'service', tx: withRec, earned: '0.01', ago: '1 hour' });
    await run(a.agentId, { mode: 'service', tx: without, earned: '0.02', ago: '2 hours' });
    await run(a.agentId, { mode: 'service', earned: '0.03', ago: '3 hours' });
    expect(await createRecords(sql).save(a.agentId, r1, withRec, await signedRecord(kp, withRec))).toBe(true);
    const sales = (await act().feed(a.userId, a.agentId, {})).filter((i) => i.type === 'sale');
    expect(sales).toHaveLength(2);
    expect(sales[0]).toMatchObject({ runId: r1, proofUrl: `${BASE}/verify?agent=${a.agentId}&tx=${withRec}` });
    expect('proofUrl' in sales[1]!).toBe(false);
  });

  it('a sale carries its settlement tx; a mission carries the hire payments it settled, never a reserved or failed one; quiet days carry none', async () => {
    const a = await activeAgent(sql);
    const saleTx = tx();
    await run(a.agentId, { mode: 'service', tx: saleTx, earned: '0.01' });
    const alert = await run(a.agentId, { status: 'done', summary: 'hired one' });
    const problem = await run(a.agentId, { status: 'error', ago: '2 minutes' });
    const plain = await run(a.agentId, { status: 'done', ago: '3 minutes' });
    const paid1 = tx();
    const paid2 = tx();
    const payee = Keypair.random().publicKey();
    const spend = (runId: string, decision: string, hash: string | null, amount = '0.01') =>
      sql`insert into app.spend (agent_id, run_id, url, payee, amount_usdc, tx_hash, decision) values (${a.agentId}, ${runId}, 'https://x.test/a', ${payee}, ${amount}::numeric, ${hash}, ${decision})`;
    await spend(alert, 'settled', paid1);
    await spend(alert, 'settled', paid2, '0.02');
    await spend(alert, 'reserved', null);
    await spend(problem, 'failed', null);
    await spend(problem, 'unknown', tx());
    await checkDay(a.agentId, 0, 5, 0);
    const feed = await act().feed(a.userId, a.agentId, {});
    const by = (id: string) => feed.find((i) => 'runId' in i && i.runId === id) as Record<string, unknown> | undefined;
    expect(feed.find((i) => i.type === 'sale')).toMatchObject({ tx: { hash: saleTx, network: 'stellar:testnet' } });
    expect(by(alert)?.payments).toEqual([
      { hash: paid1, network: 'stellar:testnet', usdc: '0.0100000' },
      { hash: paid2, network: 'stellar:testnet', usdc: '0.0200000' },
    ]);
    expect(by(problem)?.payments).toBeUndefined();
    expect(by(plain)?.payments).toBeUndefined();
    const quiet = feed.find((i) => i.type === 'quiet') as Record<string, unknown>;
    expect([quiet.tx, quiet.payments]).toEqual([undefined, undefined]);
  });

  it('an alert without a summary says so in plain words; problems are mission errors and budget stops', async () => {
    const a = await activeAgent(sql);
    await run(a.agentId, { status: 'done', summary: null, ago: '1 hour' });
    const e = await run(a.agentId, { status: 'error', ago: '2 hours' });
    const b = await run(a.agentId, { status: 'budget', ago: '3 hours' });
    await run(a.agentId, { status: 'capped', ago: '4 hours' });
    const items = await act().feed(a.userId, a.agentId, {});
    expect(items.map((i) => i.type)).toEqual(['alert', 'problem', 'problem']);
    expect((items[0] as { text: string }).text.length).toBeGreaterThan(5);
    expect(items.slice(1).map((i) => (i as { runId: string }).runId)).toEqual([e, b]);
  });

  it('chat runs never appear, and the days window applies', async () => {
    const a = await activeAgent(sql);
    await run(a.agentId, { mode: 'chat', status: 'done', summary: 'hi' });
    await run(a.agentId, { mode: 'chat', status: 'error' });
    await run(a.agentId, { status: 'done', summary: 'old', ago: '10 days' });
    await checkDay(a.agentId, 10, 5, 0);
    expect(await act().feed(a.userId, a.agentId, {})).toEqual([]);
    const wide = await act().feed(a.userId, a.agentId, { days: 30 });
    expect(wide.map((i) => i.type).sort()).toEqual(['alert', 'quiet']);
    expect((await act().feed(a.userId, a.agentId, { days: 99 })).length).toBe(2); // clamped, not rejected
  });

  it("another user's or an unknown agent is a 404, for every read", async () => {
    const a = await activeAgent(sql);
    const b = await activeAgent(sql);
    for (const call of [
      () => act().overview(b.userId, a.agentId),
      () => act().feed(b.userId, a.agentId, {}),
      () => act().earnings(b.userId, a.agentId),
      () => act().overview(a.userId, crypto.randomUUID()),
    ]) {
      expect(await call().then(() => null, (e) => (e as { status: number }).status)).toBe(404);
    }
  });

  it('earnings lists sales only, newest first, at most 50', async () => {
    const a = await activeAgent(sql);
    for (let i = 0; i < 52; i++) await run(a.agentId, { mode: 'service', tx: tx(), earned: '0.001', ago: `${i + 1} minutes` });
    await run(a.agentId, { status: 'done', summary: 'x' });
    const e = await act().earnings(a.userId, a.agentId);
    expect(e).toHaveLength(50);
    expect(e.every((i) => i.type === 'sale')).toBe(true);
    const times = e.map((i) => Date.parse(i.at));
    expect(times).toEqual([...times].sort((x, y) => y - x));
  });
});
