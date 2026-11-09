/** An answer function that settles its own question exactly once; every later call (double tap, key repeat, a stale button) is a no-op. */
export function onceAnswer<T>(settle: (a: T) => void): (a: T) => void {
  let used = false;
  return (a) => {
    if (used) return;
    used = true;
    settle(a);
  };
}
