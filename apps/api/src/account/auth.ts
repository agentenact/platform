/**
 * Login is Supabase Auth in the browser (magic link via signInWithOtp). The API only verifies the
 * access token on each request, by asking GoTrue (`GET /auth/v1/user`): this honours sign-out and
 * works with either JWT signing mode, and the API holds no JWT secret.
 *
 * Failure policy (fail closed): only a definite 4xx answer (except 408/429) from GoTrue means
 * "not a session" (→ null). Everything else (network error, timeout, 5xx, 429, unparseable body)
 * throws, so a Supabase outage yields 503 and never lets a request through. supabase-js does not
 * retry `getUser(jwt)` (retries exist only on its refresh path) but its fetch has no timeout, so we
 * bound every call ourselves.
 *
 * A confirmed session is remembered for CACHE_TTL_MS (never past the token's own `exp`), keyed by the token's sha256: on a
 * CPU-starved node GoTrue's answer took over 5 s and every authed request paid it. The cost: a signed-out token keeps
 * working for at most that long. Refusals and failures are never cached.
 */
import { createHash } from 'node:crypto';
import { createClient } from '@supabase/supabase-js';

export interface AuthUser {
  id: string;
  email: string;
}

/** null = not a valid session (→ 401); throws = verifier unavailable (→ 503). */
export type AuthVerifier = (accessToken: string) => Promise<AuthUser | null>;

const UNAVAILABLE = 'auth: the token verifier is unavailable';
const DEFAULT_TIMEOUT_MS = 10_000;
export const CACHE_TTL_MS = 60_000;
const CACHE_MAX = 2000;

/** The token's `exp` in ms, read without verifying (GoTrue verified it); undefined when it cannot be read. */
function expiresAt(token: string): number | undefined {
  try {
    const exp = (JSON.parse(Buffer.from(token.split('.')[1] ?? '', 'base64url').toString('utf8')) as { exp?: unknown }).exp;
    return typeof exp === 'number' ? exp * 1000 : undefined;
  } catch {
    return undefined;
  }
}
/**
 * The thrown error's name says why, for the gateway's `auth_unavailable` log line (it logs the name only): AuthTimeout,
 * AuthNetwork (the call itself threw), or supabase-js's own error class and status for an answer that is not a session
 * answer (supabase-js turns a failed fetch into such an answer, so a network failure usually shows as AuthRetryableFetchError_0).
 */
const unavailable = (name: string): Error => Object.assign(new Error(UNAVAILABLE), { name });

/** Bound the WHOLE verification (headers and body): abort the request and reject at the timeout. */
async function bounded<T>(ms: number, run: (signal: AbortSignal) => Promise<T>): Promise<T> {
  const ctl = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      ctl.abort();
      reject(unavailable('AuthTimeout'));
    }, ms);
  });
  try {
    return await Promise.race([run(ctl.signal), timeout]);
  } finally {
    clearTimeout(timer);
  }
}

export function createSupabaseVerifier(o: { url: string; anonKey: string; fetch?: typeof fetch; timeoutMs?: number; cacheMs?: number; now?: () => number }): AuthVerifier {
  const verify = createGoTrueVerifier(o);
  const ttl = o.cacheMs ?? CACHE_TTL_MS;
  const now = o.now ?? Date.now;
  const cache = new Map<string, { user: AuthUser; until: number }>();
  return async (token) => {
    const key = createHash('sha256').update(token).digest('hex');
    const hit = cache.get(key);
    if (hit && hit.until > now()) return hit.user;
    if (hit) cache.delete(key);
    const user = await verify(token);
    if (user && ttl > 0) {
      const until = Math.min(now() + ttl, expiresAt(token) ?? now() + ttl);
      if (until > now()) {
        // Insertion order is age order: past the cap, the oldest entry goes.
        if (cache.size >= CACHE_MAX) cache.delete(cache.keys().next().value!);
        cache.set(key, { user, until });
      }
    }
    return user;
  };
}

function createGoTrueVerifier(o: { url: string; anonKey: string; fetch?: typeof fetch; timeoutMs?: number }): AuthVerifier {
  const base = o.fetch ?? fetch;
  const ms = o.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  // One client per call so the abort signal of this call is the one its fetch carries.
  const clientFor = (signal: AbortSignal) =>
    createClient(o.url, o.anonKey, {
      auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
      global: { fetch: ((input: RequestInfo | URL, init?: RequestInit) => base(input, { ...init, signal })) as typeof fetch },
    });
  return async (token) => {
    let res;
    try {
      res = await bounded(ms, (signal) => clientFor(signal).auth.getUser(token));
    } catch (e) {
      throw e instanceof Error && e.name === 'AuthTimeout' ? e : unavailable('AuthNetwork');
    }
    const { data, error } = res;
    if (error) {
      const s = error.status;
      // GoTrue always sends error_code on a real "bad session" answer. A 401 without one is the
      // gateway rejecting OUR apikey: a configuration outage, not the user's logout.
      const code = (error as { code?: unknown }).code;
      // supabase-js maps GoTrue's session_not_found to AuthSessionMissingError (status 400, no code).
      const isSessionAnswer = (typeof code === 'string' && code.length > 0) || error.name === 'AuthSessionMissingError';
      if (typeof s === 'number' && s >= 400 && s < 500 && s !== 408 && s !== 429 && isSessionAnswer) return null;
      // supabase-js's class plus the status (AuthRetryableFetchError_0 is the network, AuthApiError_502 the gateway).
      throw unavailable(`${error.name || 'AuthUpstream'}${typeof s === 'number' ? `_${s}` : ''}`);
    }
    const u = data.user as { id?: unknown; email?: unknown } | null;
    if (!u) return null;
    if (typeof u.id !== 'string' || !u.id || typeof u.email !== 'string' || !u.email) throw new Error(UNAVAILABLE);
    return { id: u.id, email: u.email };
  };
}

export function bearerToken(req: Request): string | null {
  const h = req.headers.get('authorization');
  const m = h ? /^Bearer\s+(\S+)$/i.exec(h) : null;
  return m && m[1]!.length <= 4096 ? m[1]! : null;
}
