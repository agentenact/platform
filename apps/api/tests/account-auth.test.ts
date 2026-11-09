import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { bearerToken, createSupabaseVerifier } from '../src/account/auth.js';
import { ensureProfile, getProfile } from '../src/account/profiles.js';
import type { Db } from '../src/db/index.js';
import { freshDb } from './support/db.js';
import { contractAddress } from './support/fixtures.js';

const USER_ID = '6f1a0c52-3b8e-4c1d-9f2a-0e7d5b4a3c21';
/** GoTrue's /auth/v1/user body for a confirmed email user (self-hosted v2). */
const gotrueUser = {
  id: USER_ID,
  aud: 'authenticated',
  role: 'authenticated',
  email: 'kerem@example.com',
  email_confirmed_at: '2026-10-04T10:00:00.000000Z',
  phone: '',
  confirmed_at: '2026-10-04T10:00:00.000000Z',
  last_sign_in_at: '2026-10-04T10:00:01.000000Z',
  app_metadata: { provider: 'email', providers: ['email'] },
  user_metadata: { email: 'kerem@example.com', email_verified: true, phone_verified: false, sub: USER_ID },
  identities: [],
  created_at: '2026-10-04T10:00:00.000000Z',
  updated_at: '2026-10-04T10:00:01.000000Z',
  is_anonymous: false,
};

function fakeFetch(respond: (signal?: AbortSignal | null) => Response | Promise<Response>) {
  const seen: Request[] = [];
  const f = (async (input: RequestInfo | URL, init?: RequestInit) => {
    seen.push(new Request(input, init));
    return respond(init?.signal);
  }) as unknown as typeof fetch;
  return { f, seen };
}
const jsonRes = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
const make = (f: typeof fetch, timeoutMs?: number) =>
  createSupabaseVerifier({ url: 'https://supabase.test', anonKey: 'anon-key', fetch: f, ...(timeoutMs ? { timeoutMs } : {}) });
const UNAVAILABLE = 'auth: the token verifier is unavailable';

