import type { Db } from './db.js';
import { isTransientPg, lockFeed } from './feed-lock.js';
import type { HorizonReader } from './chain/horizon.js';
import type { IndexerConfig } from './config.js';
import { exclusionReason } from './rules.js';

const MAX_PAGES_PER_RUN = 5;
const BUSY_MS = 20_000;
const IDLE_MS = 120_000;
const ERROR_MS = 60_000;
const RECENT_MS = 7 * 24 * 3600 * 1000;
const SKIP_AFTER_FAILURES = 3;
const NEW_AGENT_MS = 24 * 3600 * 1000;

export type PaymentsDeps = {
  sql: Db;
  horizon: HorizonReader;
  cfg: Pick<IndexerConfig, 'usdc' | 'sponsors'>;
  now?: () => Date;
  maxWallets?: number;
  pageLimit?: number;
  log?: (e: Record<string, string | number>) => void;
};

// Consecutive commit failures per agent on one cursor, in memory (a restart just starts counting again). Per Db so that
// separate pollers never share state.
const failures = new WeakMap<object, Map<number, { cursor: string | null; n: number }>>();

type Due = { agent_id: number; owner: string; tracked_wallet: string; payments_cursor: string | null };

/**
 * Poll the tracked wallets that are due. Each page's rows and its cursor commit together, so a crash re-reads at most
 * one page and the unique key makes that harmless. A wallet shared by several agents is polled and credited once, to
 * the lowest agent_id. `failed` counts wallets whose poll threw (logged, rescheduled, not rethrown): the loop reads it so a
 * Horizon outage is not an OK tick. Transfers out of the wallet are not stored here: the payee's poll sees them.
 */
export async function pollPayments(d: PaymentsDeps): Promise<{ polled: number; inserted: number; failed: number }> {
  const now = d.now ?? (() => new Date());
  const limit = d.pageLimit ?? 200;
  const t0 = now();
  const due = (await d.sql`
    select a.agent_id, a.owner, a.tracked_wallet, a.payments_cursor
    from discovery.agents a
    where a.tracked_wallet is not null and a.next_poll_at <= ${t0}
      and not exists (select 1 from discovery.agents b where b.tracked_wallet = a.tracked_wallet and b.agent_id < a.agent_id)
    order by a.next_poll_at, a.agent_id
    limit ${d.maxWallets ?? 10}`) as Due[];

  let inserted = 0;
  let failedPolls = 0;
  const failed = failures.get(d.sql) ?? new Map<number, { cursor: string | null; n: number }>();
  failures.set(d.sql, failed);
  for (const a of due) {
    let capped = false;
    let rebound = false;
    try {
      let cursor = a.payments_cursor;
      for (let page = 0; ; page++) {
        if (page >= MAX_PAGES_PER_RUN) {
          capped = true;
          break;
        }
        const res = await d.horizon.accountPayments(a.tracked_wallet, cursor, limit);
        // A page that keeps failing on the same cursor would wedge this agent for good (one row the DB rejects rolls the
        // whole page back): after SKIP_AFTER_FAILURES attempts, insert it row by row and skip what fails.
        const f = failed.get(a.agent_id);
        const skip = !!f && f.cursor === cursor && f.n >= SKIP_AFTER_FAILURES;
        let n: number | null;
        try {
          n = await commitPageRetrying(d, a, res.transfers, res.cursor, skip);
        } catch (e) {
          // A lost race is not a bad page: it must not count toward skipping.
          if (isTransientPg(e)) throw e;
          failed.set(a.agent_id, { cursor, n: f && f.cursor === cursor ? f.n + 1 : 1 });
          throw e;
        }
        failed.delete(a.agent_id);
        if (n === null) {
          rebound = true;
          break;
        }
        inserted += n;
        cursor = res.cursor;
        if (res.done) break;
      }
    } catch {
      // Fixed event, agent id only: the error object may carry URLs.
      failedPolls++;
      d.log?.({ event: 'payments_poll_failed', agent_id: a.agent_id });
      await d.sql`update discovery.agents set next_poll_at = ${new Date(now().getTime() + ERROR_MS)} where agent_id = ${a.agent_id}`;
      continue;
    }
    // The wallet was rebound mid-poll: the rebind already scheduled this agent, do not overwrite it.
    if (rebound) continue;
    const t = now();
    const [row] = (await d.sql`
      select (
        exists (select 1 from discovery.activity where agent_id = ${a.agent_id} and at > ${new Date(t.getTime() - RECENT_MS)})
        or coalesce((select registered_at > ${new Date(t.getTime() - NEW_AGENT_MS)} from discovery.agents where agent_id = ${a.agent_id}), false)
      ) as busy`) as Array<{ busy: boolean }>;
    // A run that hit the page cap still has history to read: come back soon.
    const wait = capped || row?.busy ? BUSY_MS : IDLE_MS;
    await d.sql`update discovery.agents set next_poll_at = ${new Date(t.getTime() + wait)} where agent_id = ${a.agent_id}`;
  }
  return { polled: due.length, inserted, failed: failedPolls };
}

