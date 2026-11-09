/**
 * The small grid under a trial's verdict (mockup D): what the check read, in two or three cells. The numbers come from the
 * api's reading (apps/api/src/checks/readings.ts); only their look is decided here. A limit comes from the draft's own
 * parameter, never from the reading.
 */
import { copy } from '@/copy';
import { paramDisplay, plainText, withUnit } from './draft-display';
import type { DraftData } from './draft-types';

const L = copy.draft.trial.readings;
export interface Cell {
  label: string;
  value: string;
}

const isNum = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);

/** "−0.42%" with a true minus, "+0.42%" going up. */
export function pctText(n: number): string {
  const s = Math.abs(n).toFixed(2);
  return `${n < 0 && Number(s) !== 0 ? '−' : n > 0 ? '+' : ''}${s}%`;
}

/** "$0.1913", "$67,432.10". */
export function usdText(n: number): string {
  const digits = n >= 1 ? 2 : n >= 0.01 ? 4 : 6;
  return `$${n.toLocaleString('en-US', { minimumFractionDigits: digits, maximumFractionDigits: digits })}`;
}

/** The one number the owner set for the check ("5%"), or null when no single number parameter is bound to the condition. */
export function limitText(draft: DraftData | null | undefined, kind: 'pct' | 'usd'): string | null {
  if (!draft) return null;
  const bound = draft.bindings.filter((b) => /^\/triggers\/\d+\/params\//.test(b.path)).map((b) => draft.params.find((p) => p.id === b.param));
  const numbers = bound.filter((p): p is NonNullable<typeof p> & { kind: 'number' } => p?.kind === 'number');
  if (numbers.length !== 1) return null;
  const p = numbers[0]!;
  // Only a number of the reading's own kind is its limit; a window or a minimum amount is not.
  if (kind === 'pct') return p.unit === '%' ? plainText(withUnit(paramDisplay(p), p.unit)) : null;
  return p.unit && /^(\$|usd|dollars?)$/i.test(p.unit) ? plainText(`$${paramDisplay(p)}`) : null;
}

/** The cells for a reading, in order; empty when there is nothing safe and sensible to show (also for an out-of-date price). */
export function readingCells(reading: Record<string, number | string> | null | undefined, draft: DraftData | null | undefined): Cell[] {
  if (!reading || reading.stale !== undefined) return [];
  const cells: Cell[] = [];
  const limitOf = (kind: 'pct' | 'usd') => {
    const t = limitText(draft, kind);
    return t ? [{ label: L.limit, value: t }] : [];
  };
  if (isNum(reading.changePct)) {
    cells.push({ label: L.change, value: pctText(reading.changePct) }, ...limitOf('pct'));
    if (isNum(reading.to)) cells.push({ label: L.priceNow, value: usdText(reading.to) });
  } else if (isNum(reading.price)) {
    cells.push({ label: L.priceNow, value: usdText(reading.price) }, ...limitOf('usd'));
  } else if (isNum(reading.count)) {
    cells.push({ label: L.payments, value: String(reading.count) });
    const largest = typeof reading.largest === 'string' ? plainText(reading.largest) : null;
    if (largest) cells.push({ label: L.largest, value: largest });
  }
  return cells;
}

/**
 * One plain sentence for a reading ("XLM moved −0.40%. Your limit is 5%."), or null when there is nothing safe to say (no
 * reading, an out-of-date price, a symbol the plain-words filter hides). The limit is the owner's own, from the draft.
 */
export function readingLine(reading: Record<string, number | string> | null | undefined, draft: DraftData | null | undefined): string | null {
  if (!reading || reading.stale !== undefined) return null;
  const symbol = typeof reading.symbol === 'string' ? plainText(reading.symbol) : null;
  const limit = (kind: 'pct' | 'usd') => {
    const t = limitText(draft, kind);
    return t ? ` ${copy.firstCheck.yourLimit(t)}` : '';
  };
  if (symbol && isNum(reading.changePct)) return `${copy.firstCheck.moved(symbol, pctText(reading.changePct))}${limit('pct')}`;
  if (symbol && isNum(reading.price)) return `${copy.firstCheck.at(symbol, usdText(reading.price))}${limit('usd')}`;
  if (isNum(reading.count)) return copy.firstCheck.payments(reading.count);
  return null;
}
