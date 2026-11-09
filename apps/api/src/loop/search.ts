/**
 * Paid web-search fallback for `web_search`: OpenRouter's web plugin (docs, 2026-10-07). One call to the cheap
 * model with `plugins: [{ id: 'web', engine: 'exa', max_results }]` and a tiny `max_tokens`: the answer text is
 * discarded, only the `url_citation` annotations (url, title, content) are kept. Lives in `loop` so the
 * OpenRouter key stays here; tools receive this function as an injected dependency. Billed per search by
 * OpenRouter, outside our token caps (policy.paidSearch bounds it): Exa $0.007 per request plus the injected
 * results billed as the cheap model's input tokens, well under a cent per search on the default. The query is sent raw as the whole user
 * message (the plugin's `search_prompt` only rewords how results are attached, it does not change the query).
 * Never logs anything; failures are a fixed `tool: search_failed`.
 */
import type { SafeFetch } from '../tools/safe-fetch.js';
import { cleanHit } from '../tools/web-text.js';
import { MODEL_IDS } from './models.js';

export const OPENROUTER_CHAT_URL = 'https://openrouter.ai/api/v1/chat/completions';
export const FALLBACK_MAX_RESULTS = 5;
const MAX_TOKENS = 64;
const TIMEOUT_MS = 30_000;

export interface SearchHit {
  title: string;
  url: string;
  description: string;
}
export type FallbackSearch = (query: string, count: number, signal?: AbortSignal) => Promise<SearchHit[]>;

const failed = () => Object.assign(new Error('tool: search_failed'), { code: 'search_failed' });

export function createOpenRouterSearch(o: { safeFetch: SafeFetch; env?: Record<string, string | undefined> }): FallbackSearch {
  const key = (o.env ?? process.env).OPENROUTER_API_KEY;
  if (!key) throw new Error('loop: OPENROUTER_API_KEY is not set');
  return async (query, count, signal) => {
    const r = await o.safeFetch(OPENROUTER_CHAT_URL, {
      method: 'POST',
      headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json', accept: 'application/json', 'http-referer': 'https://agentenact.io', 'x-title': 'AgentEnact' },
      body: JSON.stringify({
        model: MODEL_IDS.cheap,
        messages: [{ role: 'user', content: query }],
        plugins: [{ id: 'web', engine: 'exa', max_results: FALLBACK_MAX_RESULTS }],
        max_tokens: MAX_TOKENS,
      }),
      timeoutMs: TIMEOUT_MS,
      signal,
    });
    if (r.status !== 200) throw failed();
    let j: { choices?: { message?: { annotations?: { type?: unknown; url_citation?: { url?: unknown; title?: unknown; content?: unknown } }[] } }[] };
    try {
      j = JSON.parse(new TextDecoder().decode(r.body));
    } catch {
      throw failed();
    }
    const seen = new Set<string>();
    const out: SearchHit[] = [];
    for (const a of j.choices?.[0]?.message?.annotations ?? []) {
      const c = a?.type === 'url_citation' ? a.url_citation : undefined;
      const h = cleanHit({ title: c?.title, url: c?.url, description: c?.content });
      if (!h || seen.has(h.url)) continue;
      seen.add(h.url);
      out.push(h);
      if (out.length >= count) break;
    }
    return out;
  };
}
