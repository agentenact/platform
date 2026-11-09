/**
 * The draft format (Builder, spec §5): an AgentSpec plus a plain-words view of it. The view is a sentence with
 * editable parameters, each bound to the places in the spec that carry its value, so an edit never needs the model.
 */
import { z } from 'zod';
import { AgentSpec } from '../specs/schema.js';
import { bannedWord } from './words.js';

const PARAM_ID = /^[a-z][a-z0-9_]{0,23}$/;
const label = z.string().min(1).max(40);
const id = z.string().regex(PARAM_ID);
const optionValue = z.union([z.string(), z.number(), z.boolean()]);

export const ParamSpec = z.discriminatedUnion('kind', [
  z.object({ id, label, kind: z.literal('number'), value: z.number().finite(), min: z.number().finite(), max: z.number().finite(), unit: z.string().min(1).max(16).optional() }).strict(),
  z
    .object({ id, label, kind: z.literal('choice'), options: z.array(z.object({ label, value: optionValue }).strict()).min(2).max(8), value: optionValue })
    .strict(),
  z.object({ id, label, kind: z.literal('text'), value: z.string().max(100) }).strict(),
  // A time of day (and, for a weekly schedule, a weekday): the value is the schedule itself, `M H * * D`. Presets are
  // the quick picks ("morning"); any other minute and hour may be set too. The day kind (every day or one weekday) is fixed.
  z
    .object({ id, label, kind: z.literal('time'), presets: z.array(z.object({ label, value: z.string().max(20) }).strict()).max(4), value: z.string().max(20) })
    .strict(),
]);
export type ParamSpec = z.infer<typeof ParamSpec>;

export const Binding = z.object({ param: id, path: z.string().max(200), scale: z.number().positive().finite().optional() }).strict();
export type Binding = z.infer<typeof Binding>;

export const Segment = z.union([z.string().max(200), z.object({ param: id }).strict()]);
export type Segment = z.infer<typeof Segment>;

export const DraftView = z.object({ sentence: z.array(Segment).min(1).max(40), params: z.array(ParamSpec).max(6), bindings: z.array(Binding).max(12) }).strict();
export type DraftView = z.infer<typeof DraftView>;

export const DraftResult = DraftView.extend({ name: z.string().min(1).max(64), spec: AgentSpec }).strict();
export type DraftResult = z.infer<typeof DraftResult>;

/** Resolves an RFC 6901 pointer: its tokens, or null when malformed. */
export function pointerTokens(path: string): string[] | null {
  if (path === '') return [];
  if (!path.startsWith('/')) return null;
  const tokens = path.slice(1).split('/');
  const out: string[] = [];
  for (const t of tokens) {
    if (/~(?![01])/.test(t)) return null;
    out.push(t.replaceAll('~1', '/').replaceAll('~0', '~'));
  }
  return out;
}

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const INDEX = /^(0|[1-9][0-9]*)$/;

/** The container and key a pointer names inside `root`, or null when any step does not exist. `-` and out-of-range indexes do not resolve. */
export function resolvePointer(root: unknown, path: string): { parent: Record<string, unknown> | unknown[]; key: string } | null {
  const tokens = pointerTokens(path);
  if (tokens === null || tokens.length === 0) return null;
  let cur: unknown = root;
  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i]!;
    let next: unknown;
    if (Array.isArray(cur)) {
      if (!INDEX.test(t) || Number(t) >= cur.length) return null;
      next = cur[Number(t)];
    } else if (isObj(cur)) {
      if (!Object.hasOwn(cur, t)) return null;
      next = cur[t];
    } else return null;
    if (i === tokens.length - 1) return { parent: cur as Record<string, unknown> | unknown[], key: t };
    cur = next;
  }
  return null;
}

export function readPointer(root: unknown, path: string): { found: true; value: unknown } | { found: false } {
  const r = resolvePointer(root, path);
  if (!r) return { found: false };
  return { found: true, value: Array.isArray(r.parent) ? r.parent[Number(r.key)] : (r.parent as Record<string, unknown>)[r.key] };
}

const num = (a: unknown, b: unknown) => typeof a === 'number' && typeof b === 'number' && Math.abs(a - b) <= 1e-9 * Math.max(1, Math.abs(a), Math.abs(b));
/** Equal values; numbers compare with a tiny tolerance for scaled floats. */
export const sameValue = (a: unknown, b: unknown) => a === b || num(a, b);

