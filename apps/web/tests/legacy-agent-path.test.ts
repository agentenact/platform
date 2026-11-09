import { describe, expect, test } from 'bun:test';
import { NextRequest } from 'next/server';
// Next's own matchers, the ones `next start` applies to config redirects. Internal paths: the curl run in the merge plan's
// phase 3 is the runtime proof; this keeps the rule order honest between runs.
import { getPathMatch } from 'next/dist/shared/lib/router/utils/path-match.js';
import { matchHas, prepareDestination } from 'next/dist/shared/lib/router/utils/prepare-destination.js';
import nextConfig from '../next.config';
import { LEGACY_AGENT_REDIRECTS, legacyAgentPath, legacyProfileRedirect } from '../src/lib/legacy-agent-path';
import { proxy } from '../src/proxy';
import { createAuthConfirmRoute, confirmSignIn, type ConfirmDeps } from '../src/server/auth-confirm';

// Old links reach the app on the apex: after the cutover app.agentenact.io 301s every path to it.
const ORIGIN = 'https://agentenact.io';
const ok: ConfirmDeps = { verifyOtp: async () => ({ error: null }) };

describe('legacyAgentPath', () => {
  test('the old public profile link goes to /agents/<id>', () => {
    expect(legacyAgentPath('/agent?id=13')).toBe('/agents/13');
    expect(legacyAgentPath('/agent?x=1&id=92#top')).toBe('/agents/92');
  });
  test('every other /agent path goes to the same place under /dashboard, query and hash kept', () => {
    expect(legacyAgentPath('/agent')).toBe('/dashboard');
    expect(legacyAgentPath('/agent?run=r1')).toBe('/dashboard?run=r1');
    expect(legacyAgentPath('/agent#x')).toBe('/dashboard#x');
    expect(legacyAgentPath('/agent/earnings')).toBe('/dashboard/earnings');
    expect(legacyAgentPath('/agent/pause?agent=7')).toBe('/dashboard/pause?agent=7');
    expect(legacyAgentPath('/agent?id=abc')).toBe('/dashboard?id=abc');
    expect(legacyAgentPath('/agent?id=')).toBe('/dashboard?id=');
  });
  test('anything else is left alone, including /agents/... and look-alike prefixes', () => {
    for (const p of ['/', '/draft?h=abc', '/agents/13', '/agents?id=1', '/agentx', '/dashboard', '/a/123/agent.json', '/dashboard/chat'])
      expect(legacyAgentPath(p)).toBe(p);
  });
  test('legacyProfileRedirect answers only bare /agent with an id', () => {
    expect(legacyProfileRedirect('/agent', '?id=13')).toBe('/agents/13');
    expect(legacyProfileRedirect('/agent', '?id=abc')).toBe('/dashboard?id=abc');
    expect(legacyProfileRedirect('/agent', '')).toBeNull();
    expect(legacyProfileRedirect('/agent', '?run=r1')).toBeNull();
    expect(legacyProfileRedirect('/agent/earnings', '?id=13')).toBeNull();
    expect(legacyProfileRedirect('/agents/13', '?id=13')).toBeNull();
  });
});

/** The first config redirect that matches, resolved the way Next does: path match, has/missing, then the destination. */
function configRedirect(rules: typeof LEGACY_AGENT_REDIRECTS, url: string): string | null {
  const u = new URL(url, ORIGIN);
  const query = Object.fromEntries(u.searchParams);
  for (const r of rules) {
    const params = getPathMatch(r.source)(u.pathname);
    if (!params) continue;
    const hasParams = matchHas({ headers: {}, cookies: {} } as never, query, 'has' in r ? (r.has as never) : [], 'missing' in r ? (r.missing as never) : []);
    if (!hasParams) continue;
    const { parsedDestination } = prepareDestination({ appendParamsToQuery: false, destination: r.destination, params: { ...params, ...hasParams }, query });
    const search = new URLSearchParams(parsedDestination.query as Record<string, string>).toString();
    return `${parsedDestination.pathname}${search ? `?${search}` : ''}`;
  }
  return null;
}

