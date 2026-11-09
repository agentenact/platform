/**
 * What the agent page reads from the api (apps/api/src/activity/index.ts), with guards. The api validates everything it
 * stores; these only keep an odd answer from crashing the render, and drop feed items they cannot draw.
 */
import type { AgentStatus } from '@/copy';

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
  /** When the agent was made; null from an api that does not say. */
  watchingSince: string | null;
  /** Checks ever counted, all days. */
  checksTotal: number;
  /** An enabled condition trigger exists, so a first check is coming. */
  watchesCondition: boolean;
  /** A check is due or running right now (Run now, or the schedule). false from an api that does not say. */
  running: boolean;
  /** The newest finished run (scheduled, Run now, or an alert): when it ended, its id, whether it finished. null when none. */
  lastRun: LastRun | null;
  /** The newest logged check; `held` is null when it could not finish. null when there is none. */
  latestCheck: LatestCheck | null;
  /** The owner's answer to the morning note; null = not asked yet. */
  morningNote: boolean | null;
  /** The model its runs use and the list the owner can pick from; null from an api that does not say. */
  model: AgentModel | null;
}

/**
 * One model the owner can pick. `weight`: how much faster it uses the daily limit than the default (1 = the same).
 * `suggested`: one we tried; false for the rest of the OpenRouter catalog.
 */
export interface ModelChoice {
  id: string;
  label: string;
  weight: number;
  suggested: boolean;
}

/** `current` is what runs; `chosen` is the owner's pick, null on the default (`defaultId`). */
export interface AgentModel {
  current: string;
  chosen: string | null;
  defaultId: string;
  choices: ModelChoice[];
  /** The full catalog can be listed (GET /api/models). */
  catalog: boolean;
}

const SLUG = /^[\w.-]+\/[\w.:-]+$/;
/** The model block, or null when anything in it is odd (the picker then stays hidden). */
export function asAgentModel(v: unknown): AgentModel | null {
  if (!isObj(v) || typeof v.current !== 'string' || !SLUG.test(v.current) || typeof v.defaultId !== 'string' || !SLUG.test(v.defaultId)) return null;
  if (!(v.chosen === null || (typeof v.chosen === 'string' && SLUG.test(v.chosen)))) return null;
  const choices = asModelChoices(v.choices);
  if (!choices || !choices.some((c) => c.id === v.current)) return null;
  return { current: v.current, chosen: v.chosen, defaultId: v.defaultId, choices, catalog: v.catalog === true };
}

/** A list of model choices, or null when any entry is odd. `suggested` defaults to true for an api that does not say. */
export function asModelChoices(v: unknown): ModelChoice[] | null {
  if (!Array.isArray(v)) return null;
  const out: ModelChoice[] = [];
  for (const c of v) {
    if (!isObj(c) || typeof c.id !== 'string' || !SLUG.test(c.id) || typeof c.label !== 'string' || c.label.length > 80) return null;
    if (typeof c.weight !== 'number' || !Number.isFinite(c.weight) || c.weight < 1) return null;
    out.push({ id: c.id, label: c.label, weight: c.weight, suggested: c.suggested !== false });
  }
  return out;
}

/** Run now: the api's answer as data. `until` is when a cooldown ends; `code` is the api's error word when it sent one. */
export type RunNowOut =
  | { ok: true; state: 'queued' | 'running' }
  | { ok: true; state: 'cooling_down'; until: string }
  | { ok: false; status: number; code?: string };

export interface LastRun {
  at: string;
  runId: string;
  ok: boolean;
}

const RUN_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
function asLastRun(v: unknown): LastRun | null {
  if (!isObj(v) || !isDate(v.at) || typeof v.runId !== 'string' || !RUN_ID.test(v.runId) || typeof v.ok !== 'boolean') return null;
  return { at: v.at, runId: v.runId, ok: v.ok };
}

/**
 * What a run is doing right now (GET /api/agents/:id/live): due, picked up, working (plain lines of what it did, and the
 * tail of the text it is writing), or delivering. `since` is when the scheduler picked it up.
 */
export interface LiveRun {
  phase: 'idle' | 'queued' | 'starting' | 'working' | 'finishing';
  since: string | null;
  lines: string[];
  text: string;
}

