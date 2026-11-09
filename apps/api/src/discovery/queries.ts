import { communityTxCtes } from '../community-txs.js';
import type { Db } from '../db/index.js';
import type { Karma, KarmaFacts } from './karma.js';
import { predicates } from './predicates.js';
import { likePattern } from './text.js';

export type Builder = 'hosted' | 'library' | 'external';

export interface Stats {
  network: 'testnet';
  agents: number;
  provenOutputs: number;
  /** sum of the amounts of proven sales (verified Enactment Records) */
  usdcProven: string;
  /** sum of counted USDC payments received by agents (on-chain transfers, proven or not) */
  usdcTransfers: string;
  /** distinct agents with a payment sent/received or a proven sale in the rolling last hour (registrations and binds excluded) */
  activeLastHour: number;
  /** counted USDC payments received by agents (the rows behind usdcTransfers) */
  payments: number;
  /** on-chain seal txs (check and decision seals) our hosted agents have sent, deleted agents included: the txs stay on chain */
  seals: number;
  /** AgentEnact itself, with the e2e test and house accounts (test-accounts.ts) left out of every count. */
  community: CommunityCounts;
  asOf: string;
  indexedThrough: string | null;
  stale: boolean;
}

export interface CommunityCounts {
  /** accounts that signed in (app.users), whether or not they made an agent */
  people: number;
  /** hosted agents ever created (drafts excluded, deleted agents included) */
  agents: number;
  /** on-chain seal txs those agents sent */
  seals: number;
  /** distinct Stellar transactions of those agents: their seals, their registry events, and the USDC transfers they sent
   * or received (no test agent on either side). Agents built elsewhere are left out, like they are from `agents`. */
  txs: number;
  /** the newest of those seals and of those transactions, so each figure can open one on a block explorer; null before the first */
  latestSealTx: string | null;
  latestTx: string | null;
}

export type FeedLink =
  | { type: 'proof'; ref: string; agentUuid: string | null }
  | { type: 'payment'; txHash: string }
  | { type: 'registration'; txHash: string };

export interface FeedItem {
  seq: number;
  kind: 'paid' | 'registered' | 'service_opened';
  at: string;
  agentId: number;
  builder: Builder;
  otherAgentId: number | null;
  amount: string | null;
  label: string | null;
  selfPublished: boolean;
  link: FeedLink | null;
}

/** Where per-agent payment figures come from, and whether they could be read. `asOf`: last good AgentKarma snapshot. */
export interface PaymentsSource {
  source: 'agentkarma';
  available: boolean;
  asOf: string | null;
}

/** AgentKarma's score for the agent (as a provider) and its tier label; null when AgentKarma has none or is unavailable. */
export type KarmaScore = { score: number | null; tier: string | null } | null;

export interface AgentCard {
  id: number;
  builder: Builder;
  /** `description`: what the agent says it does, in its own registration document. */
  selfPublished: {
    name: string | null;
    description: string | null;
    service: { slug: string; description: string | null; priceUsdc: string | null } | null;
  } | null;
  /** From AgentKarma (successful USDC payments received). null: AgentKarma unavailable or does not list the agent yet. */
  paymentsReceived: number | null;
  usdcReceived: string | null;
  /** latest payment received, from AgentKarma; null if none or unknown */
  lastPaymentAt: string | null;
  provenSales: number;
  /** Checks and decisions a hosted agent has sealed on chain (its own testnet txs); 0 for every other agent. */
  seals: number;
  lastActiveAt: string | null;
  karma: KarmaScore;
  /** Can be hired, and how (see HireOffer). null: not for hire. */
  hire: HireOffer | null;
}

/**
 * How an agent can be hired. `priceUsdc`: its lowest published price (null: it takes x402 but quotes the price when
 * called). `service`: the service to call, with the https url its own document names (null: none named yet).
 *
 * An agent built here (hosted or library) is for hire when its document says it takes x402 or lists a priced service.
 * An external agent is for hire only when a priced service names a url we would call (Kerem, 2026-11-04: external
 * agents that only said "x402" showed on Hire with nothing anyone could call): a plain x402 POST is all hire_agent does.
 */
