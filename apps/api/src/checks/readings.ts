/**
 * What one condition check read, in a few numbers and one plain line (run-readings D1/D2). The stored `reading` is a
 * per-tool extract, never the raw fetch; `line` is the sentence the feed and the trial show. One extractor serves both,
 * so the numbers can never disagree. Never throws: anything unexpected is `{ reading: null, line: null }`.
 * No full address, email or raw argument ever leaves here (accounts are shortened as GABC…WXYZ).
 */
import { bannedWord } from '../builder/words.js';
import type { ConditionFetchTool } from '../specs/schema.js';

export type Reading = Record<string, number | string>;
export interface ReadingOut {
  reading: Reading | null;
  line: string | null;
}

const NONE: ReadingOut = { reading: null, line: null };
/** check_log.reading is capped at 512 bytes by the table; jsonb text adds spaces, so stay well under. */
export const READING_MAX_BYTES = 400;
const MAX_ASSETS = 5;
const MINUS = '−';

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const num = (v: unknown): number | null => {
  const n = typeof v === 'string' && v.trim() !== '' ? Number(v) : v;
  // jsonb prints a number in full ("1e300" is 301 digits), so keep to a sane range; zero is fine.
  return typeof n === 'number' && Number.isFinite(n) && Math.abs(n) <= 1e15 && (n === 0 || Math.abs(n) >= 1e-9) ? n : null;
};
const DECIMAL = /^\d+(\.\d+)?$/;
const CODE = /^[A-Za-z0-9]{1,12}$/;
const str = (v: unknown, max = 40): string | null => (typeof v === 'string' && v.length > 0 ? v.slice(0, max) : null);

/** Price text: "$0.1913", "$67,432.10". */
export function usd(n: number): string {
  const digits = n >= 1 ? 2 : n >= 0.01 ? 4 : 6;
  return `$${n.toLocaleString('en-US', { minimumFractionDigits: digits, maximumFractionDigits: digits })}`;
}

/** "−0.42%" with a true minus sign, "+0.42%" going up. */
export function pct(n: number): string {
  const s = Math.abs(n).toFixed(2);
  return `${n < 0 && Number(s) !== 0 ? MINUS : n > 0 ? '+' : ''}${s}%`;
}

/** A decimal amount without trailing zeros: "120.0000000" becomes "120". */
function amountText(a: string): string {
  return /^\d+\.\d+$/.test(a) ? a.replace(/\.?0+$/, '') : a;
}

export function shortAccount(a: string): string | null {
  return /^G[A-Z2-7]{55}$/.test(a) ? `${a.slice(0, 4)}…${a.slice(-4)}` : null;
}

/** Any chain's wallet address, shortened: `0x12…abcd`, `GABC…WXYZ`, `bc1q…wxyz`. */
function shortWallet(a: string): string | null {
  return /^(0x[0-9a-fA-F]{40}|G[A-Z2-7]{55}|[1-9A-HJ-NP-Za-km-z]{25,44}|(bc1|tb1)[02-9ac-hj-np-z]{11,87})$/.test(a) ? `${a.slice(0, 4)}…${a.slice(-4)}` : null;
}

function windowText(s: number): string {
  if (s % 86_400 === 0) return s === 86_400 ? 'the last day' : `the last ${s / 86_400} days`;
  if (s % 3600 === 0) return s === 3600 ? 'the last hour' : `the last ${s / 3600} hours`;
  const m = Math.max(1, Math.round(s / 60));
  return `the last ${m} minutes`;
}

/** Drop trailing fields until the serialized reading fits. jsonb text puts a space after every ':' and ','. */
function fit(r: Reading): Reading | null {
  const entries = Object.entries(r);
  const size = (e: [string, number | string][]) => new TextEncoder().encode(JSON.stringify(Object.fromEntries(e))).length + 2 * e.length;
  while (entries.length > 1 && size(entries) > READING_MAX_BYTES) entries.pop();
  return size(entries) > READING_MAX_BYTES ? null : Object.fromEntries(entries);
}