const PHASES: readonly string[] = ['idle', 'queued', 'starting', 'working', 'finishing'];
/** The live answer, or null when it does not look right. Lines are capped at 6 and 200 characters; text at 4000. */
export function asLiveRun(v: unknown): LiveRun | null {
  if (!isObj(v) || typeof v.phase !== 'string' || !PHASES.includes(v.phase)) return null;
  const lines = Array.isArray(v.lines) ? v.lines.filter((l): l is string => typeof l === 'string' && l.length > 0 && l.length <= 200).slice(-6) : [];
  return { phase: v.phase as LiveRun['phase'], since: isDate(v.since) ? v.since : null, lines, text: typeof v.text === 'string' ? v.text.slice(-4000) : '' };
}

export interface LatestCheck {
  at: string;
  held: boolean | null;
  reading: Record<string, number | string> | null;
}

/** A transaction the api names: a 64-hex hash and the CAIP-2 network it settled on. */
export interface ChainTx {
  hash: string;
  network: string;
}
/** A payment a run made to hire another agent. */
export type RunPayment = ChainTx & { usdc: string };

/** A mission's decision sealed on Stellar: with what it produced, once landed (`tx`). */
export interface DecisionSeal {
  status: 'pending' | 'sent' | 'failed';
  tx: ChainTx | null;
}

/** A day's check seals: every check (fired ones too), how many landed, how many gave up, and the newest landed one. */
export interface DaySeals {
  total: number;
  sent: number;
  failed: number;
  last: ChainTx | null;
}

export type FeedItem =
  | { type: 'alert'; at: string; text: string; runId?: string; payments?: RunPayment[]; decision?: DecisionSeal }
  | { type: 'sale'; at: string; usdc: string; proofUrl?: string; runId?: string; tx?: ChainTx }
  /**
   * `range` (a ready plain string from the api) and `since` (the day's first quiet check) come together or not at all.
   * `seals`: how many of the day's checks are sealed on chain, with the newest landed one.
   */
  | { type: 'quiet'; at: string; day: string; count: number; range?: string; since?: string; seals?: DaySeals }
  | { type: 'problem'; at: string; runId?: string; payments?: RunPayment[]; decision?: DecisionSeal };

const STATUSES: readonly string[] = ['setting_up', 'watching', 'paused', 'stopped_today', 'stopped'];
const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const isDate = (v: unknown): v is string => typeof v === 'string' && Number.isFinite(Date.parse(v));
const count = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v) && v >= 0;
const dateOrNull = (v: unknown): string | null | undefined => (v === null ? null : isDate(v) ? v : undefined);

/** A reading is a flat object of numbers and short strings (apps/api/src/checks/readings.ts); anything else is no reading. */
function asReading(v: unknown): Record<string, number | string> | null {
  if (!isObj(v)) return null;
  const out: Record<string, number | string> = {};
  for (const [k, x] of Object.entries(v)) {
    if (typeof x === 'number' && Number.isFinite(x)) out[k] = x;
    else if (typeof x === 'string' && x.length <= 80) out[k] = x;
    else return null;
  }
  return out;
}

function asLatestCheck(v: unknown): LatestCheck | null {
  if (!isObj(v) || !isDate(v.at) || !(v.held === null || typeof v.held === 'boolean')) return null;
  return { at: v.at, held: v.held, reading: asReading(v.reading) };
}

export function asOverview(v: unknown): Overview | null {
  if (!isObj(v) || typeof v.name !== 'string' || typeof v.status !== 'string' || !STATUSES.includes(v.status)) return null;
  const next = dateOrNull(v.nextCheckAt);
  const last = dateOrNull(v.lastAlertAt);
  if (next === undefined || last === undefined) return null;
  if (!count(v.checksToday) || !count(v.alertsThisWeek) || !count(v.salesCount) || !count(v.budgetUsedPct)) return null;
  if (typeof v.earnedUsdc !== 'string' || !/^\d+(\.\d+)?$/.test(v.earnedUsdc)) return null;
  return {
    name: v.name,
    // Paused by the platform until its first USDC set up its wallet (api `awaitingFunds`): not the owner's pause, and no
    // Resume can start it. The api keeps saying `paused`, so a panel older than the flag still draws the page.
    status: v.status === 'paused' && v.awaitingFunds === true ? 'getting_ready' : (v.status as AgentStatus),
    nextCheckAt: next,
    lastAlertAt: last,
    checksToday: v.checksToday,
    alertsThisWeek: v.alertsThisWeek,
    earnedUsdc: v.earnedUsdc,
    salesCount: v.salesCount,
    budgetUsedPct: Math.min(100, v.budgetUsedPct),
    // The panel can be deployed before the api: an answer without these reads as a quiet agent, not as an error.
    watchingSince: isDate(v.watchingSince) ? v.watchingSince : null,
    checksTotal: count(v.checksTotal) ? v.checksTotal : v.checksToday,
    watchesCondition: v.watchesCondition === true,
    running: v.running === true,
    lastRun: asLastRun(v.lastRun),
    latestCheck: asLatestCheck(v.latestCheck),
    morningNote: typeof v.morningNote === 'boolean' ? v.morningNote : null,
    model: asAgentModel(v.model),
  };
}

