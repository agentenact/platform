/**
 * Which moment an agent page is in, from the overview alone. Waiting and failed mean "the first check has not landed"; first
 * is that check, landed; today is a normal day with counts; plain is everything else (paused, stopped, no checks today).
 */
import type { Overview } from './agent-types';

export type Moment = 'waiting' | 'failed' | 'first' | 'today' | 'plain';

/** The page talks about "checking now" only this long; a check that has not landed by then is not a first-minute story. */
export const WAIT_MAX_MS = 10 * 60_000;
const DAY = 86_400_000;

export function momentOf(o: Overview, now: number): Moment {
  if (o.status === 'watching' && o.watchesCondition && o.checksTotal === 0) {
    const age = o.watchingSince ? now - Date.parse(o.watchingSince) : Infinity;
    if (age <= WAIT_MAX_MS) return o.latestCheck?.held === null ? 'failed' : o.latestCheck ? 'first' : 'waiting';
    return 'plain';
  }
  if (o.checksTotal === 1 && o.latestCheck && o.latestCheck.held !== null) return 'first';
  if (o.checksTotal >= 2 && o.checksToday > 0) return 'today';
  return 'plain';
}

/** Seconds between page re-reads: quick only while the first check is awaited. */
export const refreshSeconds = (m: Moment): number => (m === 'waiting' || m === 'failed' ? 5 : 30);

/** Seconds between page re-reads while the agent is getting ready: the reserve worker looks every two minutes. */
export const GETTING_READY_REFRESH_S = 10;

/** Whole days since `since`; null when the api did not say. */
export function daysWatching(since: string | null, now: number): number | null {
  if (!since) return null;
  const t = Date.parse(since);
  return Number.isFinite(t) ? Math.max(0, Math.floor((now - t) / DAY)) : null;
}

/** Seconds between re-reads after a failed first load: the page retries on its own, gently on a slow api. */
export const ERROR_RETRY_SECONDS = 10;
