/**
 * The OpenRouter model catalog (Kerem, 2026-11-04: "openrouter katalogunu komple kullanabilmeliyiz"): GET /api/v1/models,
 * public, no key. Kept to models an agent can run on: text in and out, tool calling, a real price (no free, batch or
 * negative-priced router entries). Refreshed at most every `ttlMs`; a failed refresh keeps the last good list (and an empty
 * one before the first success, so the curated choices in model-choices.ts still work). Never throws.
 */
const URL_MODELS = 'https://openrouter.ai/api/v1/models';
const SLUG = /^[\w.-]+\/[\w.:-]+$/;
const MAX_PRICE = 10_000; // USD per million tokens; anything above is a bad entry

export interface CatalogModel {
  id: string;
  label: string;
  /** USD per million input / output tokens. */
  inUsd: number;
  outUsd: number;
}

export interface Catalog {
  list(): Promise<CatalogModel[]>;
  find(id: string): Promise<CatalogModel | null>;
}

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const strList = (v: unknown): string[] => (Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : []);
/** OpenRouter prices are USD per token, as strings. */
const perMillion = (v: unknown): number | null => {
  const n = typeof v === 'string' ? Number(v) : typeof v === 'number' ? v : NaN;
  if (!Number.isFinite(n) || n < 0) return null;
  const m = Math.round(n * 1e6 * 1e6) / 1e6;
  return m <= MAX_PRICE ? m : null;
};

/** The models of one /models answer an agent can run on. Exported for tests. */
export function parseCatalog(body: unknown): CatalogModel[] {
  if (!isObj(body) || !Array.isArray(body.data)) return [];
  const out: CatalogModel[] = [];
  for (const m of body.data) {
    if (!isObj(m) || typeof m.id !== 'string' || !SLUG.test(m.id) || m.id.length > 120) continue;
    if (m.id.endsWith(':free') || m.id.includes(':batch') || m.id.startsWith('openrouter/')) continue;
    if (!strList(m.supported_parameters).includes('tools')) continue;
    const arch = isObj(m.architecture) ? m.architecture : {};
    const ins = strList(arch.input_modalities);
    const outs = strList(arch.output_modalities);
    if ((ins.length > 0 && !ins.includes('text')) || (outs.length > 0 && !outs.includes('text'))) continue;
    const pricing = isObj(m.pricing) ? m.pricing : {};
    const inUsd = perMillion(pricing.prompt);
    const outUsd = perMillion(pricing.completion);
    if (inUsd === null || outUsd === null || inUsd + outUsd === 0) continue;
    const name = typeof m.name === 'string' && m.name.trim() !== '' ? m.name.trim().slice(0, 80) : m.id;
    out.push({ id: m.id, label: name, inUsd, outUsd });
  }
  return out.sort((a, b) => a.label.localeCompare(b.label));
}

export function createCatalog(d: { fetch?: typeof fetch; now?: () => number; ttlMs?: number; timeoutMs?: number } = {}): Catalog {
  const doFetch = d.fetch ?? fetch;
  const now = d.now ?? Date.now;
  const ttlMs = d.ttlMs ?? 6 * 60 * 60_000;
  const timeoutMs = d.timeoutMs ?? 8_000;
  let good: { at: number; list: CatalogModel[]; byId: Map<string, CatalogModel> } | null = null;
  let failedAt = -Infinity;
  let inflight: Promise<void> | null = null;

  const refresh = async () => {
    try {
      const res = await doFetch(URL_MODELS, { headers: { accept: 'application/json' }, signal: AbortSignal.timeout(timeoutMs) });
      if (!res.ok) throw new Error(String(res.status));
      const list = parseCatalog(await res.json());
      if (list.length === 0) throw new Error('empty');
      good = { at: now(), list, byId: new Map(list.map((m) => [m.id, m])) };
    } catch {
      failedAt = now();
    }
  };

  const fresh = async () => {
    const stale = !good || now() - good.at >= ttlMs;
    // After a failure wait a minute before asking again, so a down catalog is not hit on every page view.
    if (stale && now() - failedAt >= 60_000) {
      inflight ??= refresh().finally(() => (inflight = null));
      // A stale list answers at once; only the very first read waits for the fetch.
      if (!good) await inflight;
    }
    return good;
  };

  return {
    async list() {
      return (await fresh())?.list ?? [];
    },
    async find(id) {
      return (await fresh())?.byId.get(id) ?? null;
    },
  };
}
