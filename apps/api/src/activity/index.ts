/**
 * `activity`: the read models behind the panel's agent page (spec §4.4). Reads only, never a write.
 * Every read is scoped by agent AND user, so another user's agent (or an unknown one) is a 404, never a 403.
 * "Today" is the UTC day of the DATABASE clock, the same day `policy` resets its caps on, and a stale
 * `daily_reset_at` counts as zero. A handful of SQL reads per call; nothing runs per feed item.
 */
import { httpError } from '../errors.js';
import type { Db } from '../db/index.js';
import { DAILY_RUNS, DAILY_TOKENS } from '../policy/index.js';
import { createChecks } from '../runs/checks.js';
import { CLAIM_LEASE_MIN } from '../scheduler/index.js';
import { usd } from '../checks/readings.js';
import type { SealRow, Seals } from '../seals/index.js';
import { createModelDirectory, MODEL_CHOICES, type ModelDirectory, type ModelView } from '../loop/model-choices.js';

export type AgentStatus = 'setting_up' | 'watching' | 'paused' | 'stopped_today' | 'stopped';

export interface Overview {
  name: string;
  status: AgentStatus;
  nextCheckAt: string | null;
  lastAlertAt: string | null;
  checksToday: number;
  alertsThisWeek: number;
  /** USDC with 7 decimals, as stored. */
  earnedUsdc: string;
  salesCount: number;
  budgetUsedPct: number;
  /** When the agent was made (days watching). */
  watchingSince: string;
  /** Checks ever counted, all days (not only today). */
  checksTotal: number;
  /** An enabled condition trigger exists, so a first check is coming and will be logged. */
  watchesCondition: boolean;
  /**
   * A check is due or in flight right now (Run now, or the schedule). `nextCheckAt` then leaves out the trigger being run:
   * the scheduler's 25-minute claim lease is bookkeeping, never a time to show.
   */
  running: boolean;
  /**
   * The newest finished mission (a scheduled run, Run now, or a condition that held): when it ended, its id for the
   * feed's `?run=` link, and whether it finished. null when the agent has none. A clock-driven agent writes no check
   * log, so this is its "last check".
   */
  lastRun: { at: string; runId: string; ok: boolean } | null;
  /** The newest logged check (kept 7 days); `held` is null when it could not finish. null when there is none. */
  latestCheck: { at: string; held: boolean | null; reading: Record<string, number | string> | null } | null;
  /** The owner's answer to the morning note: null = not asked yet. */
  morningNote: boolean | null;
  /** The model its runs use, the owner's pick (null = the platform default) and the list to pick from. */
  model: ModelView;
  /**
   * Paused only until its first testnet USDC has bought its own reserves (FEE_MODEL=agent, agents/reserve.ts). The owner
   * cannot resume it (409 awaiting_funds); the reserve worker does, within minutes of the funding.
   */
  awaitingFunds: boolean;
}

/** A transaction on chain: its hash (64 hex, as stored) and the CAIP-2 network it settled on. Hosted agents settle on testnet only. */
export interface ChainTx {
  hash: string;
  network: string;
}
/** What a run paid when it hired another agent: one settled payment each. */
export type RunPayment = ChainTx & { usdc: string };

/** Every settlement and hire payment the platform makes today is on Stellar testnet (signer/hire.ts). */
export const SETTLEMENT_NETWORK = 'stellar:testnet';

export type SaleItem = { type: 'sale'; at: string; runId: string; usdc: string; proofUrl?: string; tx: ChainTx };
export type FeedItem =
  | { type: 'alert'; at: string; runId: string; text: string; payments?: RunPayment[]; decision?: DecisionSeal }
  | SaleItem
  /**
   * `range` and `since` ride along when the day's quiet checks left readings: "XLM between −0.2% and −1.1%", the first quiet
   * check's time. `seals` counts the day's checks (every one, fired too) sealed on chain, with the newest landed one.
   */
  | { type: 'quiet'; day: string; count: number; at: string; range?: string; since?: string; seals?: DaySealsItem }
  | { type: 'problem'; at: string; runId: string; payments?: RunPayment[]; decision?: DecisionSeal };

/** A mission's decision seal on Stellar (seals/format.ts ae.decision/1): `tx` once it has landed. */
export interface DecisionSeal {
  status: 'pending' | 'sent' | 'failed';
  tx: ChainTx | null;
}

export interface DaySealsItem {
  total: number;
  sent: number;
  failed: number;
  last: ChainTx | null;
}

