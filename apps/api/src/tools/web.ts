/** `web_search` (Tavily, then an injected paid fallback) and `web_read` (fetch + Readability). All HTTP through safeFetch. */
import { toolError } from './errors.js';
import { runIsolated } from './isolate.js';
import type { FallbackSearch, SearchHit } from '../loop/search.js';
import type { SafeFetch } from './safe-fetch.js';
import { cleanHit, cleanText, TITLE_MAX_CHARS } from './web-text.js';

export { TITLE_MAX_CHARS };

/** Tavily Search API (docs.tavily.com, 2026-10-07): POST, Bearer key, basic depth = 1 credit. */
export const TAVILY_URL = 'https://api.tavily.com/search';
/** Tavily: 429 rate limit, 432 plan limit, 433 pay-as-you-go limit. */
const TAVILY_QUOTA = new Set([429, 432, 433]);
/** Tavily: invalid parameters. A different provider will not fix these, so they never fall back. */
const TAVILY_BAD_ARGS = new Set([400, 422]);
export const READ_MAX_CHARS = 20_000;
const READ_MAX_BYTES = 2_000_000;
/** HTML handed to the isolate pool is cut here: hostile markup costs the child, not the api. */
export const EXTRACT_MAX_CHARS = 256 * 1024;
export const EXTRACT_HARD_KILL_MS = 3_000;

export type PaidAdmit = () => PaidAdmitted | Promise<PaidAdmitted>;
type PaidAdmitted = true | 'agent' | 'global';

export interface Web {
  /**
   * `admitPaid` is required and asked once, only when the paid fallback is about to run; anything but `true`
   * ends in `search_limit` (a refusal scope is logged). A missing one counts as a refusal, never as uncapped.
   */
  search(query: string, count: number | undefined, signal: AbortSignal | undefined, admitPaid: PaidAdmit): Promise<{ results: SearchHit[] }>;
  read(url: string, signal?: AbortSignal): Promise<{ url: string; title: string; text: string }>;
}

const clip = (s: string) => s.replace(/\s+/g, ' ').trim().slice(0, READ_MAX_CHARS);
const cleanTitle = (s: string) => cleanText(s, TITLE_MAX_CHARS);
const stripTags = (s: string) => s.replace(/<[^>]*>/g, '');
const decode = (b: Uint8Array) => new TextDecoder().decode(b);

export interface WebDeps {
  safeFetch: SafeFetch;
  /** Absent: Tavily is unconfigured and every search takes the fallback. */
  tavilyKey?: string;
  /** The paid fallback (loop's OpenRouter search), injected so the OpenRouter key stays in loop. */
  fallback?: FallbackSearch;
  /** Fixed events only: never a key, a query or an error object. */
  log?: (e: Record<string, unknown>) => void;
}

type FallbackReason = 'unconfigured' | 'quota' | 'auth' | 'error';

export function createWeb(o: WebDeps): Web {
  async function tavily(query: string, count: number, key: string, signal?: AbortSignal): Promise<SearchHit[] | FallbackReason | 'bad_args'> {
    let r;
    try {
      r = await o.safeFetch(TAVILY_URL, {
        method: 'POST',
        headers: { accept: 'application/json', 'content-type': 'application/json', authorization: `Bearer ${key}` },
        body: JSON.stringify({ query, max_results: count, search_depth: 'basic', include_answer: false }),
        signal,
        maxBytes: READ_MAX_BYTES,
      });
    } catch {
      if (signal?.aborted) throw toolError('search_failed');
      return 'error';
    }
    if (TAVILY_QUOTA.has(r.status)) return 'quota';
    if (TAVILY_BAD_ARGS.has(r.status)) return 'bad_args';
    if (r.status === 401 || r.status === 403) return 'auth';
    if (r.status !== 200) return 'error';
    let j: { results?: { title?: unknown; url?: unknown; content?: unknown }[] };
    try {
      j = JSON.parse(decode(r.body));
    } catch {
      return 'error';
    }
    if (!Array.isArray(j?.results)) return j && typeof j === 'object' ? [] : 'error';
    const hits: SearchHit[] = [];
    for (const x of j.results) {
      const h = x && typeof x === 'object' ? cleanHit({ title: x.title, url: x.url, description: stripTags(String(x.content ?? '')) }) : undefined;
      if (h) hits.push(h);
      if (hits.length >= count) break;
    }
    return hits;
  }

  return {
    async search(query, rawCount = 5, signal, admitPaid) {
      const count = Number.isFinite(rawCount) ? Math.min(10, Math.max(1, Math.trunc(rawCount))) : 5;
      let reason: FallbackReason = 'unconfigured';
      if (o.tavilyKey) {
        const t = await tavily(query, count, o.tavilyKey, signal);
        if (t === 'bad_args') throw toolError('search_failed');
        if (typeof t !== 'string') return { results: t };
        reason = t;
      }
      // No fallback: fail before a paid slot is spent on nothing.
      if (!o.fallback) throw toolError('search_failed');
      const admitted = typeof admitPaid === 'function' ? await admitPaid() : 'agent';
      if (admitted !== true) {
        if (typeof admitPaid === 'function') o.log?.({ event: 'search_limit', scope: admitted });
        throw toolError('search_limit');
      }
      o.log?.({ event: 'search_fallback', reason });
      try {
        return { results: (await o.fallback(query, count, signal)).slice(0, count) };
      } catch {
        throw toolError('search_failed');
      }
    },

    async read(url, signal) {
      const r = await o.safeFetch(url, { headers: { accept: 'text/html,application/xhtml+xml,text/plain;q=0.9' }, signal, maxBytes: READ_MAX_BYTES });
      if (r.status !== 200) throw toolError('read_failed');
      const type = (r.contentType.split(';')[0] ?? '').trim().toLowerCase();
      const raw = decode(r.body);
      if (type === 'text/plain') return { url: r.url, title: '', text: clip(raw) };
      if (type !== 'text/html' && type !== 'application/xhtml+xml') throw toolError('unsupported_content');
      if (raw.trim() === '') throw toolError('read_failed');
      const x = await runIsolated('extract', { html: raw.slice(0, EXTRACT_MAX_CHARS) }, EXTRACT_HARD_KILL_MS, signal);
      if (!x.ok) throw toolError(x.fault === 'platform' && x.error === 'busy' ? 'busy' : 'read_failed');
      const v = x.value as { title?: unknown; text?: unknown };
      return { url: r.url, title: cleanTitle(String(v.title ?? '')), text: clip(String(v.text ?? '')) };
    },
  };
}
