/**
 * How a draft reads on screen. `paramDisplay` and `renderSentence` mirror apps/api/src/builder/draft-schema.ts;
 * tests/draft-screen.test.tsx runs both implementations on the same inputs, so a drift fails there.
 */
import { bannedWord } from './words';
import type { ParamSpec, Segment } from './draft-types';

/** A schedule a time parameter may hold: minute, hour, every day (`*`) or one weekday (0 = Sunday … 6). */
const TIME_CRON = /^([0-5]?\d) ([01]?\d|2[0-3]) \* \* (\*|[0-6])$/;
export const WEEKDAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'] as const;

/** The minute, hour and weekday (null: every day) of a time parameter's value, or null when it is not one. */
export function parseTime(value: string): { minute: number; hour: number; weekday: number | null } | null {
  const m = TIME_CRON.exec(value);
  if (!m) return null;
  return { minute: Number(m[1]), hour: Number(m[2]), weekday: m[3] === '*' ? null : Number(m[3]) };
}

/** The schedule for a minute, hour and weekday, in the one form the api writes. */
export const timeValue = (t: { minute: number; hour: number; weekday: number | null }): string => `${t.minute} ${t.hour} * * ${t.weekday ?? '*'}`;

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

/** A parameter's value as the owner reads it: an account address shows as first 4 + last 4; the full value stays in the draft. */
export function paramDisplay(p: ParamSpec): string {
  if (p.kind === 'choice') return p.options.find((o) => o.value === p.value)?.label ?? String(p.value);
  if (p.kind === 'time') return timeDisplay(p);
  if (p.kind === 'text' && ADDRESS.test(p.value)) return `${p.value.slice(0, p.value.indexOf('G', p.value.indexOf(':') + 1) + 4)}…${p.value.slice(-4)}`;
  if (p.kind === 'text' && OTHER_ADDRESS.test(p.value)) return `${p.value.slice(0, p.value.startsWith('0x') ? 6 : 4)}…${p.value.slice(-4)}`;
  return String(p.value);
}

export function renderSentence(d: { sentence: readonly Segment[]; params: readonly ParamSpec[] }): string {
  return d.sentence.map((s) => (typeof s === 'string' ? s : paramDisplay(d.params.find((p) => p.id === s.param)!))).join('');
}

/** The value with its unit: "%" hugs the number, a word gets a space. */
export function withUnit(display: string, unit: string | undefined): string {
  if (!unit) return display;
  return /^[A-Za-z]/.test(unit) ? `${display} ${unit}` : `${display}${unit}`;
}

/** Whether the sentence text right after a value already writes the unit ("% or more", " hours."). */
function writesUnit(unit: string, after: string): boolean {
  const rest = /^[A-Za-z]/.test(unit) ? after.trimStart() : after;
  return rest.toLowerCase().startsWith(unit.toLowerCase()) && !/^[A-Za-z]/.test(rest.charAt(unit.length));
}

/**
 * What a highlight shows: the display value and, for a number, its unit. `after` is the sentence text that follows the
 * highlight; when it already writes the unit (the api's renderSentence reads the sentence that way), the unit shows once.
 */
export function highlightText(p: ParamSpec, after = ''): string {
  if (p.kind !== 'number' || !p.unit || writesUnit(p.unit, after)) return paramDisplay(p);
  return withUnit(paramDisplay(p), p.unit);
}

/**
 * What a highlight shows and what is left of the sentence text after it. When the text already writes the unit, the unit moves
 * into the pill (as written there) and the rest starts after it, so the pill reads "5%" and the text carries on past it.
 * Rendering only: `highlightText` and the api's renderSentence parity are unchanged, and the joined text is identical.
 */
export function pillAndRest(p: ParamSpec, after = ''): { pill: string; rest: string } {
  if (p.kind !== 'number' || !p.unit || !writesUnit(p.unit, after)) return { pill: highlightText(p, after), rest: after };
  const word = /^[A-Za-z]/.test(p.unit);
  const text = word ? after.trimStart() : after;
  const written = text.slice(0, p.unit.length);
  return { pill: word ? `${paramDisplay(p)} ${written}` : `${paramDisplay(p)}${written}`, rest: text.slice(p.unit.length) };
}

/** The range as plain words: a symbol unit hugs both ends, a word unit comes once at the end. */
export function rangeText(p: { min: number; max: number; unit?: string | undefined }): string {
  const word = p.unit !== undefined && /^[A-Za-z]/.test(p.unit);
  const end = (n: number) => withUnit(String(n), p.unit);
  return `from ${word ? p.min : end(p.min)} to ${end(p.max)}`;
}

/** The number the stepper works from: what is typed, or the draft's own value when the box is blank or not a number (0 is a number). */
export function currentNumber(raw: string, p: { value: number }): number {
  const n = Number(raw);
  return raw.trim() === '' || !Number.isFinite(n) ? p.value : n;
}

/**
 * One press of minus (-1) or plus (+1). Whole steps when the range and value are whole numbers or the range is wide
 * (more than 10), else tenths. A value off the step grid snaps to the next grid point in the direction pressed; the
 * result stays inside min..max.
 */
export function stepNumber(current: number, dir: 1 | -1, p: { min: number; max: number; value: number }): number {
  const whole = (Number.isInteger(p.min) && Number.isInteger(p.max) && Number.isInteger(p.value)) || p.max - p.min > 10;
  const k = whole ? 1 : 10;
  const x = Math.round(current * k * 1e6) / 1e6; // grid units, float noise removed
  const onGrid = Number.isInteger(x);
  const next = (onGrid ? x + dir : dir > 0 ? Math.ceil(x) : Math.floor(x)) / k;
  return Math.min(p.max, Math.max(p.min, Math.round(next * 10) / 10));
}

/** What the stepper's box shows after one press. */
export function stepFrom(raw: string, dir: 1 | -1, p: { min: number; max: number; value: number }): string {
  return String(stepNumber(currentNumber(raw, p), dir, p));
}

/** A typed number if it parses and sits inside the parameter's bounds, else null. */
export function parseNumber(raw: string, p: { min: number; max: number }): number | null {
  if (raw.trim() === '') return null;
  const n = Number(raw);
  return Number.isFinite(n) && n >= p.min && n <= p.max ? n : null;
}

/** A typed text if the api would accept its length (1..100), else null. */
export function parseText(raw: string): string | null {
  const t = raw.trim();
  return t.length >= 1 && t.length <= 100 ? t : null;
}

const FULL_ADDRESS = /\b((?:[A-Za-z0-9]{1,12}:)?)([GC])[A-Z2-7]{51}([A-Z2-7]{4})\b/g;
/** Full 56-character account addresses shown as first 4 + last 4. */
export function shortenAddresses(text: string): string {
  return text.replace(FULL_ADDRESS, (m, prefix: string, _letter: string, tail: string) => `${prefix}${m.slice(prefix.length, prefix.length + 4)}\u2026${tail}`);
}

/**
 * Free text from the api (a trial's words) that is safe to show: addresses shortened, and null when a technical word is
 * still in it. The caller then shows a plain line in its place rather than the term.
 */
export function plainText(text: string): string | null {
  const short = shortenAddresses(text);
  return bannedWord(short) === null ? short : null;
}