/**
 * What a run is doing right now, for the agent page to poll while it runs. `phase`: idle (nothing due or running), queued
 * (due, the scheduler has not picked it up yet: within 30 s), starting (picked up; a condition check, or the mission being
 * prepared), working (the mission is running: `lines` are its finished tool calls in plain words, `text` the tail of what
 * it has written so far), finishing (the mission ended and its answer is being delivered). Never tool inputs or results.
 */
export interface LiveRun {
  phase: 'idle' | 'queued' | 'starting' | 'working' | 'finishing';
  /** When the scheduler picked it up; null while queued or idle. */
  since: string | null;
  lines: string[];
  text: string;
}
/** Plain lines kept for the live view: the newest ones. */
export const LIVE_LINES = 6;

export interface Activity {
  overview(userId: string, agentId: string): Promise<Overview>;
  /** The live view of the agent's current run. Unknown or foreign agent 404. */
  live(userId: string, agentId: string): Promise<LiveRun>;
  /** Newest first. `days` is clamped to 1-30 (default 7) and counts today. */
  feed(userId: string, agentId: string, o: { days?: number }): Promise<FeedItem[]>;
  /** Sales only, newest 50. */
  earnings(userId: string, agentId: string): Promise<SaleItem[]>;
  /** One UTC day's check seals with their documents (the owner's proof download); [] without seals. */
  seals(userId: string, agentId: string, day: string): Promise<SealRow[]>;
}

export const FEED_DEFAULT_DAYS = 7;
export const FEED_MAX_DAYS = 30;
export const EARNINGS_LIMIT = 50;
const FEED_RUN_LIMIT = 500;
/** Plain words for a finished mission that left no summary (spec §5: no technical terms). */
export const NO_SUMMARY_TEXT = 'Your agent checked in and has something for you.';

const clampDays = (d: number | undefined): number =>
  d === undefined || !Number.isFinite(d) ? FEED_DEFAULT_DAYS : Math.min(Math.max(Math.trunc(d), 1), FEED_MAX_DAYS);

const iso = (d: Date): string => d.toISOString();

interface SaleRow {
  id: string;
  at: Date;
  usdc: string;
  has_record: boolean;
  settlement_tx: string;
}

interface DayReadRow {
  day: string;
  since: Date;
  /** Quiet checks after the day's last alert (all of them, with or without a reading). */
  n: number;
  symbols: number;
  symbol: string | null;
  n_change: number;
  change_min: string | null;
  change_max: string | null;
  n_price: number;
  price_min: string | null;
  price_max: string | null;
  n_pay: number;
  pay_total: string | null;
}

/** One decimal, true minus: "−0.2%", "+1.1%". */
function pct1(n: number): string {
  const t = Math.abs(n).toFixed(1);
  return `${n < 0 && Number(t) !== 0 ? '−' : n > 0 && Number(t) !== 0 ? '+' : ''}${t}%`;
}

/** "XLM between −0.2% and −1.1%" / "XLM between $0.1901 and $0.1934" / "3 payments seen"; null when the day has nothing consistent to say. */
function rangeText(r: DayReadRow): string | null {
  const pair = (lo: number, hi: number, f: (n: number) => string, first: 'lo' | 'hi'): string => {
    const [a, b] = first === 'lo' ? [lo, hi] : [hi, lo];
    return f(a) === f(b) ? `at ${f(a)}` : `between ${f(a)} and ${f(b)}`;
  };
  if (r.symbols === 1 && r.symbol && r.n_change > 0 && r.change_min !== null && r.change_max !== null) {
    const lo = Number(r.change_min);
    const hi = Number(r.change_max);
    // A falling day reads from the small move to the big one (−0.2% and −1.1%).
    return `${r.symbol} ${pair(lo, hi, pct1, hi <= 0 ? 'hi' : 'lo')}`;
  }
  if (r.symbols === 1 && r.symbol && r.n_price > 0 && r.price_min !== null && r.price_max !== null && r.n_change === 0)
    return `${r.symbol} ${pair(Number(r.price_min), Number(r.price_max), usd, 'lo')}`;
  if (r.n_pay > 0 && r.pay_total !== null && r.n_change === 0 && r.n_price === 0) {
    const total = Number(r.pay_total);
    return total === 0 ? 'no payments seen' : `${total} ${total === 1 ? 'payment' : 'payments'} seen`;
  }
  return null;
}

