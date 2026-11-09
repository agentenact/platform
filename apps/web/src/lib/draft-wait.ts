import { copy } from '@/copy';

/** After this long the wait line stops sounding quick. A draft can take up to 150 s, so a slow one must not look stuck. */
export const STILL_WRITING_MS = 10_000;

export function waitLine(elapsedMs: number): string {
  return elapsedMs >= STILL_WRITING_MS ? copy.draft.stillWriting : copy.draft.drafting;
}

export interface WaitClock {
  now: () => number;
  /** Calls fn on a steady beat; returns what stops it. */
  every: (fn: () => void) => () => void;
}

/** Reports milliseconds waited, now and on every beat. The clock is injected so tests need no real time. Returns stop. */
export function createWaitClock(clock: WaitClock, onElapsed: (ms: number) => void): () => void {
  const start = clock.now();
  const report = () => onElapsed(clock.now() - start);
  report();
  return clock.every(report);
}

export const realWaitClock: WaitClock = {
  now: () => Date.now(),
  every: (fn) => {
    const id = setInterval(fn, 1000);
    return () => clearInterval(id);
  },
};
