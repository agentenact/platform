/**
 * Applies updates in order, at most one per `gapMs`, so a fast network still shows each step land instead of all of
 * them at once. `idle()` resolves once everything pushed so far is applied. A gap of 0 applies them as they come.
 */
export function createPacer(gapMs: number, now: () => number = Date.now) {
  let chain: Promise<void> = Promise.resolve();
  let last = -Infinity;
  return {
    push(apply: () => void): void {
      chain = chain.then(async () => {
        const wait = last + gapMs - now();
        if (wait > 0) await new Promise((r) => setTimeout(r, wait));
        apply();
        last = now();
      });
    },
    idle: (): Promise<void> => chain,
  };
}
