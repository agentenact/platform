/**
 * Keeps a server-rendered page current: `refresh` runs every `intervalMs` while the tab is visible, never while it is
 * hidden, and once as soon as it becomes visible again. Timers and listeners are injected so the policy is testable.
 */
export interface LiveRefreshDeps {
  intervalMs: number;
  refresh: () => void;
  isVisible: () => boolean;
  every: (ms: number, fn: () => void) => () => void;
  onVisibilityChange: (fn: () => void) => () => void;
}

export function startLiveRefresh(d: LiveRefreshDeps): () => void {
  const stopTimer = d.every(d.intervalMs, () => {
    if (d.isVisible()) d.refresh();
  });
  const stopListening = d.onVisibilityChange(() => {
    if (d.isVisible()) d.refresh();
  });
  return () => {
    stopTimer();
    stopListening();
  };
}