/** The items it can draw, in the order given (the api sends newest first). Null when the answer is not a list. */
const TX_HASH = /^[0-9a-f]{64}$/;
/** A Solana transaction id: base58 of a 64-byte signature, case-sensitive. */
const SOLANA_TX = /^[1-9A-HJ-NP-Za-km-z]{64,88}$/;
const NETWORK = /^(stellar:(testnet|pubnet)|eip155:\d{1,12}|solana:[1-9A-HJ-NP-Za-km-z]{32})$/;
const USDC = /^\d{1,15}(\.\d{1,7})?$/;

/** A transaction as the api sends it, or null: an odd hash or network is never linked. */
export function asTx(v: unknown): ChainTx | null {
  return isObj(v) && typeof v.hash === 'string' && typeof v.network === 'string' && NETWORK.test(v.network) && (v.network.startsWith('solana:') ? SOLANA_TX : TX_HASH).test(v.hash) ? { hash: v.hash, network: v.network } : null;
}

function asPayments(v: unknown): { payments?: RunPayment[] } {
  if (!Array.isArray(v)) return {};
  const out = v.flatMap((p): RunPayment[] => {
    const tx = asTx(p);
    return tx && isObj(p) && typeof p.usdc === 'string' && USDC.test(p.usdc) ? [{ ...tx, usdc: p.usdc }] : [];
  });
  return out.length > 0 ? { payments: out } : {};
}

/** A mission's decision seal: landed only with its transaction, never a transaction without landing. */
function asDecision(v: unknown): { decision?: DecisionSeal } {
  if (!isObj(v) || (v.status !== 'pending' && v.status !== 'sent' && v.status !== 'failed')) return {};
  const tx = v.tx === null ? null : asTx(v.tx);
  if ((v.status === 'sent') !== (tx !== null)) return {};
  return { decision: { status: v.status, tx } };
}

/** A day's seals, all or nothing: counts that add up, and a landed one only when something landed. */
function asDaySeals(v: unknown): { seals?: DaySeals } {
  if (!isObj(v)) return {};
  const { total, sent, failed } = v;
  const n = (x: unknown): x is number => typeof x === 'number' && Number.isInteger(x) && x >= 0 && x <= 100_000;
  if (!n(total) || !n(sent) || !n(failed) || sent + failed > total) return {};
  const last = v.last === null ? null : asTx(v.last);
  if (sent > 0 ? last === null : v.last !== null) return {};
  return { seals: { total, sent, failed, last } };
}

/** Each EVM testnet's explorer page for a transaction, by network. */
const SOLANA_DEVNET = 'solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1';
const EVM_TX: Record<string, string> = {
  'eip155:84532': 'https://sepolia.basescan.org/tx/',
  'eip155:421614': 'https://sepolia.arbiscan.io/tx/',
  'eip155:43113': 'https://testnet.snowtrace.io/tx/',
  'eip155:80002': 'https://amoy.polygonscan.com/tx/',
};

/** The explorer page of a transaction, or null for a network we do not link. EVM hashes are stored without their 0x. */
export function explorerTx(tx: ChainTx): string | null {
  if (tx.network === 'stellar:testnet') return `https://stellar.expert/explorer/testnet/tx/${tx.hash}`;
  if (tx.network === 'stellar:pubnet') return `https://stellar.expert/explorer/public/tx/${tx.hash}`;
  if (tx.network === SOLANA_DEVNET) return `https://explorer.solana.com/tx/${tx.hash}?cluster=devnet`;
  const evm = EVM_TX[tx.network];
  return evm ? `${evm}0x${tx.hash}` : null;
}

