/**
 * AgentKarma as the source of per-agent payments (and scores) for the public discovery api.
 *
 * Owner decision 2026-10-14: the agent list and per-agent payments read from AgentKarma (chain=stellar-testnet);
 * proven sales, the feed, stats and CSV exports stay in this service. AgentKarma allows 30 reads per minute per
 * address, so readers never fan out to it: one background refresh pulls every agent's totals into a snapshot
 * (one call per 100 agents), and a profile's payment list is one call cached per agent.
 *
 * Failure isolation: a failed refresh keeps the last snapshot until it is `maxAgeMs` old; after that `facts()` is
 * null and `available` false, so callers say the figures are missing instead of showing old or zero ones.
 * Only payment totals and the score/tier are taken: AgentKarma's display name and image are not ours to show
 * (they would bypass discovery.hidden and load third-party images).
 */

import type { Db } from '../db/index.js';

export const KARMA_BASE = 'https://agentkarma.io';
const CHAIN = 'stellar-testnet';
const PAGE = 100;
const MAX_PAGES = 50;
const PAYMENTS_LIMIT = 50;
const PAYMENTS_CACHE_MS = 30_000;
const PAYMENTS_CACHE_MAX = 1_000;
/**
 * AgentKarma calls a minute that profiles may spend. AgentKarma allows 30 per address; the snapshot refresh needs
 * about 1, so profiles get 20 and the refresh can never be starved by someone paging through profiles.
 */
export const PAYMENTS_PER_MIN = 20;

export interface KarmaFacts {
  paymentsReceived: number;
  usdcReceived: string;
  lastPaymentAt: string | null;
  score: number | null;
  tier: string | null;
}

export interface KarmaPayment {
  /** AgentKarma's per-op id: a transaction can carry several payments. */
  id: string;
  at: string;
  amount: string;
  payer: string;
  txHash: string;
}

export interface KarmaView {
  available: boolean;
  /** Time of the last good snapshot (null before the first). When unavailable: missing since then. */
  asOf: string | null;
  facts(agentId: number): KarmaFacts | null;
}

export interface Karma {
  view(): KarmaView;
  /** Successful payments received, newest first; null when AgentKarma does not know the agent. Throws when it fails. */
  payments(agentId: number): Promise<KarmaPayment[] | null>;
  /** One sync pass. Throws on any failure and leaves the previous snapshot in place. */
  refresh(): Promise<void>;
  /** Refreshes now and every `everyMs` (the leader); with a store, each good snapshot is saved there. Returns stop. */
  start(): () => void;
  /** Loads the snapshot the leader saved, now and every `everyMs / 2` (the other replicas). Returns stop. */
  follow(): () => void;
}

/** Where the leader's snapshot is shared with the other replicas (app.karma_snapshot). */
export interface KarmaStore {
  save(takenAt: Date, facts: [number, KarmaFacts][]): Promise<void>;
  load(): Promise<{ takenAt: Date; facts: [number, KarmaFacts][] } | null>;
}

export interface KarmaDeps {
  fetch?: typeof fetch;
  base?: string;
  now?: () => Date;
  everyMs?: number;
  maxAgeMs?: number;
  /** Per call for a profile's payment list (a reader waits on it). */
  timeoutMs?: number;
  /** Per page for the background snapshot. AgentKarma's explore page took 4-30 s on 2026-10-28, so it gets longer. */
  refreshTimeoutMs?: number;
  /** Wait before the one retry of a snapshot page that failed in transit or with a 5xx. */
  retryDelayMs?: number;
  sleep?: (ms: number) => Promise<void>;
  log?: (e: Record<string, string | number>) => void;
  store?: KarmaStore;
  /**
   * Charges one profile payments call to the shared per-minute budget (PAYMENTS_PER_MIN across all replicas, a named
   * rate limiter): 0 if allowed. Absent: this process's own budget.
   */
  paymentsBudget?: () => number | Promise<number>;
}

type Obj = Record<string, unknown>;
const DECIMAL = /^(\d+)(?:\.(\d+))?$/;

/** AgentKarma's decimal USDC ("0.0010000") as this api writes it ("0.001", "20", "0"). */
function usdc(v: unknown): string {
  if (typeof v !== 'string') throw new Error('karma: amount not a string');
  const m = DECIMAL.exec(v);
  if (!m) throw new Error('karma: malformed amount');
  const whole = m[1]!.replace(/^0+(?=\d)/, '');
  const frac = (m[2] ?? '').replace(/0+$/, '');
  return frac ? `${whole}.${frac}` : whole;
}

