import { PUBLIC } from './public-config';

/**
 * `next` if it is a path on this origin, otherwise `fallback`. Rejects anything a browser could read as another host:
 * a second leading slash, backslashes (browsers treat them as slashes), control characters (browsers strip tabs and
 * newlines), schemes, and any of those hidden behind percent-encoding (checked after repeated decoding).
 */
export function safeNext(next: string | null | undefined, fallback = '/'): string {
  if (!next || !next.startsWith('/')) return fallback;
  let seen = next;
  for (let i = 0; i < 4; i++) {
    if (seen.startsWith('//') || /[\\\u0000-\u001f\u007f]/.test(seen) || /^\/*[a-z][a-z0-9+.-]*:/i.test(seen)) return fallback;
    let decoded: string;
    try {
      decoded = decodeURIComponent(seen);
    } catch {
      return fallback;
    }
    if (decoded === seen) break;
    seen = decoded;
  }
  try {
    if (new URL(next, PUBLIC.appOrigin).origin !== PUBLIC.appOrigin) return fallback;
  } catch {
    return fallback;
  }
  return next;
}
