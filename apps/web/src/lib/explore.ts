'use client';

import { useEffect, useRef, useState } from 'react';

import { PUBLIC } from './public-config';

/** Public, read-only discovery api. No credentials ever go here. */
export const PROD_API = PUBLIC.apiUrl;

/** The dev override applies only outside production builds; a production build always talks to PROD_API. */
export function resolveApiBase(nodeEnv: string | undefined, override: string | undefined): string {
  return nodeEnv !== 'production' && override ? override.replace(/\/+$/, '') : PROD_API;
}

/**
 * Always the production api in this app: environment reads live under src/server/ only (tests/scaffold.test.ts), so the
 * site's public discovery-api dev override is not wired here. resolveApiBase stays for a later dev hook.
 */
export const API_BASE = resolveApiBase('production', undefined);
/** Proof links stay in this app: same-origin /verify. */
const SITE = '';

// ---- Types: mirror apps/api/src/discovery/queries.ts exactly ------------------------------------

export type Builder = 'hosted' | 'library' | 'external';
export type ExportName = 'agents' | 'payments' | 'proven-sales' | 'activity';

export interface Stats {
  network: 'testnet';
  agents: number;
  provenOutputs: number;
  /** USDC from payments that settled a proven output. */
  usdcProven: string;
  /** Every counted transfer to an agent (owner top-ups, self-payments and sponsors excluded). */
  usdcTransfers: string;
  /** Agents with payment activity or a proven sale in the last hour. */
  activeLastHour: number;
  /** Counted USDC payments to agents (the rows behind usdcTransfers). Absent from an api older than this field. */
  payments?: number;
  /** Seal transactions (checks and decisions) AgentEnact agents have sent on chain. Absent from an older api. */
  seals?: number;
  /** AgentEnact itself with the e2e test accounts left out (api discovery/queries.ts CommunityCounts). Absent from an older api. */
  community?: CommunityCounts;
  asOf: string;
  indexedThrough: string | null;
  stale: boolean;
}

