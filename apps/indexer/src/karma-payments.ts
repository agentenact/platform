import type { Db } from './db.js';
import { lockFeed } from './feed-lock.js';
import type { KarmaPaymentsReader } from './chain/karma.js';
import type { IndexerConfig } from './config.js';
import { insertPayment } from './payments.js';
import { exclusionReason } from './rules.js';

const EVERY_MS = 30_000;
const MAX_PAGES_PER_RUN = 5;
const PAGE_LIMIT = 500;
/** A full re-read from the start, so a leg whose payee we did not know yet when it streamed by is picked up later. */
const RESYNC_MS = 24 * 3600 * 1000;

export type KarmaPaymentsDeps = {
  sql: Db;
  karma: KarmaPaymentsReader;
  cfg: Pick<IndexerConfig, 'usdc' | 'sponsors'>;
  now?: () => Date;
  everyMs?: number;
  maxPages?: number;
  pageLimit?: number;
  log?: (e: Record<string, string | number>) => void;
};

// Last run per Db, in memory: the loop ticks this stage every few seconds, the feed only needs reading every EVERY_MS.
const lastRun = new WeakMap<object, number>();

const getMeta = async (sql: Db, key: string) =>
  ((await sql`select value from discovery.meta where key = ${key}`) as Array<{ value: string }>)[0]?.value ?? null;

/**
 * The payments stage when payments come from AgentKarma instead of our own Horizon polling. Pages through AgentKarma's
 * feed from the stored cursor; each page's rows and the cursor commit together, so a crash re-reads at most one page and
 * the primary key makes that harmless. Same result shape as pollPayments: `polled` pages, `failed` 1 when the read threw
 * (the loop then does not count the tick as OK), so `payments_ok_at` still means "the source answered".
 */
export async function pollKarmaPayments(d: KarmaPaymentsDeps): Promise<{ polled: number; inserted: number; failed: number }> {
  const now = d.now ?? (() => new Date());
  const t0 = now().getTime();
  const last = lastRun.get(d.sql);
  if (last !== undefined && t0 - last < (d.everyMs ?? EVERY_MS)) return { polled: 0, inserted: 0, failed: 0 };
  lastRun.set(d.sql, t0);

  const resyncAt = await getMeta(d.sql, 'karma_payments_resync_at');
  let cursor = await getMeta(d.sql, 'karma_payments_cursor');
  if (!resyncAt || t0 - Date.parse(resyncAt) >= RESYNC_MS) {
    cursor = null;
    await d.sql`insert into discovery.meta (key, value) values ('karma_payments_resync_at', ${new Date(t0).toISOString()})
                on conflict (key) do update set value = excluded.value`;
  }

  let polled = 0;
  let inserted = 0;
  for (let i = 0; i < (d.maxPages ?? MAX_PAGES_PER_RUN); i++) {
    let page: Awaited<ReturnType<KarmaPaymentsReader['page']>>;
    try {
      page = await d.karma.page(cursor, d.pageLimit ?? PAGE_LIMIT);
    } catch {
      // Fixed event: the error object may carry the URL.
      d.log?.({ event: 'karma_payments_failed' });
      return { polled: polled + 1, inserted, failed: 1 };
    }
    polled++;
    if (page.dropped > 0) d.log?.({ event: 'karma_payments_dropped', rows: page.dropped });
    const res = await commitPage(d, page.transfers, page.cursor);
    inserted += res.inserted;
    if (res.unknown > 0) d.log?.({ event: 'karma_payments_unknown_payee', rows: res.unknown });
    cursor = page.cursor;
    if (page.done) break;
  }
  return { polled, inserted, failed: 0 };
}

type Transfers = Awaited<ReturnType<KarmaPaymentsReader['page']>>['transfers'];

async function commitPage(d: KarmaPaymentsDeps, transfers: Transfers, cursor: string | null): Promise<{ inserted: number; unknown: number }> {
  return d.sql.begin(async (tx: Db) => {
    // Lock order: the feed lock before any row lock (see feed-lock.ts).
    if (transfers.length > 0) await lockFeed(tx);
    const addrs = [...new Set(transfers.flatMap((t) => [t.to, t.from]))];
    // A wallet shared by several agents is credited once, to the lowest agent_id (as in pollPayments).
    const owners = new Map<string, { agentId: number; owner: string }>();
    if (addrs.length) {
      const rows = (await tx`
        select distinct on (tracked_wallet) tracked_wallet, agent_id, owner from discovery.agents
        where tracked_wallet in (select jsonb_array_elements_text(${addrs}::jsonb))
        order by tracked_wallet, agent_id`) as Array<{ tracked_wallet: string; agent_id: number; owner: string }>;
      for (const r of rows) owners.set(r.tracked_wallet, { agentId: Number(r.agent_id), owner: r.owner });
    }
    let inserted = 0;
    let unknown = 0;
    for (const t of transfers) {
      const payee = owners.get(t.to);
      if (!payee) {
        unknown++;
        continue;
      }
      // Our Horizon decoder and AgentKarma number legs within an operation differently when it also moves another asset.
      // The same leg already stored under our own numbering is the same payment: never count it twice.
      const [dup] = (await tx`
        select 1 as x from discovery.payments
        where op_id = ${t.opId} and idx <> ${t.idx} and payee = ${t.to} and payer = ${t.from} and amount_units = ${t.amountUnits}
        limit 1`) as unknown[];
      if (dup) continue;
      const reason = exclusionReason(t, { owner: payee.owner, wallet: t.to }, d.cfg);
      inserted += await insertPayment(tx, {
        agentId: payee.agentId,
        payerAgent: owners.get(t.from)?.agentId ?? null,
        transfer: t,
        counted: reason === null,
        reason,
      });
    }
    if (cursor !== null) {
      await tx`insert into discovery.meta (key, value) values ('karma_payments_cursor', ${cursor})
               on conflict (key) do update set value = excluded.value`;
    }
    return { inserted, unknown };
  });
}