export type HireOffer = { priceUsdc: string | null; service: { slug: string; url: string } | null };

/**
 * ERC-8004 endpoint names: where an agent can be reached or read about, never a paid service to call. `web` doubles as
 * the agent's site on its profile.
 */
export const ENDPOINT_SLUGS = ['web', 'mcp', 'a2a', 'oasf', 'ens', 'did', 'agentwallet', 'agent-wallet', 'stellar-agent-services'] as const;
const PRICED = /^[0-9]+([.][0-9]+)?$/;
const isPriced = (p: string | null): p is string => p !== null && PRICED.test(p) && /[1-9]/.test(p);

/** HireOffer from the agent's facts. `callable`: its cheapest priced service with a url (any service with a url when none is priced). */
export function hireOfferOf(a: {
  builder: Builder;
  hidden: boolean;
  selfPublished: boolean;
  x402: boolean;
  minPrice: string | null;
  callable: { slug: string; url: string; priceUsdc: string | null } | null;
}): HireOffer | null {
  if (a.hidden || !a.selfPublished) return null;
  const service = a.callable ? { slug: a.callable.slug, url: a.callable.url } : null;
  if (a.builder === 'external') {
    return a.callable && isPriced(a.callable.priceUsdc) ? { priceUsdc: a.callable.priceUsdc, service } : null;
  }
  if (!a.x402 && !isPriced(a.minPrice)) return null;
  return { priceUsdc: isPriced(a.minPrice) ? a.minPrice : null, service };
}

/** The service an offer names: cheapest priced first, then any with a url; endpoint names never. */
function callableOf(rows: { slug: string; url: string | null; priceUsdc: string | null }[]): { slug: string; url: string; priceUsdc: string | null } | null {
  const ok = rows.filter((r): r is { slug: string; url: string; priceUsdc: string | null } => r.url !== null && !(ENDPOINT_SLUGS as readonly string[]).includes(r.slug));
  const priced = ok.filter((r) => isPriced(r.priceUsdc)).sort((x, y) => Number(x.priceUsdc) - Number(y.priceUsdc) || x.slug.localeCompare(y.slug));
  return priced[0] ?? ok.sort((x, y) => x.slug.localeCompare(y.slug))[0] ?? null;
}

/** How /public/agents orders the list. `recent` (last activity) is the default and the only keyset-paged order. */
export const AGENT_SORTS = ['recent', 'paid', 'proofs', 'karma', 'newest'] as const;
export type AgentSort = (typeof AGENT_SORTS)[number];

/**
 * Narrowing filters, ANDed. `built`: AgentEnact (hosted or library) vs external; `sells`: publishes a service (any endpoint);
 * `hire`: can be hired (see AgentCard.hire); `paid`: has a payment or a proven sale.
 */
export interface AgentFilter {
  built?: 'agentenact' | 'external';
  sells?: boolean;
  hire?: boolean;
  paid?: boolean;
}

export interface AgentsQuery {
  q?: string;
  cursor?: string;
  limit?: number;
  sort?: AgentSort;
  filter?: AgentFilter;
}

export interface AgentsResult {
  items: AgentCard[];
  next: string | null;
  payments: PaymentsSource;
  /** How many agents the sort and filters matched, when they were used (absent on the default list). */
  matched?: number;
}

export interface HistoryItem {
  /** AgentKarma's per-op payment id, or `sale:<ref>` for a proven sale AgentKarma has no payment for. */
  id: string;
  at: string;
  amount: string;
  payer: string;
  txHash: string;
  proof: { ref: string; agentUuid: string | null } | null;
}

export interface AgentProfile {
  id: number;
  owner: string;
  wallet: string | null;
  builder: Builder;
  registered: { at: string | null; txHash: string | null; source: 'event' | 'registry_read' };
  lastActiveAt: string | null;
  /** Payment totals are null whenever the history is (both come from AgentKarma, so they never disagree). */
  totals: { paymentsReceived: number | null; usdcReceived: string | null; provenSales: number };
  /** null: AgentKarma unavailable, so the payments are missing (never replaced by another source). */
  history: HistoryItem[] | null;
  payments: PaymentsSource;
  karma: KarmaScore;
  selfPublished: {
    name: string | null;
    description: string | null;
    /** `url`: the https address the service names in the agent's document (null: none we would call). */
    services: { slug: string; description: string | null; priceUsdc: string | null; url: string | null }[];
    fetchedAt: string;
  } | null;
  /** Same rule as AgentCard.hire. */
  hire: HireOffer | null;
  /** The agent's own site: the url of its `web` endpoint, if it names one (its own claim). */
  site: string | null;
  hidden: boolean;
  links: { karma: string };
}

