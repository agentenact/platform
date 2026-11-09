/** How long the "ready" moment shows before the agent page opens on its own. */
export const ARRIVAL_MS = 1500;

/** Runs `go` once after ARRIVAL_MS; the returned function cancels it (the visitor left, or already pressed Open). Timers are injectable for tests. */
export function scheduleArrival(
  go: () => void,
  setTimer: (fn: () => void, ms: number) => unknown = setTimeout,
  clearTimer: (id: unknown) => void = (id) => clearTimeout(id as ReturnType<typeof setTimeout>),
): () => void {
  const id = setTimer(go, ARRIVAL_MS);
  return () => clearTimer(id);
}
