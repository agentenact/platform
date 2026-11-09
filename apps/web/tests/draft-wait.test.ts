import { describe, expect, test } from 'bun:test';
import { copy } from '../src/copy';
import { bannedWord } from '../src/lib/words';
import { STILL_WRITING_MS, createWaitClock, waitLine } from '../src/lib/draft-wait';

describe('waitLine', () => {
  test('starts with the plain line, never a flat promise', () => {
    expect(waitLine(0)).toBe(copy.draft.drafting);
    expect(waitLine(0)).not.toContain('This takes a few seconds');
  });
  test('stays the same until the threshold, then says it is still writing and how long it can take', () => {
    expect(waitLine(STILL_WRITING_MS - 1)).toBe(copy.draft.drafting);
    expect(waitLine(STILL_WRITING_MS)).toBe(copy.draft.stillWriting);
    expect(waitLine(120_000)).toBe(copy.draft.stillWriting);
    expect(copy.draft.stillWriting).toMatch(/still writing/i);
    expect(copy.draft.stillWriting).toMatch(/two minutes/i);
  });
  test('both lines pass the banned-words check', () => {
    expect(bannedWord(copy.draft.drafting)).toBeNull();
    expect(bannedWord(copy.draft.stillWriting)).toBeNull();
  });
});

describe('createWaitClock (injected clock)', () => {
  function fake() {
    let t = 1000;
    const ticks: (() => void)[] = [];
    let cleared = 0;
    return {
      now: () => t,
      advance: (ms: number) => {
        t += ms;
        for (const f of ticks) f();
      },
      every: (fn: () => void) => {
        ticks.push(fn);
        return () => void cleared++;
      },
      cleared: () => cleared,
    };
  }
  test('reports elapsed time from start and stops cleanly', () => {
    const f = fake();
    const seen: number[] = [];
    const stop = createWaitClock({ now: f.now, every: f.every }, (ms) => seen.push(ms));
    expect(seen).toEqual([0]);
    f.advance(4000);
    f.advance(7000);
    expect(seen).toEqual([0, 4000, 11000]);
    expect(waitLine(seen.at(-1)!)).toBe(copy.draft.stillWriting);
    stop();
    expect(f.cleared()).toBe(1);
  });
});