export interface Discovery {
  stats(): Promise<Stats>;
  feed(o?: { after?: number; limit?: number }): Promise<{ items: FeedItem[]; latestSeq: number }>;
  agents(o?: AgentsQuery): Promise<AgentsResult>;
  profile(id: number, o?: { limit?: number }): Promise<AgentProfile | null>;
}

const INT4_MAX = 2_147_483_647;

type Row = Record<string, unknown>;

/** 7-decimal USDC units to a decimal string, trailing zeros trimmed ("0" for none). */
export function formatUsdc(units: string | bigint | number | null | undefined): string {
  const n = BigInt(units ?? 0);
  // Amounts are positive by construction (CHECK > 0 on payments and proven_sales). Never throw here: one odd
  // row must not take down the public totals, so a negative value still renders, with its sign.
  const sign = n < 0n ? '-' : '';
  const abs = n < 0n ? -n : n;
  const whole = abs / 10_000_000n;
  const frac = (abs % 10_000_000n).toString().padStart(7, '0').replace(/0+$/, '');
  return frac ? `${sign}${whole}.${frac}` : `${sign}${whole}`;
}

const iso = (v: unknown): string | null => (v === null || v === undefined ? null : new Date(v as string | Date).toISOString());
const clamp = (v: number | undefined, def: number, max: number): number =>
  v === undefined || !Number.isFinite(v) ? def : Math.min(max, Math.max(1, Math.trunc(v)));

function encodeCursor(ms: number | null, id: number): string {
  return Buffer.from(`${ms === null ? 'null' : ms}:${id}`).toString('base64url');
}
function decodeCursor(c: string | undefined): { ms: number | null; id: number } | null {
  if (!c) return null;
  const m = /^(null|\d{1,16}):(\d{1,10})$/.exec(Buffer.from(c, 'base64url').toString('utf8'));
  if (!m) return null;
  const id = Number(m[2]);
  if (id > INT4_MAX) return null;
  return { ms: m[1] === 'null' ? null : Number(m[1]), id };
}

/** Rows a sorted or filtered list reads before ranking in memory (payments and scores live in the AgentKarma snapshot, not in SQL). */
export const RANKED_CAP = 2000;

function encodeOffset(n: number): string {
  return Buffer.from(`o:${n}`).toString('base64url');
}
function decodeOffset(c: string | undefined): number {
  if (!c) return 0;
  const m = /^o:(\d{1,6})$/.exec(Buffer.from(c, 'base64url').toString('utf8'));
  return m ? Number(m[1]) : 0;
}

/** Decimal USDC string to 7-decimal units for comparing; null (unknown) ranks below every known amount. */
function unitsOf(v: string | null): bigint {
  if (v === null) return -1n;
  const m = /^(\d+)(?:\.(\d{1,7}))?$/.exec(v);
  return m ? BigInt(m[1]!) * 10_000_000n + BigInt((m[2] ?? '').padEnd(7, '0')) : -1n;
}

/** Descending comparators. Ties keep the incoming order, which is last activity (Array.prototype.sort is stable). */
const RANK: Record<Exclude<AgentSort, 'recent'>, (a: AgentCard, b: AgentCard) => number> = {
  paid: (a, b) => {
    const d = unitsOf(b.usdcReceived) - unitsOf(a.usdcReceived);
    return d !== 0n ? (d > 0n ? 1 : -1) : (b.paymentsReceived ?? -1) - (a.paymentsReceived ?? -1);
  },
  proofs: (a, b) => b.provenSales + b.seals - (a.provenSales + a.seals),
  karma: (a, b) => (b.karma?.score ?? -1) - (a.karma?.score ?? -1),
  newest: (a, b) => b.id - a.id,
};