describe('next.config redirects', () => {
  test('carry every legacy rule, all permanent', async () => {
    const rules = await nextConfig.redirects!();
    expect(rules).toEqual(expect.arrayContaining(LEGACY_AGENT_REDIRECTS));
    for (const r of rules) expect(r.permanent).toBe(true);
  });
  test('send the owner\'s old paths to /dashboard, query kept', () => {
    expect(configRedirect(LEGACY_AGENT_REDIRECTS, '/agent')).toBe('/dashboard');
    expect(configRedirect(LEGACY_AGENT_REDIRECTS, '/agent?run=r1')).toBe('/dashboard?run=r1');
    expect(configRedirect(LEGACY_AGENT_REDIRECTS, '/agent/earnings')).toBe('/dashboard/earnings');
    expect(configRedirect(LEGACY_AGENT_REDIRECTS, '/agent/chat')).toBe('/dashboard/chat');
    expect(configRedirect(LEGACY_AGENT_REDIRECTS, '/agent/pause?agent=7')).toBe('/dashboard/pause?agent=7');
    expect(configRedirect(LEGACY_AGENT_REDIRECTS, '/agent/pause/confirm')).toBe('/dashboard/pause/confirm');
  });
  test('leave /agent?id= to the proxy (a config redirect would copy ?id= onto /agents/<id>), and never touch other paths', () => {
    expect(configRedirect(LEGACY_AGENT_REDIRECTS, '/agent?id=13')).toBeNull();
    expect(configRedirect(LEGACY_AGENT_REDIRECTS, '/agent?id=abc')).toBeNull();
    for (const p of ['/agents/13', '/dashboard', '/agentx', '/a/123/agent.json']) expect(configRedirect(LEGACY_AGENT_REDIRECTS, p)).toBeNull();
  });
});

describe('the proxy', () => {
  test('answers /agent?id=<n> with a permanent redirect to the clean profile path', async () => {
    const r = await proxy(new NextRequest(`${ORIGIN}/agent?id=13`));
    expect(r.status).toBe(308);
    expect(r.headers.get('location')).toBe(`${ORIGIN}/agents/13`);
    const extra = await proxy(new NextRequest(`${ORIGIN}/agent?id=13&utm=x`));
    expect(extra.headers.get('location')).toBe(`${ORIGIN}/agents/13`);
  });
  test('sends a non-numeric id to /dashboard, like the config rules would without one', async () => {
    const r = await proxy(new NextRequest(`${ORIGIN}/agent?id=abc`));
    expect(r.status).toBe(308);
    expect(r.headers.get('location')).toBe(`${ORIGIN}/dashboard?id=abc`);
  });
});

describe('/auth/confirm with a magic link sent before the move', () => {
  const link = (next: string) => new URL(`${ORIGIN}/auth/confirm?token_hash=abc&type=magiclink&next=${encodeURIComponent(next)}`);
  test('an old next lands in the dashboard in one hop', async () => {
    for (const [next, to] of [
      ['/agent', '/dashboard'],
      ['/agent?run=r1', '/dashboard?run=r1'],
      ['/agent/pause?agent=7', '/dashboard/pause?agent=7'],
      ['/agent/earnings', '/dashboard/earnings'],
      ['/agent?id=13', '/agents/13'],
    ]) expect((await confirmSignIn(link(next!), ok)).headers.get('location')).toBe(`${ORIGIN}${to}`);
  });
  test('the Continue page already carries the new next', async () => {
    const route = createAuthConfirmRoute(async () => ok);
    const html = await (await route.GET(new Request(link('/agent/pause?agent=7')))).text();
    expect(html).toContain('name="next" value="/dashboard/pause?agent=7"');
  });
  test('new and unrelated next values are untouched, and a bad next still falls back to /', async () => {
    for (const next of ['/dashboard/pause?agent=7', '/draft?h=AbC_dEf-123456789012', '/agents/13'])
      expect((await confirmSignIn(link(next), ok)).headers.get('location')).toBe(`${ORIGIN}${next}`);
    for (const next of ['//evil.example/agent', 'https://evil.example/agent'])
      expect((await confirmSignIn(link(next), ok)).headers.get('location')).toBe(`${ORIGIN}/`);
  });
});

describe('no link in the panel still points at /agent', () => {
  test('src has no /agent href, redirect, push or revalidate left (only the legacy mapping itself)', async () => {
    const glob = new Bun.Glob('src/**/*.{ts,tsx}');
    const hits: string[] = [];
    for await (const f of glob.scan({ cwd: new URL('..', import.meta.url).pathname })) {
      if (f === 'src/lib/legacy-agent-path.ts') continue;
      const code = (await Bun.file(new URL(`../${f}`, import.meta.url)).text()).replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
      if (/['"`(]\/agent(?=['"`?/#])/.test(code)) hits.push(f);
    }
    expect(hits).toEqual([]);
  });
});