/** "a1b2c3…d4e5", as an explorer shows a hash. */
export const shortHash = (h: string): string => `${h.slice(0, 6)}…${h.slice(-4)}`;

export function asFeed(v: unknown): FeedItem[] | null {
  if (!Array.isArray(v)) return null;
  const out: FeedItem[] = [];
  for (const i of v) {
    if (!isObj(i) || !isDate(i.at)) continue;
    const run = typeof i.runId === 'string' && i.runId !== '' ? { runId: i.runId } : {};
    const tx = asTx(i.tx);
    if (i.type === 'alert' && typeof i.text === 'string') out.push({ type: 'alert', at: i.at, text: i.text, ...run, ...asPayments(i.payments), ...asDecision(i.decision) });
    else if (i.type === 'sale' && typeof i.usdc === 'string' && /^\d+(\.\d+)?$/.test(i.usdc)) out.push({ type: 'sale', at: i.at, usdc: i.usdc, ...(typeof i.proofUrl === 'string' ? { proofUrl: i.proofUrl } : {}), ...run, ...(tx ? { tx } : {}) });
    else if (i.type === 'quiet' && typeof i.day === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(i.day) && count(i.count)) out.push({ type: 'quiet', at: i.at, day: i.day, count: i.count, ...(typeof i.range === 'string' && i.range.length > 0 && i.range.length <= 200 && isDate(i.since) ? { range: i.range, since: i.since } : {}), ...asDaySeals(i.seals) });
    else if (i.type === 'problem') out.push({ type: 'problem', at: i.at, ...run, ...asPayments(i.payments), ...asDecision(i.decision) });
  }
  return out;
}

export type SaleItem = Extract<FeedItem, { type: 'sale' }>;

/** The sales in an earnings answer (newest first, as sent). Null when the answer is not a list. */
export function asSales(v: unknown): SaleItem[] | null {
  const items = asFeed(v);
  return items ? items.filter((i): i is SaleItem => i.type === 'sale') : null;
}

/** The one offer the selling card shows (GET /api/agents/:id/suggestion). `version` is the description version it was made for. */
export interface SellSuggestion {
  version: number;
  label: string;
  /** USDC per use, as the api formats it ("0.01"). */
  price: string;
}

/**
 * The card's data, or null when there is nothing to show: not eligible, a daily-limit answer (`suggestion: null`), or an answer
 * that does not look right. Only a complete suggestion is ever drawn.
 */
export function asSellSuggestion(v: unknown): SellSuggestion | null {
  if (!isObj(v) || v.eligible !== true || !isObj(v.suggestion)) return null;
  const s = v.suggestion;
  const price = isObj(s.service) ? s.service.price_usdc : undefined;
  if (typeof s.version !== 'number' || !Number.isSafeInteger(s.version) || s.version < 1) return null;
  if (typeof s.label !== 'string' || s.label.trim() === '' || s.label.length > 80) return null;
  if (typeof price !== 'string' || !/^\d{1,3}(\.\d{1,7})?$/.test(price)) return null;
  return { version: s.version, label: s.label.trim(), price: price.includes('.') ? price.replace(/0+$/, '').replace(/\.$/, '') : price };
}

/** One run as the owner route sends it (apps/api/src/runs RunView, dates as ISO strings). */
export interface RunStep {
  n: number;
  tools: string[];
  inputTokens: number;
  outputTokens: number;
  finishReason: string;
  /** A plain line per tool call (null when the api had none to give); absent on older runs. */
  calls?: { tool: string; line: string | null; detail?: CallDetail }[];
}

/** What one tool call was about, for its owner (apps/api/src/loop/call-detail.ts). Every field is optional. */
export interface CallDetail {
  query?: string;
  results?: { title: string; url: string }[];
  url?: string;
  title?: string;
  subject?: string;
  body?: string;
  note?: string;
  code?: string;
  input?: string;
}

