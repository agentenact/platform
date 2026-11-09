/**
 * The selling card as plain data: "Not now" memory (browser storage, optional) and what one tap on "Offer it" turns into.
 * The server's answer decides; nothing is shown as done ahead of it.
 */
import { copy } from '../copy';

export const HIDE_DAYS = 7;
const DAY_MS = 86_400_000;

type Store = Pick<Storage, 'getItem' | 'setItem'>;
export const hideKey = (agentId: string) => `agentenact.sell.notnow.${agentId}`;

/** True while a "Not now" from the last 7 days stands. Without storage (or with a broken value) the card simply shows. */
export function hiddenNow(store: Store | null, agentId: string, now: number): boolean {
  try {
    const until = Number(store?.getItem(hideKey(agentId)));
    return Number.isFinite(until) && until > now;
  } catch {
    return false;
  }
}

/** Remembers "Not now" for 7 days. Never throws: with no storage the card just comes back on the next visit. */
export function hideForAWeek(store: Store | null, agentId: string, now: number): void {
  try {
    store?.setItem(hideKey(agentId), String(now + HIDE_DAYS * DAY_MS));
  } catch {
    /* private window, blocked or full storage */
  }
}

/** The browser's storage, or null when it cannot even be reached. */
export function browserStorage(): Store | null {
  try {
    return typeof window === 'undefined' ? null : window.localStorage;
  } catch {
    return null;
  }
}

/** What the publish server action answers. `stale`: the description moved on since the card was drawn (409). */
export type OfferOut = { ok: true } | { ok: false; stale: true } | { ok: false; stale: false; message: string };
export type Offer = (version: number) => Promise<OfferOut>;

export type SellState =
  | { phase: 'card'; busy: boolean; message: string | null }
  | { phase: 'done' }
  | { phase: 'stale' }
  | { phase: 'hidden' };

export const initialSell: SellState = { phase: 'card', busy: false, message: null };

/** One tap on "Offer it": sends the version the card showed, once. Never throws. */
export async function runOffer(offer: Offer, version: number): Promise<SellState> {
  try {
    const r = await offer(version);
    if (r.ok) return { phase: 'done' };
    if (r.stale) return { phase: 'stale' };
    return { phase: 'card', busy: false, message: r.message };
  } catch {
    return { phase: 'card', busy: false, message: copy.errors.generic };
  }
}
