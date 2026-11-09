import { describe, expect, test } from 'bun:test';
import { confirmSignIn, createAuthConfirmRoute, safeNext, type ConfirmDeps } from '../src/server/auth-confirm';
import { copy } from '../src/copy';
import { bannedWord } from '../src/lib/words';
import { textOf } from './support/screens';

const ORIGIN = 'https://agentenact.io';
const ok: ConfirmDeps = { verifyOtp: async () => ({ error: null }) };
const bad: ConfirmDeps = { verifyOtp: async () => ({ error: new Error('expired') }) };
const url = (q: string) => new URL(`${ORIGIN}/auth/confirm?${q}`);
const where = (r: Response) => r.headers.get('location');

describe('confirmSignIn', () => {
  test('a valid token redirects to a same-origin next', async () => {
    const calls: unknown[] = [];
    const r = await confirmSignIn(url(`token_hash=abc&type=email&next=${encodeURIComponent('/draft?h=AbC_dEf-123456789012')}`), {
      verifyOtp: async (a) => (calls.push(a), { error: null }),
    });
    expect(calls).toEqual([{ token_hash: 'abc', type: 'email' }]);
    expect(where(r)).toBe(`${ORIGIN}/draft?h=AbC_dEf-123456789012`);
    expect(r.headers.get('referrer-policy')).toBe('no-referrer');
  });
  test('next=//evil.example and next=https://evil.example fall back to /', async () => {
    for (const next of ['//evil.example', 'https://evil.example', 'https://evil.example/draft']) {
      const r = await confirmSignIn(url(`token_hash=abc&type=email&next=${encodeURIComponent(next)}`), ok);
      expect(where(r)).toBe(`${ORIGIN}/`);
    }
  });
  test('an invalid token redirects to /?signin=expired', async () => {
    expect(where(await confirmSignIn(url('token_hash=abc&type=email&next=%2Fdraft'), bad))).toBe(`${ORIGIN}/?signin=expired`);
  });
  test('a throwing verifier, missing parameters and an unknown type all redirect to expired', async () => {
    const boom: ConfirmDeps = { verifyOtp: async () => Promise.reject(new Error('net')) };
    expect(where(await confirmSignIn(url('token_hash=abc&type=email'), boom))).toBe(`${ORIGIN}/?signin=expired`);
    expect(where(await confirmSignIn(url('type=email'), ok))).toBe(`${ORIGIN}/?signin=expired`);
    expect(where(await confirmSignIn(url('token_hash=abc'), ok))).toBe(`${ORIGIN}/?signin=expired`);
    expect(where(await confirmSignIn(url('token_hash=abc&type=recovery'), ok))).toBe(`${ORIGIN}/?signin=expired`);
  });
  test('a link with a planted second token_hash, type or next is refused before any verification', async () => {
    for (const q of [
      'token_hash=attacker&type=email&token_hash=real&type=email',
      'next=/draft&token_hash=real&type=email&next=/x',
      'token_hash=real&type=magiclink&type=email',
    ]) {
      let called = 0;
      const r = await confirmSignIn(new URL(`https://agentenact.io/auth/confirm?${q}`), { verifyOtp: async () => ((called += 1), { error: null }) });
      expect(r.headers.get('location')).toBe('https://agentenact.io/?signin=expired');
      expect(called).toBe(0);
    }
  });
  test('an encoded next with intent=create lands intact, as one path', async () => {
    const next = encodeURIComponent('/draft?h=AbCdEfGhIjKlMnOpQrStUv&intent=create');
    const r = await confirmSignIn(url(`next=${next}&token_hash=abc&type=email`), { verifyOtp: async () => ({ error: null }) });
    expect(r.headers.get('location')).toBe('https://agentenact.io/draft?h=AbCdEfGhIjKlMnOpQrStUv&intent=create');
  });
  test('the verifier is never called for an unknown type', async () => {
    let called = false;
    await confirmSignIn(url('token_hash=abc&type=recovery'), { verifyOtp: async () => ((called = true), { error: null }) });
    expect(called).toBe(false);
  });
});