function isoOrNull(v: unknown): string | null {
  if (v === null) return null;
  if (typeof v !== 'string') throw new Error('karma: timestamp not a string');
  const t = Date.parse(v);
  if (Number.isNaN(t)) throw new Error('karma: malformed timestamp');
  return new Date(t).toISOString();
}

const count = (v: unknown): number => {
  if (typeof v !== 'number' || !Number.isInteger(v) || v < 0) throw new Error('karma: malformed count');
  return v;
};
const obj = (v: unknown, what: string): Obj => {
  if (typeof v !== 'object' || v === null || Array.isArray(v)) throw new Error(`karma: ${what} not an object`);
  return v as Obj;
};

function parseRow(raw: unknown): [number, KarmaFacts] {
  const r = obj(raw, 'row');
  if (r.chain !== CHAIN) throw new Error('karma: row of another chain');
  const id = count(r.agentId);
  const p = obj(r.payments, 'payments');
  const score = r.providerScore;
  const tier = r.trustTier;
  if (score !== null && (typeof score !== 'number' || !Number.isFinite(score))) throw new Error('karma: malformed score');
  if (tier !== null && typeof tier !== 'string') throw new Error('karma: malformed tier');
  return [id, { paymentsReceived: count(p.received), usdcReceived: usdc(p.usdcReceived), lastPaymentAt: isoOrNull(p.lastReceivedAt), score, tier }];
}

function parsePayment(raw: unknown): KarmaPayment | null {
  const r = obj(raw, 'payment');
  if (typeof r.id !== 'string' || !r.id) throw new Error('karma: payment without id');
  if (typeof r.txHash !== 'string' || typeof r.from !== 'string' || typeof r.success !== 'boolean') throw new Error('karma: malformed payment');
  const amount = usdc(r.amount);
  const at = isoOrNull(r.timestamp);
  if (at === null) throw new Error('karma: payment without time');
  return r.success ? { id: r.id, at, amount, payer: r.from, txHash: r.txHash } : null;
}

