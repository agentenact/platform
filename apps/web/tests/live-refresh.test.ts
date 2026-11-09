import { describe, expect, test } from 'bun:test';
import { startLiveRefresh } from '@/lib/live-refresh';

/** A fake clock and page visibility: ticks run only when the test says so. */
function rig(visible = true) {
  let tick: (() => void) | null = null;
  let onVis: (() => void) | null = null;
  const state = { visible, refreshes: 0, cleared: false, unlistened: false };
  const stop = startLiveRefresh({
    intervalMs: 30_000,
    refresh: () => void state.refreshes++,
    isVisible: () => state.visible,
    every: (_ms, fn) => ((tick = fn), () => void (state.cleared = true)),
    onVisibilityChange: (fn) => ((onVis = fn), () => void (state.unlistened = true)),
  });
  return { state, stop, tick: () => tick?.(), show: (v: boolean) => ((state.visible = v), onVis?.()) };
}

describe('live refresh', () => {
  test('refreshes on every tick while the page is visible', () => {
    const r = rig();
    r.tick();
    r.tick();
    expect(r.state.refreshes).toBe(2);
  });

  test('skips ticks while the tab is hidden, then refreshes once on return', () => {
    const r = rig(false);
    r.tick();
    r.tick();
    expect(r.state.refreshes).toBe(0);
    r.show(true);
    expect(r.state.refreshes).toBe(1);
    r.show(false);
    expect(r.state.refreshes).toBe(1);
  });

  test('stop clears the timer and the listener', () => {
    const r = rig();
    r.stop();
    expect(r.state).toMatchObject({ cleared: true, unlistened: true });
  });
});