function priceChange(args: unknown, d: Record<string, unknown>): ReadingOut {
  const symbol = str(d.symbol, 12);
  const changePct = num(d.changePct);
  const from = isObj(d.from) ? num(d.from.usd) : null;
  const to = isObj(d.to) ? num(d.to.usd) : null;
  if (!symbol || changePct === null || from === null || to === null) return NONE;
  const win = num(d.windowSeconds) ?? (isObj(args) ? num(args.window_s) : null);
  const tail = win !== null && win > 0 ? ` in ${windowText(win)}` : '';
  // An old price (the tool flags it stale) must not read as a current move.
  if (d.stale === true) return { reading: { symbol, changePct, from, to, stale: 1 }, line: `${symbol} price is out of date, last seen ${pct(changePct)}${tail}` };
  return { reading: { symbol, changePct, from, to }, line: `${symbol} moved ${pct(changePct)}${tail}` };
}

function stellarPrice(d: Record<string, unknown>): ReadingOut {
  const symbol = str(d.symbol, 12);
  const price = num(d.usd);
  if (!symbol || price === null) return NONE;
  return { reading: { symbol, price }, line: `${symbol} is at ${usd(price)}` };
}

const TICKERS: Record<string, string> = Object.assign(Object.create(null) as Record<string, string>, {
  stellar: 'XLM', bitcoin: 'BTC', ethereum: 'ETH', solana: 'SOL', 'usd-coin': 'USDC', tether: 'USDT', ripple: 'XRP', dogecoin: 'DOGE', celo: 'CELO',
});

function marketPrice(args: unknown, d: Record<string, unknown>): ReadingOut {
  if (!isObj(d.prices)) return NONE;
  const ids = isObj(args) && Array.isArray(args.ids) ? args.ids : Object.keys(d.prices);
  for (const id of ids) {
    if (typeof id !== 'string' || !Object.hasOwn(d.prices, id)) continue;
    const price = num(d.prices[id]);
    const symbol = str(id, 64);
    if (price === null || !symbol) continue;
    const ticker = TICKERS[symbol];
    const name = ticker ?? symbol.split('-').map((w) => `${w.slice(0, 1).toUpperCase()}${w.slice(1)}`).join(' ');
    return { reading: { symbol: ticker ?? symbol, price }, line: `${name} is at ${usd(price)}` };
  }
  return NONE;
}

function payments(d: Record<string, unknown>): ReadingOut {
  if (!Array.isArray(d.payments)) return NONE;
  let best: { n: number; text: string } | null = null;
  for (const p of d.payments) {
    if (!isObj(p)) return NONE;
    const n = typeof p.amount === 'string' && DECIMAL.test(p.amount) ? num(p.amount) : null;
    const asset = str(p.asset, 80);
    if (n === null || !asset || typeof p.amount !== 'string') return NONE;
    const code = asset.split(':')[0]!;
    if (!CODE.test(code)) return NONE;
    if (!best || n > best.n) best = { n, text: `${amountText(p.amount)} ${code}` };
  }
  const count = d.payments.length;
  if (!best) return { reading: { count: 0 }, line: 'No payments' };
  return { reading: { count, largest: best.text }, line: count === 1 ? `1 payment of ${best.text}` : `${count} payments, the largest ${best.text}` };
}

function accountRead(d: Record<string, unknown>): ReadingOut {
  if (d.exists !== true || typeof d.id !== 'string' || !Array.isArray(d.balances)) return NONE;
  const account = shortAccount(d.id);
  if (!account) return NONE;
  const reading: Reading = { account };
  const parts: string[] = [];
  for (const b of d.balances) {
    if (!isObj(b) || typeof b.asset !== 'string' || typeof b.balance !== 'string') continue;
    const n = num(b.balance);
    const code = b.asset.split(':')[0]!;
    if (n === null || b.asset.startsWith('LP:') || !CODE.test(code) || code === 'account' || Object.hasOwn(reading, code)) continue; // LP shares and odd codes are skipped
    if (Object.keys(reading).length > MAX_ASSETS) break;
    reading[code] = n;
    parts.push(`${amountText(b.balance)} ${code}`);
  }
  if (parts.length === 0) return NONE;
  return { reading, line: `${account} holds ${parts.slice(0, 2).join(' and ')}` };
}

