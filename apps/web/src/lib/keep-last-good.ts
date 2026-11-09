/**
 * What a live-refreshing page shows after each server render. `ok` is whether the server could load the page this time;
 * `children` is the page it rendered (nothing when it could not). A failed refresh keeps the last good page, marked stale; only a
 * failure with nothing to keep (the first load) shows the error.
 */
export function nextShown<T>(good: T | null, ok: boolean, children: T | null): { shown: T | null; good: T | null; stale: boolean } {
  if (ok && children !== null) return { shown: children, good: children, stale: false };
  if (good !== null) return { shown: good, good, stale: true };
  return { shown: null, good: null, stale: false };
}