export function matchesFilter(c: AgentCard, f: AgentFilter): boolean {
  if (f.built === 'agentenact' && c.builder === 'external') return false;
  if (f.built === 'external' && c.builder !== 'external') return false;
  if (f.sells && !c.selfPublished?.service) return false;
  if (f.hire && !c.hire) return false;
  if (f.paid && !((c.paymentsReceived ?? 0) > 0 || c.provenSales > 0)) return false;
  return true;
}

const scoreOf = (f: KarmaFacts | null): KarmaScore => (f ? { score: f.score, tier: f.tier } : null);

export function createDiscovery(
  sql: Db,
  o: { karma: Pick<Karma, 'view' | 'payments'>; now?: () => Date; staleAfterMs?: number; cacheMs?: number },
): Discovery {
  const now = o.now ?? (() => new Date());
  const { karma } = o;
  const staleAfterMs = o.staleAfterMs ?? 300_000;
  const cacheMs = o.cacheMs ?? 5_000;
  let cached: { at: number; value: Stats } | null = null;

  const pred = predicates(sql);
  const { builderOf, hostedUuidOf, countedPayment, activeWindow } = pred;

  async function stats(): Promise<Stats> {
    const t = now();
    if (cached && t.getTime() - cached.at < cacheMs) return cached.value;
    const nowIso = t.toISOString();
    const [r] = (await sql`
      with ${communityTxCtes(sql)}
      select
        (select count(*) from app.users where id not in (select id from test_users))::int as c_people,
        (select count(*) from app.agents where status <> 'draft' and user_id not in (select id from test_users))::int as c_agents,
        (select count(*) from community_seals)::int as c_seals,
        (select count(distinct h) from community_txs)::int as c_txs,
        (select tx_hash from community_seals order by at desc limit 1) as c_latest_seal,
        (select h from community_txs order by at desc limit 1) as c_latest_tx,
        (select count(*) from discovery.agents)::int as agents,
        (select count(*) from discovery.proven_sales)::int as proven,
        (select coalesce(sum(amount_units), 0) from discovery.payments where ${countedPayment})::text as units,
        (select count(*) from discovery.payments where ${countedPayment})::int as payments,
        (select count(*) from app.check_seals where status = 'sent')::int as seals,
        (select coalesce(sum(amount_units), 0) from discovery.proven_sales)::text as proven_units,
        (select count(distinct agent_id) from discovery.activity where ${activeWindow(nowIso)})::int as active,
        (select value from discovery.meta where key = 'heartbeat_at') as heartbeat,
        (select value from discovery.meta where key = 'payments_ok_at') as payments_beat,
        exists (select 1 from discovery.meta where key = 'halted') as halted
    `) as Row[];
    // Fresh means the chain was read recently: a successful events tick AND a payments tick that was not a swallowed
    // outage (the indexer writes each only then). The oldest of the two is what the index is current through; a halted
    // indexer is stale however fresh its last ticks were.
    const parse = (v: unknown) => {
      const x = v ? new Date(v as string) : null;
      return x !== null && !Number.isNaN(x.getTime()) ? x : null;
    };
    const events = parse(r!.heartbeat);
    const payments = parse(r!.payments_beat);
    const beat = events && payments && payments < events ? payments : events;
    const beatOk = beat !== null;
    const value: Stats = {
      network: 'testnet',
      agents: r!.agents as number,
      provenOutputs: r!.proven as number,
      usdcProven: formatUsdc(r!.proven_units as string),
      usdcTransfers: formatUsdc(r!.units as string),
      activeLastHour: r!.active as number,
      payments: r!.payments as number,
      seals: r!.seals as number,
      community: {
        people: r!.c_people as number,
        agents: r!.c_agents as number,
        seals: r!.c_seals as number,
        txs: r!.c_txs as number,
        latestSealTx: (r!.c_latest_seal as string | null) ?? null,
        latestTx: (r!.c_latest_tx as string | null) ?? null,
      },
      asOf: nowIso,
      indexedThrough: beatOk ? beat!.toISOString() : null,
      stale: r!.halted === true || !events || !payments || t.getTime() - beat!.getTime() > staleAfterMs,
    };
    cached = { at: t.getTime(), value };
    return value;
  }

  async function feed(f: { after?: number; limit?: number } = {}) {
    const limit = clamp(f.limit, 50, 100);
    const after = f.after !== undefined && Number.isFinite(f.after) && f.after >= 0 ? Math.trunc(f.after) : null;
    const nowIso = now().toISOString();
    const forward = after !== null;
    const rows = (await sql`
      with m as (select coalesce(max(seq), 0)::text as latest from discovery.feed),
      it as (
        select f.seq, f.kind, f.at, f.agent_id, f.other_agent_id, f.amount_units::text as units,
               case when h.agent_id is null then f.label else null end as label,
               f.self_published, f.tx_hash,
               coalesce(${builderOf(nowIso)}, 'external') as builder,
               ${hostedUuidOf(nowIso)} as hosted_uuid,
               ps.settlement_ref as proof_ref,
               ps.source as proof_source
        from discovery.feed f
        left join discovery.agents a on a.agent_id = f.agent_id
        left join discovery.selfpub sp on sp.agent_id = f.agent_id
        left join discovery.hidden h on h.agent_id = f.agent_id
        left join lateral (
          select settlement_ref, source from discovery.proven_sales
          where f.kind = 'paid' and settlement_ref = f.tx_hash and agent_id = f.agent_id limit 1
        ) ps on true
        where (${forward} = false or f.seq > ${after ?? 0})
          and not (f.self_published and h.agent_id is not null)
        order by
          case when ${forward} then f.seq end asc,
          case when not ${forward} then f.at end desc,
          case when not ${forward} then f.seq end desc
        limit ${limit}
      )
      select m.latest, it.seq::text as seq, it.kind, it.at, it.agent_id, it.other_agent_id, it.units, it.label, it.self_published,
             it.tx_hash, it.builder, it.hosted_uuid, it.proof_ref, it.proof_source
      from m left join it on true
      order by
        case when ${forward} then it.seq end asc,
        case when not ${forward} then it.at end desc,
        case when not ${forward} then it.seq end desc
    `) as Row[];
    // latest comes from the same statement (one snapshot) as the rows. Forward, a poller must resume from the last row it
    // actually got (or where it was), never from the global max: otherwise a backlog past `limit` is skipped for good.
    const snapshotMax = Number(rows[0]!.latest);
    const real = rows.filter((r) => r.seq !== null);
    const items = real.map((r): FeedItem => {
      const tx = r.tx_hash as string | null;
      let link: FeedLink | null = null;
      if (r.kind === 'paid') {
        if (r.proof_ref) link = { type: 'proof', ref: r.proof_ref as string, agentUuid: r.proof_source === 'hosted' ? ((r.hosted_uuid as string | null) ?? null) : null };
        else if (tx) link = { type: 'payment', txHash: tx };
      } else if (r.kind === 'registered' && tx) link = { type: 'registration', txHash: tx };
      return {
        seq: Number(r.seq),
        kind: r.kind as FeedItem['kind'],
        at: iso(r.at)!,
        agentId: r.agent_id as number,
        builder: r.builder as Builder,
        otherAgentId: (r.other_agent_id as number | null) ?? null,
        amount: r.units === null ? null : formatUsdc(r.units as string),
        label: (r.label as string | null) ?? null,
        selfPublished: r.self_published as boolean,
        link,
      };
    });
    return { items, latestSeq: forward ? (items.length ? items[items.length - 1]!.seq : after!) : snapshotMax };
  }

  async function agents(a: AgentsQuery = {}): Promise<AgentsResult> {
    const limit = clamp(a.limit, 20, 50);
    const nowIso = now().toISOString();
    const sort: AgentSort = a.sort && AGENT_SORTS.includes(a.sort) ? a.sort : 'recent';
    const filter = a.filter ?? {};
    // Any sort but `recent`, or any filter, reads every matching row and ranks in memory with offset paging.
    const ranked = sort !== 'recent' || filter.built !== undefined || !!filter.sells || !!filter.hire || !!filter.paid;
    const cur = ranked ? null : decodeCursor(a.cursor);
    const sqlLimit = ranked ? RANKED_CAP : limit + 1;
    const q = (a.q ?? '').trim();
    const k = karma.view();
    const payments: PaymentsSource = { source: 'agentkarma', available: k.available, asOf: k.asOf };

    // search mode: none | id | address-prefix and/or text. A word like "gemini" looks like an address prefix, so it runs both.
    let mode: 'none' | 'id' | 'search' = 'none';
    let qId = 0;
    let qPrefix = '';
    let qLike = '';
    let byPrefix = false;
    let byText = false;
    if (q) {
      const idm = /^#?(\d{1,10})$/.exec(q);
      if (idm) {
        mode = 'id';
        qId = Number(idm[1]);
        if (qId > INT4_MAX) return { items: [], next: null, payments };
      } else {
        mode = 'search';
        if (/^[Gg][A-Za-z2-7]{3,55}$/.test(q)) {
          byPrefix = true;
          qPrefix = q.toUpperCase();
        }
        const p = likePattern(q);
        if (p !== null) {
          byText = true;
          qLike = p;
        }
        if (!byPrefix && !byText) return { items: [], next: null, payments };
      }
    }

    const hasCur = cur !== null;
    const curNull = cur !== null && cur.ms === null;
    const curMs = cur?.ms ?? 0;
    const curId = cur?.id ?? 0;

    const rows = (await sql`
      with page as (
        select a.agent_id, a.last_active_at, a.hosted_uuid,
               ${builderOf(nowIso)} as builder,
               date_trunc('milliseconds', a.last_active_at) as la,
               (h.agent_id is not null) as hidden,
               sp.agent_id as sp_id, sp.name as sp_name, sp.description as sp_description, coalesce(sp.x402, false) as sp_x402,
               ${hostedUuidOf(nowIso)} as hu
        from discovery.agents a
        left join discovery.selfpub sp on sp.agent_id = a.agent_id
        left join discovery.hidden h on h.agent_id = a.agent_id
        where (
            ${mode === 'none'}
            or (${mode === 'id'} and a.agent_id = ${qId})
            or (${byPrefix} and (starts_with(a.owner, ${qPrefix}) or starts_with(coalesce(a.wallet, ''), ${qPrefix})))
            or (${byText} and h.agent_id is null and (
                 lower(coalesce(sp.name, '')) like ${qLike} escape '\\'
              or lower(coalesce(sp.description, '')) like ${qLike} escape '\\'
              or exists (select 1 from discovery.services s where s.agent_id = a.agent_id
                          and (lower(s.slug) like ${qLike} escape '\\' or lower(coalesce(s.description, '')) like ${qLike} escape '\\'))))
          )
          and (
            not ${hasCur}
            or (${!curNull} and (
                 date_trunc('milliseconds', a.last_active_at) < to_timestamp(${curMs}::double precision / 1000)
              or (date_trunc('milliseconds', a.last_active_at) = to_timestamp(${curMs}::double precision / 1000) and a.agent_id < ${curId})
              or a.last_active_at is null))
            or (${curNull} and a.last_active_at is null and a.agent_id < ${curId})
          )
        order by date_trunc('milliseconds', a.last_active_at) desc nulls last, a.agent_id desc
        limit ${sqlLimit}
      )
      select p.agent_id, p.builder, p.last_active_at, p.hidden, p.sp_id, p.sp_name, p.sp_description, p.sp_x402,
             (extract(epoch from p.la) * 1000)::bigint::text as la_ms,
             (select count(*) from discovery.proven_sales ps where ps.agent_id = p.agent_id)::int as sales,
             (case when p.hu is null or p.hidden then 0
                   else (select count(*) from app.check_seals cs where cs.agent_id = p.hu::uuid and cs.status = 'sent') end)::int as seals,
             sv.slug, sv.description as sv_description, sv.price_usdc, lo.price_usdc as min_price,
             cs.slug as cs_slug, cs.url as cs_url, cs.price_usdc as cs_price
      from page p
      left join lateral (
        select slug, description, price_usdc from discovery.services
        where agent_id = p.agent_id and not p.hidden
        order by (price_usdc is not null and price_usdc ~ '[1-9]') desc, last_seen_at desc, slug limit 1
      ) sv on true
      left join lateral (
        -- the cheapest published price above zero (the indexer stores only well-formed decimals)
        select price_usdc from discovery.services
        where agent_id = p.agent_id and not p.hidden and price_usdc ~ '^[0-9]+([.][0-9]+)?$' and price_usdc ~ '[1-9]'
        order by price_usdc::numeric, slug limit 1
      ) lo on true
      left join lateral (
        -- the service a hire calls: a url, not an ERC-8004 endpoint name; cheapest priced first (callableOf, same order)
        select slug, url, price_usdc from discovery.services
        where agent_id = p.agent_id and not p.hidden and url is not null and slug <> all(${`{${ENDPOINT_SLUGS.join(',')}}`}::text[])
        order by (price_usdc ~ '^[0-9]+([.][0-9]+)?$' and price_usdc ~ '[1-9]') desc nulls last,
                 case when price_usdc ~ '^[0-9]+([.][0-9]+)?$' then price_usdc::numeric end nulls last, slug
        limit 1
      ) cs on true
      order by p.la desc nulls last, p.agent_id desc
    `) as Row[];

    const toCard = (r: Row): AgentCard => {
      const f = k.facts(r.agent_id as number);
      return {
        id: r.agent_id as number,
        builder: r.builder as Builder,
        selfPublished:
          r.hidden || r.sp_id === null
            ? null
            : {
                name: (r.sp_name as string | null) ?? null,
                description: (r.sp_description as string | null) ?? null,
                service: r.slug
                  ? { slug: r.slug as string, description: (r.sv_description as string | null) ?? null, priceUsdc: (r.price_usdc as string | null) ?? null }
                  : null,
              },
        paymentsReceived: f?.paymentsReceived ?? null,
        usdcReceived: f?.usdcReceived ?? null,
        lastPaymentAt: f?.lastPaymentAt ?? null,
        provenSales: r.sales as number,
        seals: r.seals as number,
        lastActiveAt: iso(r.last_active_at),
        karma: scoreOf(f),
        hire: hireOfferOf({
          builder: r.builder as Builder,
          hidden: r.hidden as boolean,
          selfPublished: r.sp_id !== null,
          x402: r.sp_x402 === true,
          minPrice: (r.min_price as string | null) ?? null,
          callable: r.cs_slug ? { slug: r.cs_slug as string, url: r.cs_url as string, priceUsdc: (r.cs_price as string | null) ?? null } : null,
        }),
      };
    };

    if (ranked) {
      const all = rows.map(toCard).filter((c) => matchesFilter(c, filter));
      if (sort !== 'recent') all.sort(RANK[sort]);
      const from = decodeOffset(a.cursor);
      const items = all.slice(from, from + limit);
      return { items, next: from + limit < all.length ? encodeOffset(from + limit) : null, payments, matched: all.length };
    }

    const more = rows.length > limit;
    const pageRows = more ? rows.slice(0, limit) : rows;
    const items = pageRows.map(toCard);
    const last = pageRows[pageRows.length - 1];
    const next = more && last ? encodeCursor(last.la_ms === null ? null : Number(last.la_ms), last.agent_id as number) : null;
    return { items, next, payments };
  }

  async function profile(id: number, p: { limit?: number } = {}): Promise<AgentProfile | null> {
    if (!Number.isInteger(id) || id < 0 || id > INT4_MAX) return null;
    const limit = clamp(p.limit, 50, 100);
    const nowIso = now().toISOString();
    const [r] = (await sql`
      select a.agent_id, a.owner, a.wallet, a.registered_at, a.registered_tx, a.source, a.last_active_at,
             ${builderOf(nowIso)} as builder,
             (h.agent_id is not null) as hidden,
             sp.agent_id as sp_id, sp.name as sp_name, sp.description as sp_description, sp.fetched_at as sp_fetched_at,
             coalesce(sp.x402, false) as sp_x402,
             (select count(*) from discovery.proven_sales where agent_id = a.agent_id)::int as sales,
             ${hostedUuidOf(nowIso)} as hosted_uuid
      from discovery.agents a
      left join discovery.selfpub sp on sp.agent_id = a.agent_id
      left join discovery.hidden h on h.agent_id = a.agent_id
      where a.agent_id = ${id}
    `) as Row[];
    if (!r) return null;
    const hidden = r.hidden as boolean;
    const agentUuid = (r.hosted_uuid as string | null) ?? null;

    const sales = (await sql`
      select settlement_ref, settled_at, amount_units::text as units, payer, source
      from discovery.proven_sales where agent_id = ${id}
      order by settled_at desc, settlement_ref desc
      limit ${limit}
    `) as Row[];
    const proofOf = (s: Row) => ({ ref: s.settlement_ref as string, agentUuid: s.source === 'hosted' ? agentUuid : null });

    // Payments are AgentKarma's; our proven sales attach their proof by tx. A failure means "missing", never a substitute.
    const k = karma.view();
    let paid: Awaited<ReturnType<typeof karma.payments>> | undefined;
    try {
      paid = k.available ? await karma.payments(id) : undefined;
    } catch {
      paid = undefined;
    }
    let history: HistoryItem[] | null = null;
    if (paid !== undefined) {
      const saleByTx = new Map(sales.map((s) => [s.settlement_ref as string, s]));
      const fromKarma = (paid ?? []).map((p): HistoryItem => {
        const s = saleByTx.get(p.txHash);
        return { id: p.id, at: p.at, amount: p.amount, payer: p.payer, txHash: p.txHash, proof: s ? proofOf(s) : null };
      });
      const paidTx = new Set((paid ?? []).map((p) => p.txHash));
      const salesOnly = sales
        .filter((s) => !paidTx.has(s.settlement_ref as string))
        .map((s): HistoryItem => ({ id: `sale:${s.settlement_ref as string}`, at: iso(s.settled_at)!, amount: formatUsdc(s.units as string), payer: s.payer as string, txHash: s.settlement_ref as string, proof: proofOf(s) }));
      history = [...fromKarma, ...salesOnly].sort((a, b) => Date.parse(b.at) - Date.parse(a.at)).slice(0, limit);
    }
    const f = history === null ? null : k.facts(id);

    let selfPublished: AgentProfile['selfPublished'] = null;
    let hire: HireOffer | null = null;
    let site: string | null = null;
    if (!hidden && r.sp_id !== null) {
      const sv = (await sql`
        select slug, description, price_usdc, url from discovery.services where agent_id = ${id} order by slug
      `) as Row[];
      const services = sv.map((s) => ({
        slug: s.slug as string,
        description: (s.description as string | null) ?? null,
        priceUsdc: (s.price_usdc as string | null) ?? null,
        url: (s.url as string | null) ?? null,
      }));
      selfPublished = {
        name: (r.sp_name as string | null) ?? null,
        description: (r.sp_description as string | null) ?? null,
        services,
        fetchedAt: iso(r.sp_fetched_at)!,
      };
      const prices = services.map((s) => s.priceUsdc).filter(isPriced).sort((x, y) => Number(x) - Number(y));
      hire = hireOfferOf({
        builder: r.builder as Builder,
        hidden,
        selfPublished: true,
        x402: r.sp_x402 === true,
        minPrice: prices[0] ?? null,
        callable: callableOf(services),
      });
      site = services.find((s) => s.slug === 'web' && s.url !== null)?.url ?? null;
    }
    const owner = r.owner as string;
    const wallet = (r.wallet as string | null) ?? null;
    return {
      id,
      owner,
      wallet: wallet !== null && wallet !== owner ? wallet : null,
      builder: r.builder as Builder,
      registered: { at: iso(r.registered_at), txHash: (r.registered_tx as string | null) ?? null, source: r.source as 'event' | 'registry_read' },
      lastActiveAt: iso(r.last_active_at),
      totals: { paymentsReceived: f?.paymentsReceived ?? null, usdcReceived: f?.usdcReceived ?? null, provenSales: r.sales as number },
      history,
      payments: { source: 'agentkarma', available: history !== null, asOf: k.asOf },
      karma: scoreOf(k.facts(id)),
      selfPublished,
      hire,
      site,
      hidden,
      links: { karma: `https://agentkarma.io/agent/${owner}` },
    };
  }

  return { stats, feed, agents, profile };
}
