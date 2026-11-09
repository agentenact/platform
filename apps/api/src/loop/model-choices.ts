/**
 * The models an owner may pick for one agent (Kerem, 2026-11-04: "agent dashboarduna model degistirmeyi de ekleyelim").
 * A short, curated list of OpenRouter slugs that call tools reliably, with their list prices in USD per million tokens
 * (OpenRouter /models, 2026-11-04), shown first as the suggested ones. An agent with no pick runs on MODEL_RUN, as before.
 *
 * Who pays: the platform pays OpenRouter, so a pricier model burns the owner's daily allowance faster instead of costing
 * more. A run on a picked model charges its tokens times `weight`, the model's blended price over the default model's
 * (at least 1). The daily token cap then holds about the same dollar cost per owner whichever model they pick.
 * Blended price = 80% input + 20% output: agent runs read much more than they write (tool results, context).
 *
 * Beyond the curated list, any model of the OpenRouter catalog (loop/catalog.ts) may be picked, weighted by its live price,
 * as long as its weight is at most MAX_WEIGHT: above that one step would spend most of a day's allowance.
 *
 * Only a type import of the catalog.
 */
import type { Catalog } from './catalog.js';
export interface ModelChoice {
  id: string;
  label: string;
  /** USD per million input / output tokens; null for a default model that is not in the list. */
  inUsd: number | null;
  outUsd: number | null;
}

export const MODEL_CHOICES: readonly ModelChoice[] = Object.freeze([
  { id: 'deepseek/deepseek-v4.1-flash', label: 'DeepSeek V4.1 Flash', inUsd: 0.045, outUsd: 0.5 },
  { id: 'anthropic/claude-haiku-5.5', label: 'Claude Haiku 5.5', inUsd: 0.1, outUsd: 0.5 },
  { id: 'minimax/minimax-m3.1-flash', label: 'MiniMax M3.1 Flash', inUsd: 0.15, outUsd: 0.6 },
  { id: 'google/gemini-3.5-flash-lite', label: 'Gemini 3.5 Flash Lite', inUsd: 0.3, outUsd: 2.5 },
  { id: 'moonshotai/kimi-k2.6', label: 'Kimi K2.6', inUsd: 0.65, outUsd: 3.41 },
  { id: 'openai/gpt-5.4-mini', label: 'GPT-5.4 mini', inUsd: 0.75, outUsd: 4.5 },
  { id: 'anthropic/claude-sonnet-5.5', label: 'Claude Sonnet 5.5', inUsd: 2, outUsd: 10 },
]);

/** A catalog model weighing more than this cannot be picked (gpt-5.4-pro at $30/$180 would be ~290×). */
export const MAX_WEIGHT = 50;

const REFERENCE = MODEL_CHOICES[0]!;
type Priced = { inUsd: number | null; outUsd: number | null };
const blended = (c: Priced) => (c.inUsd ?? 0) * 0.8 + (c.outUsd ?? 0) * 0.2;

export function findChoice(id: string): ModelChoice | null {
  return MODEL_CHOICES.find((c) => c.id === id) ?? null;
}

/**
 * How many allowance tokens one model token costs on `c` when the default is priced `base`: 1 for anything as cheap as the
 * default or cheaper, otherwise the blended price ratio rounded up to one decimal.
 */
export function weightFor(c: Priced, base: Priced): number {
  const b = blended(base);
  if (b <= 0) return 1;
  const ratio = blended(c) / b;
  return ratio <= 1 ? 1 : Math.ceil(ratio * 10) / 10;
}

/** The curated-list weight of `id` against `defaultId` (1 for the default and for an id off the list). */
export function weightOf(id: string, defaultId: string): number {
  if (id === defaultId) return 1;
  const c = findChoice(id);
  return c ? weightFor(c, findChoice(defaultId) ?? REFERENCE) : 1;
}

export interface Choice {
  id: string;
  label: string;
  weight: number;
  /** One of the curated, tried models (false: from the full catalog, not tried by us). */
  suggested: boolean;
}

/** What the agent page shows: the model it runs on, the owner's pick (null = default), and the suggested list. */
export interface ModelView {
  current: string;
  chosen: string | null;
  defaultId: string;
  /** The default, the curated models, and the current pick when it comes from the full catalog. */
  choices: Choice[];
  /** More models can be listed with GET /api/models. */
  catalog: boolean;
}

export interface ModelDirectory {
  /** The choice for a slug, or null when it cannot be picked (unknown, or heavier than MAX_WEIGHT). The default is always ok. */
  resolve(id: string): Promise<Choice | null>;
  view(chosen: string | null): Promise<ModelView>;
  /** Every pickable model: the suggested ones first, then the catalog by name. */
  all(): Promise<Choice[]>;
}

export function createModelDirectory(d: { defaultId: string; catalog?: Pick<Catalog, 'list' | 'find'> }): ModelDirectory {
  const { defaultId } = d;
  const basePrice = async (): Promise<Priced> => findChoice(defaultId) ?? (await d.catalog?.find(defaultId)) ?? REFERENCE;
  const defaultChoice = async (): Promise<Choice> => {
    const c = findChoice(defaultId) ?? (await d.catalog?.find(defaultId));
    return { id: defaultId, label: c?.label ?? defaultId, weight: 1, suggested: true };
  };
  const suggested = async (base: Priced): Promise<Choice[]> => [
    await defaultChoice(),
    ...MODEL_CHOICES.filter((c) => c.id !== defaultId).map((c) => ({ id: c.id, label: c.label, weight: weightFor(c, base), suggested: true })),
  ];

  const resolve = async (id: string): Promise<Choice | null> => {
    if (id === defaultId) return defaultChoice();
    const base = await basePrice();
    const curated = findChoice(id);
    if (curated) return { id, label: curated.label, weight: weightFor(curated, base), suggested: true };
    const c = await d.catalog?.find(id);
    if (!c) return null;
    const weight = weightFor(c, base);
    return weight <= MAX_WEIGHT ? { id, label: c.label, weight, suggested: false } : null;
  };

  return {
    resolve,
    async view(chosen) {
      const base = await basePrice();
      const list = await suggested(base);
      const pick = chosen !== null && chosen !== defaultId ? await resolve(chosen) : null;
      if (pick && !list.some((c) => c.id === pick.id)) list.push(pick);
      return { current: pick?.id ?? defaultId, chosen: pick?.id ?? null, defaultId, choices: list, catalog: !!d.catalog };
    },
    async all() {
      const base = await basePrice();
      const list = await suggested(base);
      const seen = new Set(list.map((c) => c.id));
      for (const c of (await d.catalog?.list()) ?? []) {
        if (seen.has(c.id)) continue;
        const weight = weightFor(c, base);
        if (weight <= MAX_WEIGHT) list.push({ id: c.id, label: c.label, weight, suggested: false });
      }
      return list;
    },
  };
}