export interface CommunityCounts {
  people: number;
  agents: number;
  seals: number;
  txs: number;
  /** The newest of each, for a figure to open on stellar.expert. Absent from an older api; null before the first. */
  latestSealTx?: string | null;
  latestTx?: string | null;
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

export interface FeedPage {
  items: FeedItem[];
  latestSeq: number;
}

export interface AgentService {
  slug: string;
  description: string | null;
  priceUsdc: string | null;
  /** Profile only: the https address the service names in the agent's document (null: none). Absent on older api builds. */
  url?: string | null;
}

/**
 * How an agent can be hired: its lowest price (null: quoted when called) and the service a hire calls, with its url
 * (null: not named yet; get_agent reads it). External agents are for hire only with a priced service url to call.
 * `service` is absent on older api builds.
 */
export type HireOffer = { priceUsdc: string | null; service?: { slug: string; url: string } | null };

/** Where per-agent payments come from (AgentKarma) and whether they could be read. Absent on older api builds. */
export interface PaymentsSource {
  source: 'agentkarma';
  available: boolean;
  /** Last good AgentKarma snapshot; when unavailable, payments are missing since then. */
  asOf: string | null;
}

/** AgentKarma's score and tier label for the agent; null when it has none or is unavailable. */
export type KarmaScore = { score: number | null; tier: string | null } | null;

export interface AgentCard {
  id: number;
  builder: Builder;
  /** `description`: what the agent says it does. Absent on older api builds. */
  selfPublished: { name: string | null; description?: string | null; service: AgentService | null } | null;
  /** From AgentKarma. null: AgentKarma unavailable, or it does not list the agent yet. */
  paymentsReceived: number | null;
  usdcReceived: string | null;
  provenSales: number;
  /** Checks and decisions a hosted agent sealed on chain. Absent on older api builds. */
  seals?: number;
  lastActiveAt: string | null;
  /** Time of the last payment received. Absent on older api builds: then no "last payment" text is shown. */
  lastPaymentAt?: string | null;
  /** Absent on older api builds. */
  karma?: KarmaScore;
  /**
   * Can be hired: x402 in its document, or a service with a price. `priceUsdc`: its lowest published price (null: the
   * agent quotes it when called). null: not for hire. Absent on older api builds.
   */
  hire?: HireOffer | null;
}

export interface AgentsPage {
  items: AgentCard[];
  next: string | null;
  payments?: PaymentsSource;
  /** How many agents a sort or filter matched; absent on the default list. */
  matched?: number;
}

// ---- Sort and filter (the /public/agents query, mirrored in the page url) -----------------------

export const AGENT_SORTS = [
  { id: 'recent', label: 'Recent activity' },
  { id: 'paid', label: 'Most paid' },
  { id: 'proofs', label: 'Most proofs' },
  { id: 'karma', label: 'AgentKarma' },
  { id: 'newest', label: 'Newest' },
] as const;
export type AgentSort = (typeof AGENT_SORTS)[number]['id'];

export interface AgentView {
  q: string;
  sort: AgentSort;
  built: 'agentenact' | 'external' | null;
  /** Only agents that can be hired (see AgentCard.hire). */
  hire: boolean;
  paid: boolean;
}

export const DEFAULT_VIEW: AgentView = { q: '', sort: 'recent', built: null, hire: false, paid: false };

export const isFiltered = (v: AgentView): boolean => v.built !== null || v.hire || v.paid;

/** Whether a card is for hire; an api older than the `hire` field still says so through a priced service. */
export const hireOf = (a: AgentCard): HireOffer | null =>
  a.hire !== undefined ? a.hire : a.selfPublished?.service?.priceUsdc ? { priceUsdc: a.selfPublished.service.priceUsdc } : null;

/** Reads a view from url params; anything unknown falls back to the default. */
export function viewFromParams(p: URLSearchParams): AgentView {
  const sort = p.get('sort');
  const built = p.get('built');
  return {
    q: (p.get('q') ?? '').slice(0, 64),
    sort: AGENT_SORTS.some((s) => s.id === sort) ? (sort as AgentSort) : 'recent',
    built: built === 'agentenact' || built === 'external' ? built : null,
    // `sells=1` was the earlier "Sells a service" chip: its links now open the hire list.
    hire: p.get('hire') === '1' || p.get('sells') === '1',
    paid: p.get('paid') === '1',
  };
}

/** The view as url params, defaults left out (the same names /public/agents takes). */
export function viewParams(v: AgentView): URLSearchParams {
  const p = new URLSearchParams();
  if (v.q.trim()) p.set('q', v.q.trim());
  if (v.sort !== 'recent') p.set('sort', v.sort);
  if (v.built) p.set('built', v.built);
  if (v.hire) p.set('hire', '1');
  if (v.paid) p.set('paid', '1');
  return p;
}

export interface HistoryItem {
  /** Per-payment id (a transaction can carry several payments). Absent on older api builds. */
  id?: string;
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
  totals: { paymentsReceived: number | null; usdcReceived: string | null; provenSales: number };
  /** null: AgentKarma unavailable, so the payments are missing. */
  history: HistoryItem[] | null;
  payments?: PaymentsSource;
  karma?: KarmaScore;
  selfPublished: {
    name: string | null;
    description: string | null;
    services: AgentService[];
    fetchedAt: string;
  } | null;
  /** Same rule as AgentCard.hire. Absent on older api builds. */
  hire?: HireOffer | null;
  /** The agent's own site (its `web` endpoint, its own claim). Absent on older api builds. */
  site?: string | null;
  hidden: boolean;
  links: { karma: string };
}

// ---- Client -------------------------------------------------------------------------------------

export interface RateLimited extends Error {
  name: 'RateLimited';
  retryAfterS: number;
}

export function rateLimited(retryAfterS: number): RateLimited {
  const e = new Error(`rate limited, retry in ${retryAfterS}s`) as RateLimited;
  e.name = 'RateLimited';
  e.retryAfterS = retryAfterS;
  return e;
}

export const isRateLimited = (e: unknown): e is RateLimited => e instanceof Error && e.name === 'RateLimited';

/** Stats poll shared by the homepage strip and /explore. */
export const getStats = (signal: AbortSignal) => getJson<Stats>('/public/stats', { signal });

export interface GetOpts {
  signal?: AbortSignal;
  fetch?: typeof fetch;
}

/** GET `API_BASE + path` as JSON. Throws on non-2xx; 429 throws RateLimited with the retry-after seconds. */
export async function getJson<T>(path: string, o: GetOpts = {}): Promise<T> {
  const f = o.fetch ?? fetch;
  const res = await f(API_BASE + path, { signal: o.signal, headers: { accept: 'application/json' } });
  if (res.status === 429) {
    const n = Number(res.headers.get('retry-after'));
    throw rateLimited(Number.isFinite(n) && n > 0 ? Math.ceil(n) : 60);
  }
  if (!res.ok) throw new Error(`api ${res.status}`);
  return (await res.json()) as T;
}

// ---- Formatting ---------------------------------------------------------------------------------

/**
 * Decimal USDC string with thousands separators on the integer part.
 * The fraction is never parsed as a number, so it cannot round or go scientific. A leading minus is kept.
 */
/** `amount` is the api's decimal USDC string ("213.4"); never raw 7-decimal units. */
export function formatUsdc(amount: string): string {
  const s = amount.trim();
  const m = /^(-?)(\d+)(?:\.(\d+))?$/.exec(s);
  if (!m) return s;
  const whole = m[2]!.replace(/^0+(?=\d)/, '').replace(/\B(?=(\d{3})+$)/g, ',');
  return `${m[1]}${whole}${m[3] ? `.${m[3]}` : ''}`;
}

/** "now" under 5 s (and for future timestamps), then 12s, 2m, 3h, 2d. */
export function timeAgo(iso: string, now: Date): string {
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return '';
  const s = Math.floor((now.getTime() - t) / 1000);
  if (s < 5) return 'now';
  if (s < 60) return `${s}s`;
  if (s < 3600) return `${Math.floor(s / 60)}m`;
  if (s < 86_400) return `${Math.floor(s / 3600)}h`;
  return `${Math.floor(s / 86_400)}d`;
}

export const shortId = (n: number): string => `#${n}`;

/** `64ffd2f5…342ad2`: first 8 and last 6 characters of a hash. Short input is returned whole. */
export function shortHash(h: string): string {
  return h.length <= 16 ? h : `${h.slice(0, 8)}…${h.slice(-6)}`;
}

/** `18:35:01 UTC` from an ISO timestamp, or null when it does not parse. Never depends on the viewer's zone. */
export function utcTime(iso: string | null | undefined, seconds = true): string | null {
  if (!iso) return null;
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return null;
  return `${new Date(t).toISOString().slice(11, seconds ? 19 : 16)} UTC`;
}

/** "AgentKarma 87 · Very Good", or null when there is no score worth showing (none, or unrated). */
export function karmaLabel(k: KarmaScore | undefined): string | null {
  if (!k || k.score === null || k.tier === 'Unrated') return null;
  return `AgentKarma ${Math.round(k.score)}${k.tier ? ` · ${k.tier}` : ''}`;
}

/** "1 payment", "2 payments". */
export const plural = (n: number, one: string, many = `${one}s`): string => `${n} ${n === 1 ? one : many}`;

// ---- Links --------------------------------------------------------------------------------------

const REF = /^[0-9a-f]{64}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Verify-page link for a proof. Hosted agents resolve by uuid; library records by the public record url. */
export function proofUrl(link: { ref: string; agentUuid: string | null }): string {
  if (!REF.test(link.ref)) throw new Error('invalid proof ref');
  if (link.agentUuid !== null) {
    if (!UUID.test(link.agentUuid)) throw new Error('invalid agent uuid');
    return `${SITE}/verify?agent=${encodeURIComponent(link.agentUuid)}&tx=${encodeURIComponent(link.ref)}`;
  }
  return `${SITE}/verify?record=${encodeURIComponent(`${API_BASE}/public/records/${link.ref}`)}`;
}

export function paymentUrl(txHash: string): string {
  return `https://stellar.expert/explorer/testnet/tx/${encodeURIComponent(txHash)}`;
}

export function exportUrl(name: ExportName): string {
  return `${API_BASE}/public/export/${encodeURIComponent(name)}.csv`;
}

export function karmaUrl(owner: string): string {
  return `https://agentkarma.io/agent/${encodeURIComponent(owner)}`;
}

// ---- Polling ------------------------------------------------------------------------------------

export const BACKOFF = 4;

/** Delay before the next run: `everyMs`, or 4x after an error. */
export const nextDelay = (everyMs: number, failed: boolean): number => (failed ? everyMs * BACKOFF : everyMs);

export interface PollerDeps<T> {
  load: (signal: AbortSignal) => Promise<T>;
  everyMs: number;
  isHidden: () => boolean;
  onData: (v: T) => void;
  onError: () => void;
  setTimer?: (fn: () => void, ms: number) => unknown;
  clearTimer?: (id: unknown) => void;
}

/**
 * Framework-free scheduler behind usePoll. Runs now, then every `everyMs` after the previous run ends
 * (so it never overlaps itself), parks while hidden, backs off after an error, aborts on stop.
 */
export function createPoller<T>(d: PollerDeps<T>) {
  const setT = d.setTimer ?? ((fn: () => void, ms: number) => setTimeout(fn, ms));
  const clearT = d.clearTimer ?? ((id: unknown) => clearTimeout(id as ReturnType<typeof setTimeout>));
  let timer: unknown = null;
  let running = false;
  let stopped = false;
  let ctl: AbortController | null = null;

  async function run(): Promise<void> {
    timer = null;
    if (stopped || running) return;
    if (d.isHidden()) return; // parked until wake()
    running = true;
    const c = (ctl = new AbortController());
    let failed = false;
    try {
      const v = await d.load(c.signal);
      if (!c.signal.aborted) d.onData(v);
    } catch {
      if (c.signal.aborted) return;
      failed = true;
      d.onError();
    } finally {
      running = false;
    }
    if (!stopped && timer === null) timer = setT(run, nextDelay(d.everyMs, failed));
  }

  return {
    start: () => void run(),
    /** Call when the tab becomes visible again. */
    wake() {
      if (stopped || running || timer !== null) return;
      void run();
    },
    stop() {
      stopped = true;
      if (timer !== null) clearT(timer);
      timer = null;
      ctl?.abort();
    },
  };
}

/** Polls `load` while the tab is visible. `stale` means the last attempt failed but older data is still shown. */
export function usePoll<T>(
  load: (signal: AbortSignal) => Promise<T>,
  everyMs: number,
): { data: T | null; error: boolean; stale: boolean; retry: () => void } {
  const [data, setData] = useState<T | null>(null);
  const [attempt, setAttempt] = useState(0);
  const [error, setError] = useState(false);
  const loadRef = useRef(load);
  loadRef.current = load;

  useEffect(() => {
    const p = createPoller<T>({
      load: (s) => loadRef.current(s),
      everyMs,
      isHidden: () => document.hidden,
      onData: (v) => {
        setData(v);
        setError(false);
      },
      onError: () => setError(true),
    });
    const onVis = () => {
      if (!document.hidden) p.wake();
    };
    document.addEventListener('visibilitychange', onVis);
    p.start();
    return () => {
      document.removeEventListener('visibilitychange', onVis);
      p.stop();
    };
  }, [everyMs, attempt]);

  return { data, error, stale: error && data !== null, retry: () => setAttempt((n) => n + 1) };
}
