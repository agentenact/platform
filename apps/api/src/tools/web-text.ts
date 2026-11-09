/**
 * Pure cleaners for every string that comes from the web (search titles, snippets, URLs) before it reaches the
 * model. Shared by Tavily (tools/web.ts) and the OpenRouter fallback (loop/search.ts). No imports.
 */
export const TITLE_MAX_CHARS = 300;
export const SNIPPET_MAX_CHARS = 500;
export const URL_MAX_CHARS = 2000;

/** Control characters become spaces, whitespace collapses, then the cap applies. */
// eslint-disable-next-line no-control-regex
export const cleanText = (s: string, max: number): string => s.replace(/[\u0000-\u001f\u007f-\u009f]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, max);

/** The URL itself when it is http(s) and within URL_MAX_CHARS, else undefined (the result is dropped, never truncated). */
export function cleanUrl(s: string): string | undefined {
  const u = s.trim();
  if (u.length === 0 || u.length > URL_MAX_CHARS || !/^https?:\/\//i.test(u)) return undefined;
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u001f\u007f-\u009f\s]/.test(u)) return undefined;
  try {
    const p = new URL(u).protocol;
    return p === 'http:' || p === 'https:' ? u : undefined;
  } catch {
    return undefined;
  }
}

export interface RawHit {
  title?: unknown;
  url?: unknown;
  description?: unknown;
}
/** One cleaned hit, or undefined when its URL does not pass. */
export function cleanHit(h: RawHit): { title: string; url: string; description: string } | undefined {
  const url = typeof h.url === 'string' ? cleanUrl(h.url) : undefined;
  if (!url) return undefined;
  return { title: cleanText(String(h.title ?? ''), TITLE_MAX_CHARS), url, description: cleanText(String(h.description ?? ''), SNIPPET_MAX_CHARS) };
}