/** The value a binding stores for a parameter value. */
export function storedValue(value: unknown, scale: number | undefined): unknown {
  return scale !== undefined && typeof value === 'number' ? Number((value * scale).toPrecision(12)) : value;
}

/** A schedule a time parameter may hold: minute, hour, every day (`*`) or one weekday (0 = Sunday … 6). */
const TIME_CRON = /^([0-5]?\d) ([01]?\d|2[0-3]) \* \* (\*|[0-6])$/;
const WEEKDAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'] as const;

/** The minute, hour and weekday (null: every day) of a time parameter's value, or null when it is not one. */
export function parseTime(value: string): { minute: number; hour: number; weekday: number | null } | null {
  const m = TIME_CRON.exec(value);
  if (!m) return null;
  return { minute: Number(m[1]), hour: Number(m[2]), weekday: m[3] === '*' ? null : Number(m[3]) };
}

/** "08:00": a time parameter's clock, 24-hour. */
export function clockText(t: { minute: number; hour: number }): string {
  return `${String(t.hour).padStart(2, '0')}:${String(t.minute).padStart(2, '0')}`;
}

/** How a time reads: a preset as "morning at 08:00", any other as "day at 07:30" or "Monday at 07:30". */
function timeDisplay(p: { presets: { label: string; value: string }[]; value: string }): string {
  const t = parseTime(p.value);
  if (!t) return p.value;
  const preset = p.presets.find((o) => o.value === p.value);
  return `${preset ? preset.label : t.weekday === null ? 'day' : WEEKDAYS[t.weekday]} at ${clockText(t)}`;
}

const ADDRESS = /^(?:[A-Za-z0-9]{1,12}:)?G[A-Z2-7]{55}$/;
/** An EVM, Solana or Bitcoin wallet: shown shortened the same way (0x keeps 6). */
const OTHER_ADDRESS = /^(0x[0-9a-fA-F]{40}|[1-9A-HJ-NP-Za-km-z]{32,44}|(bc1|tb1)[02-9ac-hj-np-z]{11,87})$/;
/** How a parameter value reads in the sentence: a Stellar account address shows as first 4 + last 4; the full value stays in the param and the spec. */
export function paramDisplay(p: ParamSpec): string {
  if (p.kind === 'choice') return p.options.find((o) => o.value === p.value)?.label ?? String(p.value);
  if (p.kind === 'time') return timeDisplay(p);
  if (p.kind === 'text' && ADDRESS.test(p.value)) return `${p.value.slice(0, p.value.indexOf('G', p.value.indexOf(':') + 1) + 4)}\u2026${p.value.slice(-4)}`;
  if (p.kind === 'text' && OTHER_ADDRESS.test(p.value)) return `${p.value.slice(0, p.value.startsWith('0x') ? 6 : 4)}\u2026${p.value.slice(-4)}`;
  return String(p.value);
}

/** The sentence as the owner reads it, with every parameter shown through paramDisplay. */
export function renderSentence(d: Pick<DraftView, 'sentence' | 'params'>): string {
  return d.sentence.map((s) => (typeof s === 'string' ? s : paramDisplay(d.params.find((p) => p.id === s.param)!))).join('');
}

/**
 * Paths a parameter may bind to: plain data fields, never code, prompts, skills or services.
 * Cadence, cooldown, condition fetch arguments (accounts, thresholds, assets), condition `params` (the values the
 * condition code reads as `params.NAME`), cron schedule, email delivery. A tap changes data; it never edits code.
 */
export const BINDABLE_PATHS: readonly RegExp[] = [
  /^\/triggers\/\d+\/(?:cron|every_s|cooldown_s)$/,
  /^\/triggers\/\d+\/fetch\/args\/[^/]+$/,
  /^\/triggers\/\d+\/params\/[a-z][a-z0-9_]{0,23}$/,
  /^\/delivery\/email$/,
];

const CRON_PATH = /^\/triggers\/\d+\/cron$/;
const PARAMS_PATH = /^\/triggers\/(\d+)\/params\/([a-z][a-z0-9_]{0,23})$/;

/**
 * "The knob does nothing" lint: a binding to `/triggers/N/params/NAME` needs trigger N's code to mention `params.NAME`.
 * A plain word-boundary search, deliberately not a parser. If it is fooled (a mention in a comment or a string, a
 * shadowed `params`), the worst case is a knob that changes nothing. It can never make a tap edit the wrong thing,
 * because a tap only ever writes data into `params`; the code string is never touched.
 */