export function createKarma(d: KarmaDeps = {}): Karma {
  const f = d.fetch ?? fetch;
  const base = (d.base ?? KARMA_BASE).replace(/\/+$/, '');
  const now = d.now ?? (() => new Date());
  const everyMs = d.everyMs ?? 60_000;
  const maxAgeMs = d.maxAgeMs ?? 10 * 60_000;
  const timeoutMs = d.timeoutMs ?? 10_000;
  const refreshTimeoutMs = d.refreshTimeoutMs ?? 30_000;
  const retryDelayMs = d.retryDelayMs ?? 2_000;
  const sleep = d.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));

  let snap: { at: number; byId: Map<number, KarmaFacts> } | null = null;
  const payCache = new Map<number, { at: number; value: KarmaPayment[] | null }>();
  let budget = { windowStart: 0, used: 0 };

  /** JSON body, or null on 404. Any other non-2xx throws. */
  async function get(path: string, ms = timeoutMs): Promise<unknown> {
    const res = await f(base + path, { headers: { accept: 'application/json' }, signal: AbortSignal.timeout(ms) });
    if (res.status === 404) return null;
    if (!res.ok) throw new Error(`karma ${res.status}`);
    return res.json();
  }

  /** A snapshot page: the long timeout, and one retry after a transport failure or a 5xx (never after a 4xx or bad body). */
  async function getPage(path: string): Promise<unknown> {
    try {
      return await get(path, refreshTimeoutMs);
    } catch (e) {
      const m = e instanceof Error ? e.message : '';
      const transient = !m.startsWith('karma') || /^karma 5\d\d$/.test(m);
      if (!transient) throw e;
      await sleep(retryDelayMs);
      return get(path, refreshTimeoutMs);
    }
  }

  async function refresh(): Promise<void> {
    const byId = new Map<number, KarmaFacts>();
    for (let i = 0, offset = 0; ; i++) {
      if (i >= MAX_PAGES) throw new Error('karma: too many pages');
      const body = obj(await getPage(`/api/explore/agents?chain=${CHAIN}&limit=${PAGE}&offset=${offset}`), 'page');
      const rows = body.wallets;
      if (!Array.isArray(rows)) throw new Error('karma: page without rows');
      const total = count(body.total);
      for (const r of rows) {
        const [id, facts] = parseRow(r);
        byId.set(id, facts);
      }
      offset += rows.length;
      if (rows.length === 0 || offset >= total) break;
    }
    snap = { at: now().getTime(), byId };
    if (d.store) {
      try {
        await d.store.save(new Date(snap.at), [...byId]);
      } catch {
        d.log?.({ event: 'karma_store_failed' });
      }
    }
  }

  async function load(): Promise<void> {
    const got = await d.store?.load();
    if (got && (!snap || got.takenAt.getTime() > snap.at)) snap = { at: got.takenAt.getTime(), byId: new Map(got.facts) };
  }

  function view(): KarmaView {
    const fresh = snap !== null && now().getTime() - snap.at <= maxAgeMs;
    const s = snap;
    return {
      available: fresh,
      asOf: s ? new Date(s.at).toISOString() : null,
      facts: (id) => (fresh && s ? (s.byId.get(id) ?? null) : null),
    };
  }

  async function payments(agentId: number): Promise<KarmaPayment[] | null> {
    const t = now().getTime();
    const hit = payCache.get(agentId);
    if (hit && t - hit.at < PAYMENTS_CACHE_MS) return hit.value;
    let over: boolean;
    if (d.paymentsBudget) over = (await d.paymentsBudget()) !== 0;
    else {
      if (t - budget.windowStart >= 60_000) budget = { windowStart: t, used: 0 };
      over = budget.used >= PAYMENTS_PER_MIN;
      if (!over) budget.used++;
    }
    if (over) {
      if (hit && t - hit.at <= maxAgeMs) return hit.value; // over budget: a recent-enough older answer beats none
      throw new Error('karma: budget');
    }
    const raw = await get(`/api/v2/agent/${CHAIN}/${agentId}/payments?limit=${PAYMENTS_LIMIT}`);
    let value: KarmaPayment[] | null = null;
    if (raw !== null) {
      const rows = obj(raw, 'payments body').payments;
      if (!Array.isArray(rows)) throw new Error('karma: body without payments');
      value = rows.map(parsePayment).filter((p): p is KarmaPayment => p !== null);
    }
    if (payCache.size >= PAYMENTS_CACHE_MAX) payCache.clear();
    payCache.set(agentId, { at: t, value });
    return value;
  }

  function start(): () => void {
    let stopped = false;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const run = async () => {
      timer = null;
      try {
        await refresh();
      } catch (e) {
        // Our own messages are fixed words; anything else (a network error) is logged as a class, never its text.
        const m = e instanceof Error ? e.message : '';
        d.log?.({ event: 'karma_refresh_failed', reason: m.startsWith('karma') ? m : 'network' });
      }
      if (!stopped) timer = setTimeout(run, everyMs);
    };
    void run();
    return () => {
      stopped = true;
      if (timer) clearTimeout(timer);
    };
  }

  function follow(): () => void {
    let stopped = false;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const run = async () => {
      timer = null;
      try {
        await load();
      } catch {
        d.log?.({ event: 'karma_load_failed' });
      }
      if (!stopped) timer = setTimeout(run, Math.max(1_000, everyMs / 2));
    };
    void run();
    return () => {
      stopped = true;
      if (timer) clearTimeout(timer);
    };
  }

  return { view, payments, refresh, start, follow };
}

/** app.karma_snapshot (migration 0027): one row, replaced by each good leader refresh. */
export function createKarmaStore(sql: Db): KarmaStore {
  return {
    async save(takenAt, facts) {
      await sql`insert into app.karma_snapshot (id, taken_at, facts) values (1, ${takenAt}, ${{ rows: facts }})
                on conflict (id) do update set taken_at = excluded.taken_at, facts = excluded.facts`;
    },
    async load() {
      // An object, not a bare array: Bun binds a JS array as a Postgres array, not as jsonb.
      const [r] = (await sql`select taken_at, facts from app.karma_snapshot where id = 1`) as { taken_at: Date; facts: { rows: [number, KarmaFacts][] } }[];
      return r ? { takenAt: r.taken_at, facts: r.facts.rows } : null;
    },
  };
}
