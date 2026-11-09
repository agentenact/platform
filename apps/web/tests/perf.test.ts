import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const SRC = join(import.meta.dir, '../src');
const read = (f: string) => readFileSync(join(SRC, f), 'utf8');
/** The module's static imports (dynamic `import()` calls are not in this list). */
const staticImports = (f: string) => [...read(f).matchAll(/^import [^;]*? from '([^']+)'/gm)].map((m) => m[1]!);

describe('the sign-in dialog loads on demand', () => {
  test('nothing the header renders imports the dialog or the Supabase browser client up front', () => {
    for (const f of ['components/app-header.tsx', 'components/header-account.tsx', 'components/header-sign-in.tsx', 'components/account-menu.tsx', 'components/sign-in-dialog-lazy.tsx']) {
      const deps = staticImports(f);
      expect([f, deps.filter((d) => /\/sign-in-dialog$|\/sign-in$|supabase/.test(d))]).toEqual([f, []]);
    }
  });
  test('the lazy wrapper is a client-only dynamic import of the real dialog', () => {
    const src = read('components/sign-in-dialog-lazy.tsx');
    expect(src).toContain("import('@/components/sign-in-dialog')");
    expect(src).toContain('ssr: false');
  });
});

describe('public pages render statically', () => {
  const { MUST_BE_STATIC, staticRouteProblems } = require('../src/lib/static-routes') as typeof import('../src/lib/static-routes');
  test('the build check names a page that turned dynamic, or a session page that got prerendered', () => {
    expect(staticRouteProblems(['/', '/explore', '/market', '/verify', '/create', '/api/health'])).toEqual([]);
    expect(staticRouteProblems(['/', '/explore', '/market', '/create'])).toEqual(['/verify is not static']);
    expect(staticRouteProblems([...MUST_BE_STATIC, '/dashboard'])).toEqual(['/dashboard was prerendered but reads the session']);
  });
  test('the build runs the check', () => {
    const pkg = JSON.parse(readFileSync(join(import.meta.dir, '../package.json'), 'utf8')) as { scripts: Record<string, string> };
    expect(pkg.scripts.build).toBe('next build && bun run scripts/check-static-routes.ts');
  });
  test('the static pages and their layout read nothing from the request', () => {
    for (const f of ['app/layout.tsx', 'app/(site)/layout.tsx', 'app/(site)/page.tsx', 'app/(site)/explore/page.tsx', 'app/(site)/verify/page.tsx', 'app/(site)/create/page.tsx']) {
      const src = read(f).replace(/\/\*[\s\S]*?\*\/|\/\/.*$/gm, '');
      expect([f, /searchParams|cookies\(|headers\(|getHeaderMe|getMe\b|force-dynamic|supabase/.test(src)]).toEqual([f, false]);
    }
  });
});

describe('the header finds the visitor in the browser on static pages', () => {
  const { createHeaderMeStore, parseHeaderMe } = require('../src/lib/header-me') as typeof import('../src/lib/header-me');
  test('starts unknown, asks /api/header-me once however many islands ask, then shares the answer', async () => {
    const asked: string[] = [];
    const s = createHeaderMeStore({ fetch: async (p) => (asked.push(p), { email: 'a@b.co', agentName: 'XLM' }) });
    expect(s.get()).toBeUndefined();
    let heard = 0;
    s.subscribe(() => heard++);
    await Promise.all([s.ensure(), s.ensure(), s.ensure()]);
    await s.ensure();
    expect(asked).toEqual(['/api/header-me']);
    expect(s.get()).toEqual({ email: 'a@b.co', agentName: 'XLM' });
    expect(heard).toBe(1);
  });
  test('a failing or malformed answer reads as signed out', async () => {
    const boom = createHeaderMeStore({ fetch: async () => { throw new Error('x'); } });
    await boom.ensure();
    expect(boom.get()).toBeNull();
    for (const v of [null, {}, { email: '' }, { email: 3 }, 'a@b.co']) expect(parseHeaderMe(v)).toBeNull();
    expect(parseHeaderMe({ email: 'a@b.co', agentName: '' })).toEqual({ email: 'a@b.co' });
  });
  test('a page rendered with the session hands its answer over, so no request is made', async () => {
    let asked = 0;
    const s = createHeaderMeStore({ fetch: async () => (asked++, null) });
    s.set({ email: 'a@b.co' });
    await s.ensure();
    expect(asked).toBe(0);
    s.set(null); // signed out
    expect(s.get()).toBeNull();
  });
  test('re-asks after the given age, for a tab that comes back', async () => {
    let t = 0;
    let asked = 0;
    const s = createHeaderMeStore({ fetch: async () => (asked++, null), now: () => t });
    await s.ensure(60_000);
    t = 30_000;
    await s.ensure(60_000);
    t = 61_000;
    await s.ensure(60_000);
    expect(asked).toBe(2);
  });
  test('the route answers the visitor, never cached, through the same server read as before', () => {
    const src = read('app/api/header-me/route.ts');
    expect(src).toContain('getHeaderMe()');
    expect(src).toContain("'Cache-Control': 'private, no-store'");
    expect(src).toContain("dynamic = 'force-dynamic'");
    expect(src).not.toContain('Access-Control');
  });
});

describe('the proxy refreshes the session only where it is read', () => {
  const { isSessionFreeRequest } = require('../src/lib/session-free') as typeof import('../src/lib/session-free');
  const { proxy } = require('../src/proxy') as typeof import('../src/proxy');
  const { NextRequest } = require('next/server') as typeof import('next/server');
  /** Runs the proxy with a session cookie and reports whether it called the auth server. */
  const callsAuth = async (path: string, method = 'GET') => {
    const realFetch = globalThis.fetch;
    let called = false;
    globalThis.fetch = (async () => {
      called = true;
      return new Response(JSON.stringify({ message: 'invalid' }), { status: 401, headers: { 'content-type': 'application/json' } });
    }) as never;
    try {
      const token = `base64-${Buffer.from(JSON.stringify({ access_token: 'a.b.c', refresh_token: 'r', expires_at: 1, token_type: 'bearer', user: { id: 'u' } })).toString('base64url')}`;
      await proxy(new NextRequest(`https://agentenact.io${path}`, { method, headers: { cookie: `sb-supabase-auth-token=${token}` } }));
    } finally {
      globalThis.fetch = realFetch;
    }
    return called;
  };
  test('which requests skip it', () => {
    for (const p of ['/', '/explore', '/verify', '/create', '/agents/31']) expect([p, isSessionFreeRequest('GET', p), isSessionFreeRequest('HEAD', p)]).toEqual([p, true, true]);
    for (const p of ['/dashboard', '/dashboard/chat', '/draft', '/api/header-me', '/auth/confirm', '/agents/31/x', '/explorer', '/create/x']) expect([p, isSessionFreeRequest('GET', p)]).toEqual([p, false]);
    // A server action posts to the page it runs on: it gets the refresh.
    for (const p of ['/', '/explore', '/create']) expect([p, isSessionFreeRequest('POST', p)]).toEqual([p, false]);
  });
  test('a public page answers without the auth server; the session pages, the header check and actions still refresh', async () => {
    expect(await callsAuth('/explore')).toBe(false);
    expect(await callsAuth('/agents/31')).toBe(false);
    expect(await callsAuth('/dashboard')).toBe(true);
    expect(await callsAuth('/draft')).toBe(true);
    expect(await callsAuth('/api/header-me')).toBe(true);
    expect(await callsAuth('/explore', 'POST')).toBe(true);
  });
});

describe('internal links navigate in place', () => {
  const { isAppPath } = require('../src/components/app-link') as typeof import('../src/components/app-link');
  test("this app's pages go through next/link; other origins, the api, files, routes and /draft do not", () => {
    for (const h of ['/', '/explore', '/verify', '/verify?agent=x&tx=y', '/create', '/create#install', '/create?template=xlm-drop', '/agents/31', '/dashboard', '/dashboard/chat'])
      expect([h, isAppPath(h)]).toEqual([h, true]);
    for (const h of ['https://agentkarma.io', '//evil.example/x', '/a/0b1c/agent.json', '/a', '/api/header-me', '/auth/confirm', '/email/magic-link', '/draft', '/draft?h=secret', '/verifier/agentenact.js', '/proofs/latest.json', '/icon.svg', '#install', 'mailto:a@b.co', '/rows.csv'])
      expect([h, isAppPath(h)]).toEqual([h, false]);
  });
  test('the link component keeps a plain anchor for new tabs and downloads', () => {
    const { renderToStaticMarkup } = require('react-dom/server') as typeof import('react-dom/server');
    const { createElement } = require('react') as typeof import('react');
    const { AppLink } = require('../src/components/app-link') as typeof import('../src/components/app-link');
    expect(renderToStaticMarkup(createElement(AppLink, { href: 'https://stellar.expert/x' }, 'x'))).toBe('<a href="https://stellar.expert/x">x</a>');
    expect(renderToStaticMarkup(createElement(AppLink, { href: '/explore', target: '_blank' }, 'x'))).toBe('<a href="/explore" target="_blank">x</a>');
  });
  test('no component or page writes a plain anchor to one of the app pages', () => {
    const { readdirSync, statSync } = require('node:fs') as typeof import('node:fs');
    const walk = (d: string): string[] => readdirSync(d).flatMap((n) => (statSync(join(d, n)).isDirectory() ? walk(join(d, n)) : [join(d, n)]));
    // The builder's own /create?… links are handled in place by their onClick; the header's Sign in opens the dialog; a
    // download (a day's sealed checks) is a file, never a page.
    const allowed = /href=\{builderUrl\(|href="\/\?signin=1"|\bdownload=/;
    const offenders: string[] = [];
    for (const f of walk(SRC).filter((x) => x.endsWith('.tsx') && !/draft-flow|create-builder|app-link/.test(x))) {
      for (const m of readFileSync(f, 'utf8').matchAll(/<a\b[^>]*\bhref=(?:"([^"]*)"|\{`([^`]*)`\})[^>]*>/g)) {
        const href = (m[1] ?? m[2] ?? '').replace(/\$\{[^}]*\}/g, '1');
        if (isAppPath(href) && !allowed.test(m[0])) offenders.push(`${f.replace(SRC, '')}: ${m[0].slice(0, 80)}`);
      }
    }
    expect(offenders).toEqual([]);
  });
});

describe('the ~1 MB verifier bundle is never loaded eagerly', () => {
  test('the homepage markup neither loads nor preloads it', () => {
    const { renderToStaticMarkup } = require('react-dom/server') as typeof import('react-dom/server');
    const { createElement } = require('react') as typeof import('react');
    const { HomeView } = require('../src/components/home-screen') as typeof import('../src/components/home-screen');
    const proof = JSON.parse(readFileSync(join(import.meta.dir, '../public/proofs/latest.json'), 'utf8'));
    const html = renderToStaticMarkup(createElement(HomeView, { proof, verifierSrc: '/verifier/agentenact.js?v=test' }));
    expect(html).not.toContain('/verifier/agentenact.js');
    expect(html).not.toMatch(/modulepreload/);
  });
  test('the live proof imports it only from its viewport observers or a button, never on mount', () => {
    const src = read('components/live-proof.tsx');
    expect(staticImports('components/live-proof.tsx').some((d) => d.includes('verifier'))).toBe(false);
    // loadVerifier is called from verifyOnce (run) and from the "near" observer; both observers start it only on intersection.
    const calls = [...src.matchAll(/loadVerifier\(/g)].length;
    expect(calls).toBe(3); // the definition, verifyOnce, the warm-up
    expect(src).toMatch(/const near = new IntersectionObserver\(\s*\(\[entry\]\) => \{\s*if \(!entry\?\.isIntersecting\) return;\s*near\.disconnect\(\);\s*loadVerifier/);
    expect(src).toMatch(/if \(entry\?\.isIntersecting\) \{\s*observer\.disconnect\(\);\s*void run\('original'\)/);
  });
  test('/create loads it only when a wallet is connected or an agent created', () => {
    const src = read('components/create-agent.tsx');
    for (const m of src.matchAll(/loadBundle\(verifierSrc\)/g)) {
      const before = src.slice(0, m.index);
      const fn = before.slice(before.lastIndexOf('async function'));
      expect(fn).toMatch(/^async function (connect|create)\(/);
    }
  });
});

describe('route crossfade', () => {
  const css = readFileSync(join(SRC, 'app/globals.css'), 'utf8');
  test('every customer layout wraps its page, not its header, in a ViewTransition that only link navigations animate', () => {
    for (const f of ['app/(site)/layout.tsx', 'app/dashboard/layout.tsx', 'app/draft/layout.tsx']) {
      const src = read(f);
      expect([f, /<ViewTransition default="none" enter=\{PAGE_TRANSITION\} exit=\{PAGE_TRANSITION\} update=\{PAGE_TRANSITION\}>\s*\{children\}\s*<\/ViewTransition>/.test(src)]).toEqual([f, true]);
      expect([f, src.indexOf('<AppHeader') < src.indexOf('<ViewTransition')]).toEqual([f, true]);
    }
    const { PAGE_TRANSITION, PAGE_NAV } = require('../src/lib/page-transition') as typeof import('../src/lib/page-transition');
    expect(PAGE_TRANSITION).toEqual({ [PAGE_NAV]: 'page', default: 'none' });
    expect(read('components/app-link.tsx')).toContain('<PageLink href={href}');
    expect(read('components/page-link.tsx')).toContain("...(reduce ? {} : { transitionTypes: TYPES })");
  });
  test('the header is a still group of its own', () => {
    expect(read('components/app-header.tsx')).toContain('<header className="site-header ');
    expect(css).toMatch(/\.site-header \.glass \{\s*view-transition-name: site-header;/);
    expect(css).toMatch(/::view-transition-group\(site-header\),\s*::view-transition-old\(site-header\),\s*::view-transition-new\(site-header\) \{\s*animation: none;/);
  });
  test('short, and only without reduced motion; reduced motion turns every view transition off', () => {
    const motion = /@media \(prefers-reduced-motion: no-preference\) \{\s*@view-transition \{[\s\S]*?\n\}/.exec(css)?.[0] ?? '';
    expect(motion).toContain('navigation: auto');
    for (const ms of [...motion.matchAll(/animation-duration: (\d+)ms/g)].map((m) => Number(m[1]))) expect(ms).toBeLessThanOrEqual(200);
    const reduce = /@media \(prefers-reduced-motion: reduce\) \{([\s\S]*?)\n\}/.exec(css)?.[1] ?? '';
    expect(reduce).toMatch(/::view-transition-group\(\*\),\s*::view-transition-old\(\*\),\s*::view-transition-new\(\*\) \{\s*animation: none !important;/);
  });
  test('Next turns smooth scrolling off while it moves to the top of a new page', () => {
    expect(read('app/layout.tsx')).toContain('data-scroll-behavior="smooth"');
  });
});

describe('a click on a page that reads the server answers at once', () => {
  test('each owner page has a loading skeleton of its own layout; /draft and the cheap profile shell do not', () => {
    const { existsSync } = require('node:fs') as typeof import('node:fs');
    expect(read('app/dashboard/(list)/loading.tsx')).toContain('<MyAgentsSkeleton');
    expect(read('app/dashboard/[id]/loading.tsx')).toContain('<CockpitSkeleton');
    expect(read('app/connect/loading.tsx')).toContain('<ConnectSkeleton');
    // Next shows the first loading file on the way down: one in app/dashboard would show the list before an agent's page.
    expect(existsSync(join(SRC, 'app/dashboard/loading.tsx'))).toBe(false);
    // /draft is only ever entered with a full load (components/app-link.tsx), where a skeleton would only stream first.
    expect(existsSync(join(SRC, 'app/draft/loading.tsx'))).toBe(false);
    // React keeps a shown skeleton up for at least 300 ms; the profile shell renders in a few.
    expect(existsSync(join(SRC, 'app/(site)/agents/[id]/loading.tsx'))).toBe(false);
  });
  test('every skeleton is announced, sits in its page column, keeps the fixed words and shows no spinner', () => {
    const { renderToStaticMarkup } = require('react-dom/server') as typeof import('react-dom/server');
    const { createElement } = require('react') as typeof import('react');
    const { copy } = require('../src/copy') as typeof import('../src/copy');
    const sk = require('../src/components/page-skeleton') as typeof import('../src/components/page-skeleton');
    const cases = [
      [sk.MyAgentsSkeleton, 'max-w-[680px]', [copy.myAgents.title]],
      [sk.CockpitSkeleton, 'max-w-[1400px]', [copy.agent.label, copy.agent.instruments.nextCheck, copy.agent.tabs.activity, copy.activity.title, copy.wallets.title, copy.agent.harness]],
      [sk.ConnectSkeleton, 'max-w-[680px]', [copy.connect.title, copy.connect.setupTitle, copy.connect.keysTitle]],
    ] as const;
    for (const [C, column, words] of cases) {
      const html = renderToStaticMarkup(createElement(C));
      expect(html).toContain('aria-busy="true"');
      expect(html).toContain('role="status"');
      expect(html).toContain('Loading…');
      expect(html).toContain(column);
      expect(html).not.toMatch(/spin/);
      // Nothing to click while it loads: the real links and buttons arrive with the page.
      expect(html).not.toMatch(/<(a|button|input)\b/);
      for (const w of words) expect(html).toContain(w.replace(/&/g, '&amp;').replace(/'/g, '&#x27;').replace(/"/g, '&quot;'));
    }
  });
});
