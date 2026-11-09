/** `market_price`: USD prices by CoinGecko id, from DefiLlama first, CoinGecko for whatever is missing. */
import { toolError } from './errors.js';
import type { SafeFetch } from './safe-fetch.js';

export const LLAMA_URL = 'https://coins.llama.fi/prices/current/';
export const COINGECKO_URL = 'https://api.coingecko.com/api/v3/simple/price';
const ID = /^[a-z0-9-]{1,64}$/;

export interface Market {
  marketPrice(a: { ids: string[] }, signal?: AbortSignal): Promise<{ prices: Record<string, number | null>; source: 'defillama' | 'coingecko' | 'mixed' }>;
}

const decode = (b: Uint8Array) => new TextDecoder().decode(b);
const num = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) && v >= 0 ? v : null);
const own = <T>(o: Record<string, T> | undefined, k: string): T | undefined => (o && Object.hasOwn(o, k) ? o[k] : undefined);
/** Own keys only: ids like `constructor` must never resolve to inherited members. */
const bag = (entries: [string, number | null][]): Record<string, number | null> => Object.assign(Object.create(null) as Record<string, number | null>, Object.fromEntries(entries));

export function createMarket(o: { safeFetch: SafeFetch }): Market {
  async function llama(ids: string[], signal?: AbortSignal): Promise<Record<string, number | null>> {
    try {
      const r = await o.safeFetch(`${LLAMA_URL}${ids.map((i) => `coingecko:${i}`).join(',')}`, { headers: { accept: 'application/json' }, signal });
      if (r.status !== 200) return bag([]);
      const j = JSON.parse(decode(r.body)) as { coins?: Record<string, { price?: unknown }> };
      return bag(ids.map((i) => [i, num(own(j.coins, `coingecko:${i}`)?.price)]));
    } catch {
      return bag([]);
    }
  }

  async function coingecko(ids: string[], signal?: AbortSignal): Promise<Record<string, number | null>> {
    const u = new URL(COINGECKO_URL);
    u.searchParams.set('ids', ids.join(','));
    u.searchParams.set('vs_currencies', 'usd');
    try {
      const r = await o.safeFetch(u.toString(), { headers: { accept: 'application/json' }, signal });
      if (r.status !== 200) return bag([]);
      const j = JSON.parse(decode(r.body)) as Record<string, { usd?: unknown }>;
      return bag(ids.map((i) => [i, num(own(j, i)?.usd)]));
    } catch {
      return bag([]);
    }
  }

  return {
    async marketPrice(a, signal) {
      if (a.ids.length === 0 || a.ids.length > 10 || !a.ids.every((i) => ID.test(i))) throw toolError('bad_args');
      const first = await llama(a.ids, signal);
      const missing = a.ids.filter((i) => first[i] == null);
      if (missing.length === 0) return { prices: bag(a.ids.map((i) => [i, first[i]!])), source: 'defillama' };
      const second = await coingecko(missing, signal);
      const prices = bag(a.ids.map((i) => [i, first[i] ?? second[i] ?? null]));
      if (Object.values(prices).every((p) => p === null)) throw toolError('price_unavailable');
      const fromLlama = a.ids.some((i) => first[i] != null);
      return { prices, source: fromLlama ? 'mixed' : 'coingecko' };
    },
  };
}