describe('createSupabaseVerifier', () => {
  const jwt = (exp: number) => `h.${Buffer.from(JSON.stringify({ exp })).toString('base64url')}.s`;

  it('a confirmed session is remembered for the cache window, never past the token exp; refusals are not cached', async () => {
    let t = 1_000_000_000_000;
    let calls = 0;
    const ok = (async () => (calls++, jsonRes(200, gotrueUser))) as unknown as typeof fetch;
    const v = createSupabaseVerifier({ url: 'https://supabase.test', anonKey: 'anon-key', fetch: ok, now: () => t, cacheMs: 60_000 });
    const long = jwt(t / 1000 + 3600);
    expect(await v(long)).toEqual({ id: USER_ID, email: 'kerem@example.com' });
    t += 59_000;
    expect(await v(long)).toEqual({ id: USER_ID, email: 'kerem@example.com' });
    expect(calls).toBe(1);
    t += 2_000;
    await v(long);
    expect(calls).toBe(2);
    // A token that expires in 10 s is remembered for 10 s only.
    const short = jwt(t / 1000 + 10);
    await v(short);
    t += 11_000;
    await v(short);
    expect(calls).toBe(4);

    let refusals = 0;
    const no = (async () => (refusals++, jsonRes(403, { code: 403, error_code: 'bad_jwt', msg: 'expired' }))) as unknown as typeof fetch;
    const w = createSupabaseVerifier({ url: 'https://supabase.test', anonKey: 'anon-key', fetch: no, now: () => t });
    expect(await w(long)).toBeNull();
    expect(await w(long)).toBeNull();
    expect(refusals).toBe(2);
  });

  it('a valid access token resolves to the Supabase user; the call is GET /auth/v1/user with the token', async () => {
    const { f, seen } = fakeFetch(() => jsonRes(200, gotrueUser));
    const verify = make(f);
    expect(await verify('access-token-1')).toEqual({ id: USER_ID, email: 'kerem@example.com' });
    const req = seen.at(-1)!;
    expect(new URL(req.url).pathname).toBe('/auth/v1/user');
    expect(req.headers.get('authorization')).toBe('Bearer access-token-1');
    expect(req.headers.get('apikey')).toBe('anon-key');
  });

  it('an expired or forged token is not a user (→ 401)', async () => {
    const { f } = fakeFetch(() =>
      jsonRes(403, { code: 403, error_code: 'bad_jwt', msg: 'invalid JWT: unable to parse or verify signature, token has invalid claims: token is expired' }),
    );
    expect(await make(f)('expired')).toBeNull();
  });

  it('a signed-out session (session_not_found, 403) is not a user', async () => {
    const { f } = fakeFetch(() => jsonRes(403, { code: 403, error_code: 'session_not_found', msg: 'Session from session_id claim in JWT does not exist' }));
    expect(await make(f)('t')).toBeNull();
  });

  it('an unreachable Auth server throws (→ 503), never silently passes', async () => {
    const { f } = fakeFetch(() => {
      throw new TypeError('fetch failed');
    });
    await expect(make(f)('t')).rejects.toThrow(UNAVAILABLE);
    await expect(make(f)('t')).rejects.toMatchObject({ name: expect.stringMatching(/^AuthRetryableFetchError_\d+$/) });
  });

  it('an Auth server error (5xx, HTML or JSON) throws, it is not a 401', async () => {
    for (const res of [
      () => new Response('<html>bad gateway</html>', { status: 502, headers: { 'content-type': 'text/html' } }),
      () => jsonRes(500, { code: 500, error_code: 'unexpected_failure', msg: 'Database error' }),
      () => jsonRes(503, { code: 503, msg: 'overloaded' }),
    ]) {
      await expect(make(fakeFetch(res).f)('t')).rejects.toThrow(UNAVAILABLE);
    }
    await expect(make(fakeFetch(() => jsonRes(503, { code: 503, msg: 'overloaded' })).f)('t')).rejects.toMatchObject({ name: expect.stringMatching(/_503$/) });
  });

  it('rate limiting (429) is an outage of the verifier, not an invalid token', async () => {
    const { f } = fakeFetch(() => jsonRes(429, { code: 429, error_code: 'over_request_rate_limit', msg: 'Request rate limit reached' }));
    await expect(make(f)('t')).rejects.toThrow(UNAVAILABLE);
  });

  it('a hung Auth server is cut off at the timeout and throws (fail closed, no retry)', async () => {
    const { f, seen } = fakeFetch((signal) => new Promise<Response>((_, reject) => signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')))));
    const t0 = Date.now();
    await expect(make(f, 50)('t')).rejects.toMatchObject({ name: 'AuthTimeout', message: UNAVAILABLE });
    expect(Date.now() - t0).toBeLessThan(1000);
    expect(seen.length).toBe(1);
  });

  it('a hung fetch that ignores the abort signal is still cut off', async () => {
    const { f } = fakeFetch(() => new Promise<Response>(() => {}));
    await expect(make(f, 50)('t')).rejects.toThrow(UNAVAILABLE);
  });

  it('a 200 without a string id or email is an unavailable verifier, never a user', async () => {
    const { id: _id, ...noId } = gotrueUser;
    const { email: _e, ...noEmail } = gotrueUser;
    for (const body of [noId, { ...gotrueUser, id: 42 }, { ...gotrueUser, id: '' }, noEmail, { ...gotrueUser, email: 7 }]) {
      await expect(make(fakeFetch(() => jsonRes(200, body)).f)('t')).rejects.toThrow(UNAVAILABLE);
    }
  });

  it('headers arrive but the body stalls: the whole call still fails within the bound', async () => {
    const stalled = () =>
      new Response(new ReadableStream({ start() {} }), { status: 200, headers: { 'content-type': 'application/json' } });
    const t0 = Date.now();
    await expect(make(fakeFetch(stalled).f, 50)('t')).rejects.toThrow(UNAVAILABLE);
    expect(Date.now() - t0).toBeLessThan(1000);
  });

  it('a wrong API key (401 without error_code) is unavailable, not a logout', async () => {
    for (const body of [{ message: 'Invalid API key' }, { message: 'No API key found in request' }]) {
      await expect(make(fakeFetch(() => jsonRes(401, body)).f)('t')).rejects.toThrow(UNAVAILABLE);
    }
  });

  it('a 401/403 carrying a GoTrue error_code is still not a user', async () => {
    for (const status of [401, 403]) {
      const { f } = fakeFetch(() => jsonRes(status, { code: status, error_code: 'bad_jwt', msg: 'invalid JWT' }));
      expect(await make(f)('t')).toBeNull();
    }
  });

  it('bearerToken reads only a Bearer authorization header', () => {
    const r = (h?: string) => new Request('https://api.test/', h ? { headers: { authorization: h } } : {});
    expect(bearerToken(r('Bearer abc.def'))).toBe('abc.def');
    expect(bearerToken(r('bearer abc'))).toBe('abc');
    expect(bearerToken(r('Basic abc'))).toBeNull();
    expect(bearerToken(r())).toBeNull();
    expect(bearerToken(r(`Bearer ${'a'.repeat(4096)}`))).toBe('a'.repeat(4096));
    expect(bearerToken(r(`Bearer ${'a'.repeat(4097)}`))).toBeNull();
  });
});

describe('profiles', () => {
  let sql: Db;
  let drop: () => Promise<void>;
  beforeAll(async () => ({ sql, drop } = await freshDb()));
  afterAll(() => drop());

  it('ensureProfile creates the row on first sight and follows an email change', async () => {
    const p1 = await ensureProfile(sql, { id: USER_ID, email: 'kerem@example.com' });
    expect(p1).toEqual({ id: USER_ID, email: 'kerem@example.com', ownerAddress: null, credentialId: null, credential: null });
    const p2 = await ensureProfile(sql, { id: USER_ID, email: 'k@example.com' });
    expect(p2.email).toBe('k@example.com');
    expect(await getProfile(sql, crypto.randomUUID())).toBeNull();
  });

  it('getProfile returns the wallet fields', async () => {
    const id = crypto.randomUUID();
    await ensureProfile(sql, { id, email: 'w@example.com' });
    const credential = { credentialId: 'c1', publicKey: 'BAQE', contractId: contractAddress(7), createdAt: 1, isPrimary: true };
    // jsonb: pass the plain object (JSON.stringify would store a jsonb string).
    await sql`update app.users set owner_address = ${contractAddress(7)}, passkey_credential_id = 'c1',
              passkey_credential = ${credential} where id = ${id}`;
    expect(await getProfile(sql, id)).toEqual({ id, email: 'w@example.com', ownerAddress: contractAddress(7), credentialId: 'c1', credential });
  });
});