describe('safeNext rejects', () => {
  const cases: [string, string][] = [
    ['double slash', '//evil.example'],
    ['double slash with path', '//evil.example/draft'],
    ['backslash after slash', '/\\evil.example'],
    ['backslash only', '\\\\evil.example'],
    ['https scheme', 'https://evil.example'],
    ['javascript scheme', 'javascript:alert(1)'],
    ['data scheme', 'data:text/html,x'],
    ['scheme after slash', '/https://evil.example'],
    ['encoded double slash', '%2F%2Fevil.example'],
    ['slash then encoded slash', '/%2Fevil.example'],
    ['encoded backslash', '/%5Cevil.example'],
    ['double-encoded slashes', '/%252Fevil.example'],
    ['tab inside', '/\t/evil.example'],
    ['newline inside', '/\n/evil.example'],
    ['encoded tab', '/%09/evil.example'],
    ['relative path', 'draft'],
    ['empty', ''],
    ['malformed encoding', '/%E0%A4%A'],
  ];
  for (const [name, input] of cases) test(name, () => expect(safeNext(input)).toBe('/'));
  test('null and undefined', () => {
    expect(safeNext(null)).toBe('/');
    expect(safeNext(undefined)).toBe('/');
  });
  test('the fallback is configurable', () => expect(safeNext('//evil.example', '/draft')).toBe('/draft'));
});

describe('safeNext accepts', () => {
  test('same-origin paths with query and hash', () => {
    for (const p of ['/', '/draft', '/draft?h=AbC_dEf-123456789012', '/draft?h=AbC_dEf-123456789012&intent=create', '/a/b?x=1#y', '/draft?next=%2Fa']) expect(safeNext(p)).toBe(p);
  });
});