export function createActivity(sql: Db, o: { publicBaseUrl: string; now?: () => Date; seals?: Pick<Seals, 'days' | 'day' | 'decisions'>; models?: Pick<ModelDirectory, 'view'> }): Activity {
  const models = o.models ?? createModelDirectory({ defaultId: MODEL_CHOICES[0]!.id });
  const checks = createChecks(sql);

  async function owned(userId: string, agentId: string): Promise<void> {
    const rows = (await sql`select 1 from app.agents where id = ${agentId} and user_id = ${userId}`) as unknown[];
    if (rows.length === 0) throw httpError(404, 'not_found');
  }

  const sale = (agentId: string, r: SaleRow): SaleItem => ({
    type: 'sale',
    at: iso(r.at),
    runId: r.id,
    usdc: r.usdc,
    ...(r.has_record ? { proofUrl: `${o.publicBaseUrl}/verify?agent=${agentId}&tx=${r.settlement_tx}` } : {}),
    tx: { hash: r.settlement_tx, network: SETTLEMENT_NETWORK },
  });

  return {
    async live(userId, agentId) {
      const [a] = (await sql`
        select (select max(t.claimed_at) from app.triggers t where t.agent_id = a.id and t.enabled and t.claimed_at is not null
                  and t.next_run_at = t.claimed_at + make_interval(mins => ${CLAIM_LEASE_MIN})) as claimed_at,
               exists (select 1 from app.triggers t where t.agent_id = a.id and t.enabled and t.next_run_at <= now()) as due
        from app.agents a where a.id = ${agentId} and a.user_id = ${userId}`) as { claimed_at: Date | null; due: boolean }[];
      if (!a) throw httpError(404, 'not_found');
      if (!a.claimed_at) return { phase: a.due ? 'queued' : 'idle', since: null, lines: [], text: '' };
      const since = iso(a.claimed_at);
      const [r] = (await sql`select status, steps, live_text from app.runs
                             where agent_id = ${agentId} and mode = 'mission' and started_at >= ${a.claimed_at}
                             order by started_at desc limit 1`) as { status: string; steps: unknown; live_text: string | null }[];
      if (!r) return { phase: 'starting', since, lines: [], text: '' };
      const lines: string[] = [];
      for (const s of Array.isArray(r.steps) ? r.steps : [])
        for (const c of Array.isArray((s as { calls?: unknown })?.calls) ? (s as { calls: unknown[] }).calls : [])
          if (typeof (c as { line?: unknown })?.line === 'string') lines.push((c as { line: string }).line);
      return { phase: r.status === 'running' ? 'working' : 'finishing', since, lines: lines.slice(-LIVE_LINES), text: r.live_text ?? '' };
    },

    async overview(userId, agentId) {
      const rows = (await sql`
        select a.name, a.status, u.daily_tokens, u.daily_runs,
               u.daily_reset_at >= date_trunc('day', now(), 'UTC') as fresh,
               (select min(t.next_run_at) from app.triggers t where t.agent_id = a.id and t.enabled
                  and not (t.claimed_at is not null and t.next_run_at = t.claimed_at + make_interval(mins => ${CLAIM_LEASE_MIN}) and t.next_run_at > now())) as next_check_at,
               exists (select 1 from app.triggers t where t.agent_id = a.id and t.enabled
                  and (t.next_run_at <= now() or (t.claimed_at is not null and t.next_run_at = t.claimed_at + make_interval(mins => ${CLAIM_LEASE_MIN})))) as running,
               (select max(coalesce(r.ended_at, r.started_at)) from app.runs r
                 where r.agent_id = a.id and r.mode = 'mission' and r.status = 'done') as last_alert_at,
               (select coalesce(sum(c.quiet + c.fired), 0)::int from app.check_days c
                 where c.agent_id = a.id and c.day = (now() at time zone 'utc')::date) as checks_today,
               (select count(*)::int from app.runs r
                 where r.agent_id = a.id and r.mode = 'mission' and r.status = 'done' and r.started_at >= now() - interval '7 days') as alerts_week,
               (select coalesce(sum(r.usdc_earned), 0)::numeric(20,7)::text from app.runs r
                 where r.agent_id = a.id and r.mode = 'service' and r.settlement_tx is not null) as earned,
               (select count(*)::int from app.runs r
                 where r.agent_id = a.id and r.mode = 'service' and r.settlement_tx is not null) as sales,
               a.created_at, a.morning_note, a.model, a.paused_for_funds,
               (select to_jsonb(lr) from (select r.id as "runId", r.status = 'done' as ok,
                                                 to_char(coalesce(r.ended_at, r.started_at) at time zone 'utc', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') as at
                                          from app.runs r where r.agent_id = a.id and r.mode = 'mission' and r.status in ('done', 'error', 'budget')
                                          order by coalesce(r.ended_at, r.started_at) desc limit 1) lr) as last_run,
               (select coalesce(sum(c.quiet + c.fired), 0)::int from app.check_days c where c.agent_id = a.id) as checks_total,
               exists (select 1 from app.triggers t where t.agent_id = a.id and t.enabled and t.kind = 'condition') as watches_condition,
               (select to_jsonb(l) from (select to_char(cl.at at time zone 'utc', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') as at, cl.held, cl.reading
                                          from app.check_log cl where cl.agent_id = a.id order by cl.at desc limit 1) l) as latest_check
        from app.agents a join app.users u on u.id = a.user_id
        where a.id = ${agentId} and a.user_id = ${userId}`) as {
        name: string;
        status: string;
        daily_tokens: number;
        daily_runs: number;
        fresh: boolean;
        next_check_at: Date | null;
        last_alert_at: Date | null;
        checks_today: number;
        alerts_week: number;
        earned: string;
        sales: number;
        created_at: Date;
        morning_note: boolean | null;
        model: string | null;
        paused_for_funds: boolean;
        checks_total: number;
        watches_condition: boolean;
        running: boolean;
        last_run: { at: string; runId: string; ok: boolean } | null;
        latest_check: { at: string; held: boolean | null; reading: Record<string, number | string> | null } | null;
      }[];
      const r = rows[0];
      if (!r) throw httpError(404, 'not_found');
      const tokens = r.fresh ? Number(r.daily_tokens) : 0;
      const runs = r.fresh ? Number(r.daily_runs) : 0;
      const status: AgentStatus =
        r.status === 'paused' ? 'paused'
        : r.status === 'revoked' ? 'stopped'
        : r.status !== 'active' ? 'setting_up'
        : tokens >= DAILY_TOKENS || runs >= DAILY_RUNS ? 'stopped_today'
        : 'watching';
      return {
        name: r.name,
        status,
        nextCheckAt: r.next_check_at ? iso(r.next_check_at) : null,
        lastAlertAt: r.last_alert_at ? iso(r.last_alert_at) : null,
        checksToday: r.checks_today,
        alertsThisWeek: r.alerts_week,
        earnedUsdc: r.earned,
        salesCount: r.sales,
        budgetUsedPct: Math.min(100, Math.round(Math.max(tokens / DAILY_TOKENS, runs / DAILY_RUNS) * 100)),
        watchingSince: iso(r.created_at),
        checksTotal: r.checks_total,
        watchesCondition: r.watches_condition,
        running: r.running,
        lastRun: r.last_run,
        latestCheck: r.latest_check,
        morningNote: r.morning_note,
        model: await models.view(r.model),
        awaitingFunds: r.status === 'paused' && r.paused_for_funds,
      };
    },

    async feed(userId, agentId, opts) {
      const days = clampDays(opts.days);
      await owned(userId, agentId);
      // The window is whole UTC days of the database clock, today included.
      const since = ((await sql`select date_trunc('day', now(), 'UTC') - ${days - 1} * interval '1 day' as since`) as { since: Date }[])[0]!.since;
      const [runRows, reads, checkDays, sealDays] = await Promise.all([
        sql`select r.id, r.mode, r.status, r.summary, coalesce(r.ended_at, r.started_at) as at, r.usdc_earned::text as usdc,
                   r.settlement_tx, rec.tx_hash is not null as has_record
            from app.runs r
            join app.agents a on a.id = r.agent_id
            left join app.records rec on rec.tx_hash = r.settlement_tx and rec.agent_id = r.agent_id
            where r.agent_id = ${agentId} and a.user_id = ${userId} and r.started_at >= ${since}
              and ((r.mode = 'mission' and r.status in ('done', 'error', 'budget')) or (r.mode = 'service' and r.settlement_tx is not null))
            order by r.started_at desc limit ${FEED_RUN_LIMIT}` as Promise<(SaleRow & { mode: string; status: string; summary: string | null })[]>,
        // One aggregate per day over the window, served by the (agent_id, at) index: the quiet checks after the day's last alert.
        sql`with l as (
              select (at at time zone 'utc')::date as d, at, held, case when reading->'stale' is null then reading end as r
              from app.check_log where agent_id = ${agentId} and at >= ${since}
            ), f as (select d, max(at) filter (where held = true) as last_fired from l group by d)
            select to_char(l.d, 'YYYY-MM-DD') as day, min(l.at) as since, count(*)::int as n,
                   count(distinct l.r->>'symbol')::int as symbols, min(l.r->>'symbol') as symbol,
                   count(*) filter (where jsonb_typeof(l.r->'changePct') = 'number')::int as n_change,
                   (min((l.r->>'changePct')::numeric) filter (where jsonb_typeof(l.r->'changePct') = 'number'))::text as change_min,
                   (max((l.r->>'changePct')::numeric) filter (where jsonb_typeof(l.r->'changePct') = 'number'))::text as change_max,
                   count(*) filter (where jsonb_typeof(l.r->'price') = 'number')::int as n_price,
                   (min((l.r->>'price')::numeric) filter (where jsonb_typeof(l.r->'price') = 'number'))::text as price_min,
                   (max((l.r->>'price')::numeric) filter (where jsonb_typeof(l.r->'price') = 'number'))::text as price_max,
                   count(*) filter (where jsonb_typeof(l.r->'count') = 'number')::int as n_pay,
                   (sum((l.r->>'count')::numeric) filter (where jsonb_typeof(l.r->'count') = 'number'))::text as pay_total
            from l join f on f.d = l.d
            where l.held = false and (f.last_fired is null or l.at > f.last_fired)
            group by l.d` as Promise<DayReadRow[]>,
        checks.days(agentId, o.now ? new Date(o.now().getTime() - (days - 1) * 86_400_000) : since),
        o.seals ? o.seals.days(agentId, since) : Promise.resolve([]),
      ]);
      const sealsByDay = new Map(sealDays.map((s) => [s.day, s]));
      // What the missions paid when they hired another agent: settled payments only, one read for the whole window.
      const missionIds = runRows.filter((r) => r.mode !== 'service').map((r) => r.id);
      const paid = new Map<string, RunPayment[]>();
      if (missionIds.length > 0) {
        const rows = (await sql`select run_id, tx_hash, amount_usdc::text as usdc from app.spend
                                where agent_id = ${agentId} and decision = 'settled' and tx_hash is not null
                                  and run_id = any(${`{${missionIds.join(',')}}`}::uuid[])
                                order by created_at`) as { run_id: string; tx_hash: string; usdc: string }[];
        for (const p of rows) paid.set(p.run_id, [...(paid.get(p.run_id) ?? []), { hash: p.tx_hash, network: SETTLEMENT_NETWORK, usdc: p.usdc }]);
      }
      const decided = o.seals ? await o.seals.decisions(agentId, missionIds) : new Map<string, { status: DecisionSeal['status']; tx: string | null }>();
      const items: FeedItem[] = [];
      for (const r of runRows) {
        const payments = paid.get(r.id);
        const sealed = decided.get(r.id);
        const pays = {
          ...(payments ? { payments } : {}),
          ...(sealed ? { decision: { status: sealed.status, tx: sealed.tx ? { hash: sealed.tx, network: SETTLEMENT_NETWORK } : null } } : {}),
        };
        if (r.mode === 'service') items.push(sale(agentId, r));
        else if (r.status === 'done') items.push({ type: 'alert', at: iso(r.at), runId: r.id, text: r.summary?.trim() ? r.summary : NO_SUMMARY_TEXT, ...pays });
        else items.push({ type: 'problem', at: iso(r.at), runId: r.id, ...pays });
      }
      const byDay = new Map(reads.map((r) => [r.day, r]));
      for (const d of checkDays) {
        if (d.quiet === 0) continue;
        const read = byDay.get(d.day);
        const range = read ? rangeText(read) : null;
        const sd = sealsByDay.get(d.day);
        const seals = sd ? { seals: { total: sd.total, sent: sd.sent, failed: sd.failed, last: sd.last ? { hash: sd.last.hash, network: SETTLEMENT_NETWORK } : null } } : {};
        // With a range the row speaks for the checks since the day's last alert, so count and since describe exactly those.
        items.push(range && read ? { type: 'quiet', day: d.day, count: read.n, at: iso(d.lastAt), range, since: iso(read.since), ...seals } : { type: 'quiet', day: d.day, count: d.quiet, at: iso(d.lastAt), ...seals });
      }
      return items.sort((x, y) => Date.parse(y.at) - Date.parse(x.at));
    },

    async earnings(userId, agentId) {
      await owned(userId, agentId);
      const rows = (await sql`select r.id, coalesce(r.ended_at, r.started_at) as at, r.usdc_earned::text as usdc, r.settlement_tx,
                                     rec.tx_hash is not null as has_record
                              from app.runs r
                              join app.agents a on a.id = r.agent_id
                              left join app.records rec on rec.tx_hash = r.settlement_tx and rec.agent_id = r.agent_id
                              where r.agent_id = ${agentId} and a.user_id = ${userId} and r.mode = 'service' and r.settlement_tx is not null
                              order by r.started_at desc limit ${EARNINGS_LIMIT}`) as SaleRow[];
      return rows.map((r) => sale(agentId, r));
    },

    async seals(userId, agentId, day) {
      await owned(userId, agentId);
      return o.seals ? o.seals.day(agentId, day) : [];
    },
  };
}
