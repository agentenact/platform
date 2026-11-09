/**
 * A ready agent's values as they travel: from the /create builder to the address bar (`p.<param>=<value>`), into the
 * draft flow and into the code view. No React and no browser globals, so every step is testable on its own.
 *
 * The values are raw strings on the way (they come from a URL) and are checked against the draft's own params on arrival:
 * a number must be in range, a choice must be one of the options, a time a daily or weekly hour, a text at most 100 characters. Anything else is dropped.
 * The draft flow applies them through the api's param engine (the same edit a tap makes); the builder and the code view
 * apply them here with `withValues`, which tests/create-builder.test.tsx keeps equal to the api's applyParam.
 */
import { parseText, parseTime, timeValue } from './draft-display';
import type { DraftData, OptionValue, ParamSpec } from './draft-types';

/** The address-bar prefix of a value: `?p.drop=10`. Keeps param ids clear of `template`, `prompt`, `view` and the rest. */
export const VALUE_PREFIX = 'p.';
/** The api's param id (apps/api/src/builder/draft-schema.ts PARAM_ID). */
const PARAM_ID = /^[a-z][a-z0-9_]{0,23}$/;
/** A draft has at most 6 params (DraftView in the api). */
const MAX_VALUES = 6;

/** Raw values by param id. */
export type Values = Record<string, string>;

const first = (v: string | string[] | undefined): string | undefined => (Array.isArray(v) ? v[0] : v);

/** Whether a query parameter name is a value (`p.drop`). */
export const isValueKey = (name: string): boolean => name.startsWith(VALUE_PREFIX) && PARAM_ID.test(name.slice(VALUE_PREFIX.length));

/** The `p.<id>` values of a page's search params: well-formed ids only, at most 100 characters each, at most six. */
export function readValues(sp: Record<string, string | string[] | undefined>): Values {
  const out: Values = {};
  for (const [k, raw] of Object.entries(sp)) {
    const v = first(raw);
    if (!isValueKey(k) || v === undefined || v.length > 100 || Object.keys(out).length >= MAX_VALUES) continue;
    out[k.slice(VALUE_PREFIX.length)] = v;
  }
  return out;
}

/** A raw value as this param takes it, or null when it does not fit (out of range, not an option, empty or too long). */
export function coerceValue(p: ParamSpec, raw: string): OptionValue | null {
  if (p.kind === 'number') {
    if (raw.trim() === '') return null;
    const n = Number(raw);
    return Number.isFinite(n) && n >= p.min && n <= p.max ? n : null;
  }
  if (p.kind === 'choice') return p.options.find((o) => String(o.value) === raw)?.value ?? null;
  if (p.kind === 'time') {
    // The api's applyParam: any minute and hour, the day kind (every day or one weekday) kept, written in one form.
    const t = parseTime(raw);
    return t && (t.weekday === null) === (parseTime(p.value)?.weekday === null) ? timeValue(t) : null;
  }
  return parseText(raw);
}

/** A value as the address bar carries it. */
export const valueText = (v: OptionValue): string => String(v);

// --- the description the values are bound into ----------------------------------

const unescape = (t: string) => t.replace(/~1/g, '/').replace(/~0/g, '~');

/** Writes one value at a JSON pointer, in place. Only an existing single value is replaced; anything else is left alone. */
function setPointer(root: unknown, path: string, value: unknown): void {
  if (!path.startsWith('/')) return;
  const tokens = path.slice(1).split('/').map(unescape);
  let cur: unknown = root;
  for (let i = 0; i < tokens.length - 1; i++) {
    if (typeof cur !== 'object' || cur === null) return;
    cur = (cur as Record<string, unknown>)[tokens[i]!];
  }
  const key = tokens[tokens.length - 1]!;
  if (typeof cur !== 'object' || cur === null || !(key in cur)) return;
  const at = (cur as Record<string, unknown>)[key];
  if (at !== null && typeof at === 'object') return;
  (cur as Record<string, unknown>)[key] = value;
}

/** The value a binding stores (the api's storedValue). */
const stored = (value: OptionValue, scale: number | undefined): OptionValue =>
  scale !== undefined && typeof value === 'number' ? Number((value * scale).toPrecision(12)) : value;

/** The draft with these values set: each param's value and every binding of it in the description. A copy; values that do not fit are skipped. */
export function withValues(d: DraftData, values: Values): DraftData {
  const out = structuredClone(d);
  for (const p of out.params) {
    const raw = values[p.id];
    if (raw === undefined) continue;
    const v = coerceValue(p, raw);
    if (v === null) continue;
    p.value = v as never;
    for (const b of out.bindings) if (b.param === p.id) setPointer(out.spec, b.path, stored(v, b.scale));
  }
  return out;
}

/** The values of `d` that differ from the ready draft `base`, as raw strings (what a link carries). */
export function changedValues(d: DraftData, base: DraftData): Values {
  const out: Values = {};
  for (const p of d.params) {
    const was = base.params.find((x) => x.id === p.id);
    if (!was || was.value !== p.value) out[p.id] = valueText(p.value);
  }
  return out;
}

/** `p.<id>=<value>` pairs, in param order. */
export const valueEntries = (values: Values): [string, string][] => Object.entries(values).map(([k, v]) => [`${VALUE_PREFIX}${k}`, v]);
