import { describe, expect, test } from 'bun:test';
import { createPauseRoute, pausePage, pauseNext } from '../src/server/pause-confirm';
import { createAgentActions } from '../src/server/agent-actions';
import { safeNext } from '../src/server/auth-confirm';
import { bannedWord } from '../src/lib/words';
import type { ApiCall } from '../src/server/api';

const ORIGIN = 'https://agentenact.io';
const AGENT = '11111111-2222-4333-8444-555555555555';
const OWNER = 'owner-token';
const visible = (html: string) => html.replace(/<title>.*?<\/title>/s, '').replace(/<[^>]+>/g, ' ');

/** The api as the real one behaves: only the owner's token may pause the agent; anyone else is 404. */
function rig(who: string | null = OWNER) {
  const token: string | undefined = who ?? undefined;
  const apiCalls: { path: string; token?: string | undefined; method?: string | undefined }[] = [];
  const api: ApiCall = async (path, o) => {
    apiCalls.push({ path, token: o?.token, method: o?.method });
    return { status: o?.token === OWNER && path === `/api/agents/${AGENT}/pause` ? 204 : 404, json: null };
  };
  const actions = createAgentActions({ api, token: async () => token });
  // The route's dependencies are the token and the pause: there is no sign-in dependency to call.
  const route = createPauseRoute({ token: async () => token, setPaused: (id, paused) => actions.setPaused(id, paused) });
  return { route, apiCalls };
}
const post = (body: Record<string, string>, headers: Record<string, string> = { origin: ORIGIN }) =>
  new Request(`${ORIGIN}/dashboard/pause/confirm`, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded', ...headers }, body: new URLSearchParams(body).toString() });
const PAUSE = { agent: AGENT };

describe('what GET /dashboard/pause shows', () => {
  test('signed in: the confirm view for that agent', () => {
    expect(pausePage(AGENT, true)).toEqual({ kind: 'confirm', agent: AGENT });
  });
  test('signed out: the browser sign-in, returning to this same page, with a next that safeNext accepts unchanged', () => {
    const v = pausePage(AGENT, false);
    expect(v).toEqual({ kind: 'signin', agent: AGENT, next: `/dashboard/pause?agent=${AGENT}` });
    if (v.kind !== 'signin') throw new Error('unreachable');
    expect(safeNext(v.next)).toBe(v.next);
    expect(v.next).toBe(pauseNext(AGENT));
    // After the link and Continue, the visitor lands on the confirm view: nothing is paused by the sign-in itself.
    expect(pausePage(AGENT, true).kind).toBe('confirm');
  });
  test('a missing, malformed or repeated agent is a bad link, signed in or not', () => {
    for (const a of [undefined, 'nope', [AGENT, AGENT], '"><script>x</script>', `${AGENT}&x=1`]) {
      expect(pausePage(a, true)).toEqual({ kind: 'bad' });
      expect(pausePage(a, false)).toEqual({ kind: 'bad' });
    }
  });
});

describe('GET /dashboard/pause/confirm pauses nothing', () => {
  test('it only goes back to the confirmation page, however often it is fetched', async () => {
    const { route, apiCalls } = rig();
    for (let i = 0; i < 3; i++) {
      const r = await route.GET(new Request(`${ORIGIN}/dashboard/pause/confirm?agent=${AGENT}`));
      expect(r.status).toBe(303);
      expect(r.headers.get('location')).toBe(`/dashboard/pause?agent=${AGENT}`);
    }
    expect(apiCalls).toEqual([]);
  });
});

describe('POST /dashboard/pause/confirm', () => {
  test('the signed-in owner, from this origin, pauses their agent with their own token', async () => {
    const { route, apiCalls } = rig();
    const r = await route.POST(post(PAUSE));
    expect(r.status).toBe(200);
    expect(apiCalls).toEqual([{ path: `/api/agents/${AGENT}/pause`, token: OWNER, method: 'POST' }]);
    const html = await r.text();
    expect(html).toContain('Paused');
    expect(html).toContain('href="/dashboard"');
    expect(r.headers.get('cache-control')).toBe('no-store');
    // Not no-referrer: that makes the browser send `Origin: null` on form POSTs (it broke email sign-in once).
    expect(r.headers.get('referrer-policy')).toBe('same-origin');
  });

  test('someone signed in as another person cannot pause it: the api says no, and the page does not claim success', async () => {
    const { route, apiCalls } = rig('someone-elses-token');
    const html = await (await route.POST(post(PAUSE))).text();
    expect(apiCalls.length).toBe(1);
    expect(html).not.toContain('>Paused<');
    expect(html).toContain('Nothing was paused');
  });

  test('signed out: no api call, back to the confirmation page where sign-in happens', async () => {
    const { route, apiCalls } = rig(null);
    const r = await route.POST(post(PAUSE));
    expect(r.status).toBe(303);
    expect(r.headers.get('location')).toBe(`/dashboard/pause?agent=${AGENT}`);
    expect(apiCalls).toEqual([]);
  });

  test('a form from another origin pauses nothing', async () => {
    const { route, apiCalls } = rig();
    for (const headers of <Record<string, string>[]>[{ origin: 'https://evil.example' }, { origin: 'null', 'sec-fetch-site': 'cross-site' }, { origin: 'null' }, {}, { 'sec-fetch-site': 'same-site' }, { 'sec-fetch-site': 'cross-site' }]) {
      const r = await route.POST(post(PAUSE, headers));
      expect(r.status).toBe(403);
      expect(await r.text()).not.toContain('>Paused<');
    }
    expect(apiCalls).toEqual([]);
  });

  test('a null Origin is accepted only when the browser itself says same-origin', async () => {
    const { route, apiCalls } = rig();
    expect((await route.POST(post(PAUSE, { origin: 'null', 'sec-fetch-site': 'same-origin' }))).status).toBe(200);
    expect(apiCalls.length).toBe(1);
  });

  test('a malformed, missing or repeated agent calls nothing', async () => {
    const { route, apiCalls } = rig();
    for (const body of ['agent=nope', '', `agent=${AGENT}&agent=${AGENT}`]) {
      const r = await route.POST(new Request(`${ORIGIN}/dashboard/pause/confirm`, { method: 'POST', headers: { origin: ORIGIN, 'content-type': 'application/x-www-form-urlencoded' }, body }));
      expect(r.status).toBe(400);
    }
    expect(apiCalls).toEqual([]);
  });

  test('an api failure says so and offers to try again', async () => {
    const route = createPauseRoute({ token: async () => OWNER, setPaused: async () => ({ ok: false, status: 503 }) });
    const html = await (await route.POST(post(PAUSE))).text();
    expect(html).not.toContain('>Paused<');
    expect(html).toContain('Try again');
  });
});

describe('the route never sends a sign-in email itself', () => {
  test('its source has no OTP or sign-in call, and its deps take none', async () => {
    const src = await Bun.file(new URL('../src/server/pause-confirm.ts', import.meta.url)).text();
    const code = src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
    expect(code).not.toMatch(/signInWithOtp|signIn\(|\bsignIn:|supabase|\.auth\b|verifyOtp/i);
    const route = await Bun.file(new URL('../src/app/dashboard/pause/confirm/route.ts', import.meta.url)).text();
    expect(route).not.toMatch(/signInWithOtp|supabase/i);
  });
  test('the pause page signs in through the browser card, with the pause page as next', async () => {
    const page = await Bun.file(new URL('../src/app/dashboard/pause/page.tsx', import.meta.url)).text();
    expect(page).toContain('<SignInCard next={view.next} />');
    const card = await Bun.file(new URL('../src/components/sign-in.tsx', import.meta.url)).text();
    expect(card).toContain('landOn ? safeNext(landOn)');
    expect(card).toContain('supabaseBrowser().auth.signInWithOtp');
  });
});

describe('server pages', () => {
  test('use plain words', async () => {
    const failing = createPauseRoute({ token: async () => OWNER, setPaused: async () => ({ ok: false, status: 503 }) });
    const pages = [await rig().route.POST(post(PAUSE)), await rig('x').route.POST(post(PAUSE)), await rig().route.POST(post({ agent: 'nope' })), await rig().route.POST(post(PAUSE, {})), await failing.POST(post(PAUSE))];
    for (const p of pages) expect(bannedWord(visible(await p.text()))).toBeNull();
  });
});
