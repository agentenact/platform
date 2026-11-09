import type { SafeFetch, SafeFetchOptions } from '../../src/tools/safe-fetch.js';

/** A SafeFetch that answers from `routes` (undefined → 404) and records every call. */
export function fakeSafeFetch(
  routes: (url: string, o: SafeFetchOptions) => { status?: number; body: unknown; contentType?: string } | undefined,
): SafeFetch & { calls: { url: string; o: SafeFetchOptions }[] } {
  const calls: { url: string; o: SafeFetchOptions }[] = [];
  const f = async (url: string, o: SafeFetchOptions = {}) => {
    calls.push({ url, o });
    const r = routes(url, o) ?? { status: 404, body: { status: 404 } };
    const text = typeof r.body === 'string' ? r.body : JSON.stringify(r.body);
    return { status: r.status ?? 200, url, contentType: r.contentType ?? 'application/json', headers: new Headers(), body: new TextEncoder().encode(text) };
  };
  return Object.assign(f, { calls });
}