const DETAIL_TEXT = ['query', 'url', 'title', 'subject', 'body', 'note', 'code', 'input'] as const;
/** The fields it can draw (strings up to 4,000 characters, at most 10 hits); null when nothing is left. */
export function asCallDetail(v: unknown): CallDetail | null {
  if (!isObj(v)) return null;
  const d: CallDetail = {};
  for (const k of DETAIL_TEXT) {
    const x = v[k];
    if (typeof x === 'string' && x.trim() !== '' && x.length <= 4000) d[k] = x;
  }
  if (Array.isArray(v.results)) {
    const hits = v.results.filter((h): h is { title: string; url: string } => isObj(h) && typeof h.title === 'string' && typeof h.url === 'string' && h.title.length <= 200 && h.url.length <= 500).slice(0, 10).map((h) => ({ title: h.title, url: h.url }));
    if (hits.length) d.results = hits;
  }
  return Object.keys(d).length ? d : null;
}
export interface RunDetail {
  id: string;
  mode: 'chat' | 'mission' | 'service';
  status: string;
  stopReason: string | null;
  steps: RunStep[];
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  toolCalls: number;
  /** USDC with 7 decimals, as stored. */
  usdcSpent: string;
  usdcEarned: string;
  settlementTx: string | null;
  summary: string | null;
  /** The mission's whole answer, as the model wrote it (markdown); null on older runs and on runs that wrote nothing. */
  result?: string | null;
  /** The model id the run used; null on older runs. Shown only inside Technical details. */
  model: string | null;
  triggerId: string | null;
  serviceId: string | null;
  startedAt: string;
  endedAt: string | null;
}

const strOrNull = (v: unknown): v is string | null => v === null || typeof v === 'string';
const usdc = (v: unknown): v is string => typeof v === 'string' && /^\d+(\.\d+)?$/.test(v);

/** The run inside `{ run }`, or null when the answer does not look right. Only a complete run is ever drawn. */
export function asRunDetail(v: unknown): RunDetail | null {
  if (!isObj(v) || !isObj(v.run)) return null;
  const r = v.run;
  if (typeof r.id !== 'string' || (r.mode !== 'chat' && r.mode !== 'mission' && r.mode !== 'service') || typeof r.status !== 'string') return null;
  if (!strOrNull(r.stopReason) || !strOrNull(r.settlementTx) || !strOrNull(r.summary) || !strOrNull(r.triggerId) || !strOrNull(r.serviceId)) return null;
  if (!count(r.inputTokens) || !count(r.outputTokens) || !count(r.cacheReadTokens) || !count(r.cacheWriteTokens) || !count(r.toolCalls)) return null;
  if (!usdc(r.usdcSpent) || !usdc(r.usdcEarned) || !isDate(r.startedAt) || !(r.endedAt === null || isDate(r.endedAt))) return null;
  if (!Array.isArray(r.steps)) return null;
  const steps: RunStep[] = [];
  for (const s of r.steps) {
    if (!isObj(s) || !count(s.n) || !Array.isArray(s.tools) || !s.tools.every((t) => typeof t === 'string') || !count(s.inputTokens) || !count(s.outputTokens)) return null;
    const calls = Array.isArray(s.calls)
      ? s.calls.filter((c): c is { tool: string; line: string | null } => isObj(c) && typeof c.tool === 'string' && (c.line === null || typeof c.line === 'string')).map((c) => {
            const detail = asCallDetail((c as { detail?: unknown }).detail);
            return { tool: c.tool, line: c.line, ...(detail ? { detail } : {}) };
          })
      : null;
    steps.push({ n: s.n, tools: s.tools as string[], inputTokens: s.inputTokens, outputTokens: s.outputTokens, finishReason: typeof s.finishReason === 'string' ? s.finishReason : '', ...(calls ? { calls } : {}) });
  }
  return {
    id: r.id, mode: r.mode, status: r.status, stopReason: r.stopReason, steps,
    inputTokens: r.inputTokens, outputTokens: r.outputTokens, cacheReadTokens: r.cacheReadTokens, cacheWriteTokens: r.cacheWriteTokens, toolCalls: r.toolCalls,
    usdcSpent: r.usdcSpent, usdcEarned: r.usdcEarned, settlementTx: r.settlementTx, summary: r.summary, ...(typeof r.result === 'string' && r.result.trim() !== '' ? { result: r.result } : {}), model: typeof r.model === 'string' ? r.model : null, triggerId: r.triggerId, serviceId: r.serviceId,
    startedAt: r.startedAt, endedAt: r.endedAt,
  };
}