describe('the /auth/confirm route: opening the link never signs anyone in', () => {
  const rig = (error: unknown = null) => {
    const calls: unknown[] = [];
    const route = createAuthConfirmRoute(async () => ({ verifyOtp: async (a) => (calls.push(a), { error }) }));
    return { calls, route };
  };
  const link = (q: string) => new Request(`${ORIGIN}/auth/confirm?${q}`);
  const post = (body: string, headers: Record<string, string> = { origin: ORIGIN }) =>
    new Request(`${ORIGIN}/auth/confirm`, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded', ...headers }, body });
  const NEXT = '/draft?h=AbC_dEf-123456789012&intent=create';

  test('GET shows a Continue page and does not call verifyOtp, however often it is fetched', async () => {
    const { calls, route } = rig();
    for (let i = 0; i < 3; i++) {
      const r = await route.GET(link(`next=${encodeURIComponent(NEXT)}&token_hash=abc&type=email`));
      expect(r.status).toBe(200);
      expect(r.headers.get('content-type')).toContain('text/html');
      expect(r.headers.get('cache-control')).toBe('no-store');
      // Not no-referrer: under no-referrer a browser sends `Origin: null` on the form POST, and the POST would refuse it
      // (that shipped once and broke every email sign-in). same-origin sends the real origin here and nothing elsewhere.
      expect(r.headers.get('referrer-policy')).toBe('same-origin');
      const html = await r.text();
      expect(html).toMatch(/<form[^>]*method="post"[^>]*action="\/auth\/confirm"/);
      expect(html).toContain('name="token_hash" value="abc"');
      expect(html).toContain('name="type" value="email"');
      expect(html).toContain(`name="next" value="${NEXT.replace('&', '&amp;')}"`);
      expect(html).toMatch(new RegExp(`<button[^>]*>${copy.confirm.button}</button>`));
      expect(bannedWord(textOf(html))).toBeNull();
    }
    expect(calls).toEqual([]);
  });

  test('GET with a tampered or incomplete link redirects to expired and does not call verifyOtp', async () => {
    const { calls, route } = rig();
    for (const q of ['token_hash=a&type=email&token_hash=b', 'type=email', 'token_hash=abc', 'token_hash=abc&type=recovery']) {
      const r = await route.GET(link(q));
      expect(r.status).toBe(303);
      expect(where(r)).toBe(`${ORIGIN}/?signin=expired`);
    }
    expect(calls).toEqual([]);
  });

  test('GET never lets next escape: a bad next is dropped from the page', async () => {
    const { route } = rig();
    const html = await (await route.GET(link(`next=${encodeURIComponent('//evil.example')}&token_hash=abc&type=email`))).text();
    expect(html).toContain('name="next" value="/"');
    expect(html).not.toContain('evil.example');
  });

  test('GET escapes everything it prints', async () => {
    const { route } = rig();
    const html = await (await route.GET(link(`token_hash=${encodeURIComponent('"><script>x</script>')}&type=email`))).text();
    expect(html).not.toContain('<script>x');
  });

  test('POST from the page verifies once, then redirects to next', async () => {
    const { calls, route } = rig();
    const r = await route.POST(post(new URLSearchParams({ token_hash: 'abc', type: 'email', next: NEXT }).toString()));
    expect(calls).toEqual([{ token_hash: 'abc', type: 'email' }]);
    expect(r.status).toBe(303);
    expect(where(r)).toBe(`${ORIGIN}${NEXT}`);
  });

  test('POST with an invalid next is rejected to /', async () => {
    for (const next of ['//evil.example', 'https://evil.example', '/\\evil.example']) {
      const { route } = rig();
      const r = await route.POST(post(new URLSearchParams({ token_hash: 'abc', type: 'email', next }).toString()));
      expect(where(r)).toBe(`${ORIGIN}/`);
    }
  });

  test('POST with an expired token goes to expired', async () => {
    const { route } = rig(new Error('expired'));
    const r = await route.POST(post('token_hash=abc&type=email&next=%2Fdraft'));
    expect(where(r)).toBe(`${ORIGIN}/?signin=expired`);
  });

  test('POST from another site (or with no origin evidence) is refused before any verification', async () => {
    for (const headers of [{ origin: 'https://evil.example' }, { origin: 'null' }, { origin: 'null', 'sec-fetch-site': 'cross-site' }, {}, { 'sec-fetch-site': 'cross-site' }] as Record<string, string>[]) {
      const { calls, route } = rig();
      const r = await route.POST(post('token_hash=abc&type=email&next=%2Fdraft', headers));
      expect(where(r)).toBe(`${ORIGIN}/?signin=expired`);
      expect(calls).toEqual([]);
    }
  });

  test('POST with Origin: null is accepted only when the browser itself says same-origin (a privacy referrer policy)', async () => {
    const { calls, route } = rig();
    await route.POST(post('token_hash=abc&type=email', { origin: 'null', 'sec-fetch-site': 'same-origin' }));
    expect(calls).toHaveLength(1);
  });

  test('POST without an Origin header is accepted when the browser says it is same-origin', async () => {
    const { calls, route } = rig();
    await route.POST(post('token_hash=abc&type=email', { 'sec-fetch-site': 'same-origin' }));
    expect(calls).toHaveLength(1);
  });

  test('POST keeps the planted-parameter refusal', async () => {
    const { calls, route } = rig();
    const r = await route.POST(post('token_hash=attacker&type=email&token_hash=real'));
    expect(where(r)).toBe(`${ORIGIN}/?signin=expired`);
    expect(calls).toEqual([]);
  });

  test('the page text is plain words', () => {
    for (const t of [copy.confirm.title, copy.confirm.lead, copy.confirm.button]) expect(bannedWord(t)).toBeNull();
  });
});

describe('the deployment origin', () => {
  test('APP_ORIGIN (staging) wins over the canonical origin for redirects and the same-origin check', async () => {
    const { appOrigin } = await import('../src/server/origin');
    const prev = process.env.APP_ORIGIN;
    try {
      delete process.env.APP_ORIGIN;
      expect(appOrigin()).toBe('https://agentenact.io');
      process.env.APP_ORIGIN = 'https://staging.agentenact.io';
      expect(appOrigin()).toBe('https://staging.agentenact.io');
      const { fromThisOrigin } = await import('../src/server/auth-confirm');
      expect(fromThisOrigin(new Request('https://staging.agentenact.io/auth/confirm', { method: 'POST', headers: { origin: 'https://staging.agentenact.io' } }))).toBe(true);
      expect(fromThisOrigin(new Request('https://staging.agentenact.io/auth/confirm', { method: 'POST', headers: { origin: 'https://agentenact.io' } }))).toBe(false);
    } finally {
      if (prev === undefined) delete process.env.APP_ORIGIN;
      else process.env.APP_ORIGIN = prev;
    }
  });
});