function walletBalance(d: Record<string, unknown>): ReadingOut {
  if (d.exists !== true || typeof d.address !== 'string' || !Array.isArray(d.balances)) return NONE;
  const account = shortWallet(d.address);
  if (!account) return NONE;
  const reading: Reading = { account };
  const parts: string[] = [];
  for (const b of d.balances.slice(0, MAX_ASSETS)) {
    if (!isObj(b) || typeof b.symbol !== 'string' || typeof b.amount !== 'string' || !CODE.test(b.symbol) || b.symbol === 'account' || Object.hasOwn(reading, b.symbol)) continue;
    const n = DECIMAL.test(b.amount) ? num(b.amount) : null;
    if (n === null) continue;
    reading[b.symbol] = n;
    parts.push(`${amountText(b.amount)} ${b.symbol}`);
  }
  if (parts.length === 0) return NONE;
  return { reading, line: `${account} holds ${parts.slice(0, 2).join(' and ')}` };
}

/** The reading and plain line for one condition fetch. `args` is only used for context the data omits (window, ids). */
export function readingOf(tool: ConditionFetchTool, args: unknown, data: unknown): ReadingOut {
  try {
    if (!isObj(data)) return NONE;
    const out =
      tool === 'stellar_price_change' ? priceChange(args, data)
      : tool === 'stellar_price' ? stellarPrice(data)
      : tool === 'market_price' ? marketPrice(args, data)
      : tool === 'stellar_payments' || tool === 'wallet_payments' ? payments(data)
      : tool === 'wallet_balance' ? walletBalance(data)
      : tool === 'stellar_read' ? accountRead(data)
      : NONE;
    if (!out.reading) return NONE;
    const reading = fit(out.reading);
    if (!reading) return NONE;
    // A line is shown outside Technical details: never one with a banned word (an odd asset code could carry one).
    const line = out.line && out.line.length <= 160 && bannedWord(out.line) === null ? out.line : null;
    return { reading, line };
  } catch {
    return NONE;
  }
}

// ---- One plain line per tool call a run made (run-readings D3) ----