function unreadParam(spec: DraftResult['spec'], path: string): string | null {
  const m = PARAMS_PATH.exec(path);
  if (!m) return null;
  const t = spec.triggers[Number(m[1])];
  if (!t || t.kind !== 'condition') return `${path} needs a condition trigger`;
  return new RegExp(`\\bparams\\.${m[2]}\\b`).test(t.code) ? null : `the code never reads params.${m[2]}`;
}

/** The first problem in a draft, or null. */
export function checkDraft(input: DraftResult): string | null {
  const parsed = DraftResult.safeParse(input);
  if (!parsed.success) return `${parsed.error.issues[0]!.path.join('.')}: ${parsed.error.issues[0]!.message}`;
  const d = parsed.data;
  const ids = new Set<string>();
  for (const p of d.params) {
    if (ids.has(p.id)) return `parameter ${p.id} is listed twice`;
    ids.add(p.id);
  }
  for (const s of d.sentence) {
    if (typeof s === 'string') continue;
    if (!ids.has(s.param)) return `the sentence names an unknown parameter ${s.param}`;
  }
  for (const b of d.bindings) if (!ids.has(b.param)) return `a binding names an unknown parameter ${b.param}`;
  for (const p of d.params) if (!d.bindings.some((b) => b.param === p.id)) return `parameter ${p.id} has no binding`;

  for (const p of d.params) {
    if (p.kind === 'number') {
      if (p.min > p.max) return `${p.id}: min is above max`;
      if (p.value < p.min || p.value > p.max) return `${p.id}: ${p.value} is outside ${p.min}..${p.max}`;
    } else if (p.kind === 'choice') {
      if (new Set(p.options.map((o) => o.value)).size !== p.options.length) return `${p.id}: two options share a value`;
      if (!p.options.some((o) => o.value === p.value)) return `${p.id}: the value is not one of the options`;
    } else if (p.kind === 'time') {
      const t = parseTime(p.value);
      if (!t) return `${p.id}: the value is not a time`;
      for (const o of p.presets) {
        const at = parseTime(o.value);
        if (!at) return `${p.id}: the preset ${o.label} is not a time`;
        if ((at.weekday === null) !== (t.weekday === null)) return `${p.id}: the preset ${o.label} mixes every day and one weekday`;
      }
      if (new Set(p.presets.map((o) => o.value)).size !== p.presets.length) return `${p.id}: two presets share a value`;
      if (!d.bindings.filter((b) => b.param === p.id).every((b) => CRON_PATH.test(b.path))) return `${p.id}: a time binds only to a schedule`;
    }
  }

  for (const b of d.bindings) {
    const p = d.params.find((x) => x.id === b.param)!;
    if (b.scale !== undefined && p.kind !== 'number') return `${p.id}: scale needs a number parameter`;
    const expected = storedValue(p.value, b.scale);
    const at = readPointer(d.spec, b.path);
    if (!at.found) return `${p.id}: ${b.path} does not exist in the description`;
    if (!BINDABLE_PATHS.some((re) => re.test(b.path))) return `${p.id}: ${b.path} cannot be edited`;
    if (at.value === null || typeof at.value === 'object') return `${p.id}: ${b.path} is not a single value`;
    if (!sameValue(at.value, expected)) return `${p.id}: ${b.path} differs from the value`;
    const dead = unreadParam(d.spec, b.path);
    if (dead) return `${p.id}: ${dead}`;
  }

  // Every key of a condition's `params` must be a knob: bound by some parameter. An unbound key is a constant that
  // belongs in the code, not in `params`, and would let the sentence and the stored values drift apart.
  for (let i = 0; i < d.spec.triggers.length; i++) {
    const t = d.spec.triggers[i]!;
    if (t.kind !== 'condition' || !t.params) continue;
    for (const key of Object.keys(t.params)) if (!d.bindings.some((b) => b.path === `/triggers/${i}/params/${key}`)) return `params.${key} of trigger ${i} is not bound to any parameter`;
  }

  const texts: string[] = [d.name, ...d.sentence.filter((s): s is string => typeof s === 'string')];
  for (const p of d.params) {
    texts.push(p.label);
    if (p.kind === 'number' && p.unit) texts.push(p.unit);
    if (p.kind === 'choice') for (const o of p.options) texts.push(o.label);
    if (p.kind === 'time') for (const o of p.presets) texts.push(o.label);
  }
  for (const t of texts) {
    const w = bannedWord(t);
    if (w !== null) return `"${t}" contains the technical word "${w}"`;
  }
  return null;
}