const TRANSIENT_RETRIES = 3;

/** Retry the whole page on a deadlock or serialization error: nothing was committed, and the page is not at fault. */
async function commitPageRetrying(d: PaymentsDeps, a: Due, transfers: Transfers, cursor: string | null, skip: boolean): Promise<number | null> {
  for (let i = 0; ; i++) {
    try {
      return await commitPage(d, a, transfers, cursor, skip);
    } catch (e) {
      if (!isTransientPg(e) || i >= TRANSIENT_RETRIES) throw e;
      d.log?.({ event: 'payments_page_retry', agent_id: a.agent_id });
    }
  }
}

type Transfers = Awaited<ReturnType<HorizonReader['accountPayments']>>['transfers'];

async function commitPage(d: PaymentsDeps, a: Due, transfers: Transfers, cursor: string | null, skip: boolean): Promise<number | null> {
  const mine = transfers.filter((t) => t.to === a.tracked_wallet);
  return d.sql.begin(async (tx: Db) => {
    // Lock order: the feed lock before any row lock (see feed-lock.ts). Pages with nothing of ours write no feed rows.
    if (mine.length > 0) await lockFeed(tx);
    // Re-check under the transaction: a rebind since we selected must not get this wallet's cursor.
    const [still] = (await tx`select 1 as ok from discovery.agents where agent_id = ${a.agent_id} and tracked_wallet = ${a.tracked_wallet} for update`) as unknown[];
    if (!still) return null;

    const froms = [...new Set(mine.map((t) => t.from))];
    const payerOf = new Map<string, number>();
    if (froms.length) {
      const rows = (await tx`
        select tracked_wallet, min(agent_id) as agent_id from discovery.agents
        where tracked_wallet in (select jsonb_array_elements_text(${froms}::jsonb))
        group by tracked_wallet`) as Array<{ tracked_wallet: string; agent_id: number }>;
      for (const r of rows) payerOf.set(r.tracked_wallet, Number(r.agent_id));
    }

    let n = 0;
    for (const t of mine) {
      const reason = exclusionReason(t, { owner: a.owner, wallet: a.tracked_wallet }, d.cfg);
      const counted = reason === null;
      const payerAgent = payerOf.get(t.from) ?? null;
      const insertRow = (q: Db) => insertPayment(q, { agentId: a.agent_id, payerAgent, transfer: t, counted, reason });
      if (!skip) {
        n += await insertRow(tx);
        continue;
      }
      try {
        // Bun's typings omit savepoint on the transaction handle; it exists at runtime (proved by the skip test).
        n += await (tx as unknown as { savepoint: <T>(f: (sp: Db) => Promise<T>) => Promise<T> }).savepoint(insertRow);
      } catch (e) {
        // A deadlock or serialization error says nothing about the row: abort the page and retry it, never skip.
        if (isTransientPg(e)) throw e;
        // Fixed event, op id only: the error object may carry row values.
        d.log?.({ event: 'payment_row_skipped', op_id: t.opId });
      }
    }
    await tx`update discovery.agents set payments_cursor = ${cursor} where agent_id = ${a.agent_id}`;
    return n;
  });
}

export type PaymentRow = {
  agentId: number;
  payerAgent: number | null;
  transfer: Transfers[number];
  counted: boolean;
  reason: string | null;
};

/**
 * Insert one classified transfer; a counted one also moves `last_active_at` and writes its feed line. Returns 1 when the
 * row is new, 0 when it was already stored. The caller holds the feed lock when the row may be counted.
 */
export async function insertPayment(q: Db, p: PaymentRow): Promise<number> {
  const t = p.transfer;
  const at = new Date(t.at);
  const ins = (await q`
    insert into discovery.payments (op_id, idx, agent_id, tx_hash, payer, payer_agent_id, payee, amount_units, asset, at, counted, excluded_reason)
    values (${t.opId}, ${t.idx}, ${p.agentId}, ${t.txHash}, ${t.from}, ${p.payerAgent}, ${t.to}, ${t.amountUnits}, ${t.asset}, ${at}, ${p.counted}, ${p.reason})
    on conflict (op_id, idx) do nothing
    returning op_id`) as unknown[];
  if (ins.length === 0) return 0;
  if (!p.counted) return 1;
  // Chain time, not ingest time.
  await q`update discovery.agents set last_active_at = greatest(last_active_at, ${at}) where agent_id = ${p.agentId} or agent_id = ${p.payerAgent}`;
  await lockFeed(q);
  await q`
    insert into discovery.feed (kind, agent_id, other_agent_id, amount_units, tx_hash, at, source_key)
    values ('paid', ${p.agentId}, ${p.payerAgent}, ${t.amountUnits}, ${t.txHash}, ${at}, ${`pay:${t.opId}:${t.idx}`})
    on conflict (source_key) do nothing`;
  return 1;
}