const CONDITION_TOOLS = new Set<string>(['stellar_price_change', 'stellar_price', 'stellar_read', 'stellar_payments', 'wallet_payments', 'wallet_balance', 'market_price']);
const LINE_MAX = 160;
const QUOTE_MAX = 60;
/** Zero-width and bidi control characters: stripped before anything is quoted. */
const INVISIBLE = /[\u200b-\u200f\u202a-\u202e\u2066-\u2069\ufeff]/g;
const WORD = /^\p{L}+(?:['’-]\p{L}+)*$/u;
const NUMBER = /^\$?\d{1,6}(?:\.\d{1,4})?%?$/;
const LONE_PUNCT = /^[.,:;!?()"'–—]$/;

/** One token of a quote: a plain word, a short number, or a lone mark. Wrapping marks around a word ("(hi)", "hi!") are allowed. */
function plainToken(t: string): boolean {
  if (LONE_PUNCT.test(t)) return true;
  const core = t.replace(/^[("']+/, '').replace(/[.,:;!?)"']+$/, '');
  if (core.length === 0 || core.length > 20) return false;
  return WORD.test(core) || NUMBER.test(core);
}

/**
 * Untrusted text from a model or a page, made safe to quote. An ALLOWLIST: only plain words, short numbers and lone marks
 * pass (a key, address, domain, id or mixed letter-digit token never does). Null means "use the bare phrase".
 */
function quotable(v: unknown): string | null {
  if (typeof v !== 'string') return null;
  const t = v.replace(INVISIBLE, '').replace(/[\u0000-\u001f\u007f\s]+/g, ' ').trim();
  if (!t || t.length > QUOTE_MAX || !t.split(' ').every(plainToken) || bannedWord(t) !== null) return null;
  return t;
}

const LABEL = /^[a-z][a-z0-9-]{0,24}$/;
function hostOf(v: unknown): string | null {
  if (typeof v !== 'string') return null;
  try {
    const { protocol, hostname } = new URL(v);
    if (protocol !== 'https:' && protocol !== 'http:') return null;
    const h = hostname.toLowerCase();
    const labels = h.split('.');
    if (labels.length > 4 || !labels.every((l) => LABEL.test(l) && !/^[0-9a-f]{12,}$/.test(l))) return null;
    return bannedWord(h) === null ? h : null;
  } catch {
    return null;
  }
}

const isSent = (r: unknown): boolean => isObj(r) && r.sent === true;

/**
 * A plain sentence for one tool call, or null when the tool is unknown or its result gives nothing to say. Never the raw
 * arguments; never a full address, email, URL or secret. Never throws. `args` and `result` are the model's input and the tool's output.
 */
export function callLine(tool: string, args: unknown, result: unknown): string | null {
  try {
    const a = isObj(args) ? args : {};
    let line: string | null;
    if (CONDITION_TOOLS.has(tool)) line = readingOf(tool as ConditionFetchTool, args, result).line;
    else if (tool === 'send_email') {
      const q = quotable(a.subject);
      line = !isSent(result) ? 'Tried to email you' : q ? `Emailed you: "${q}"` : 'Emailed you';
    } else if (tool === 'web_search') {
      const q = quotable(a.query);
      line = q ? `Searched the web for "${q}"` : 'Searched the web';
    } else if (tool === 'web_read') {
      const h = hostOf(a.url);
      line = h ? `Read a page on ${h}` : 'Read a web page';
    } else if (tool === 'compute') line = 'Worked something out';
    else if (tool === 'send_webhook') line = isSent(result) ? 'Called your webhook' : 'Tried to call your webhook';
    else if (tool === 'remember') line = 'Made a note for next time';
    else if (tool === 'hire_agent') {
      const r = isObj(result) ? result : {};
      const raw = typeof r.paid_usdc === 'string' && DECIMAL.test(r.paid_usdc) ? r.paid_usdc : null;
      const paid = raw === null ? null : num(raw);
      const badStatus = typeof r.status === 'number' && (r.status < 200 || r.status > 299);
      if (r.payment === 'settled') line = raw !== null && paid !== null && paid > 0 ? `Paid another agent for help (${amountText(raw)} USDC on testnet)` : 'Paid another agent for help';
      else if (r.payment === 'unknown') line = 'Asked another agent for help (payment not confirmed)';
      else if (r.error !== undefined || badStatus) line = 'Tried to get help from another agent';
      else line = 'Asked another agent for help';
    } else line = null;
    return line && line.length <= LINE_MAX && bannedWord(line) === null ? line : null;
  } catch {
    return null;
  }
}

/**
 * One plain sentence for a stored reading (the per-tool extract in check_log), for places that have the numbers but not the
 * tool call, such as the alert email. Null when the reading has no sentence; never a banned word.
 */
export function readingSentence(r: Reading): string | null {
  try {
    const symbol = typeof r.symbol === 'string' ? r.symbol.slice(0, 12) : null;
    let line: string | null = null;
    if (symbol && typeof r.changePct === 'number' && typeof r.from === 'number' && typeof r.to === 'number') {
      line = r.stale === 1 ? `${symbol} price was out of date, last seen ${pct(r.changePct)}` : `${symbol} moved ${pct(r.changePct)}, from ${usd(r.from)} to ${usd(r.to)}`;
    } else if (symbol && typeof r.price === 'number') line = `${symbol} was at ${usd(r.price)}`;
    else if (typeof r.count === 'number') line = r.count === 0 ? 'No payments' : typeof r.largest === 'string' ? `${r.count} ${r.count === 1 ? 'payment' : 'payments'}, the largest ${r.largest.slice(0, 40)}` : `${r.count} payments`;
    return line && line.length <= 160 && bannedWord(line) === null ? line : null;
  } catch {
    return null;
  }
}
