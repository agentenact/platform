import { describe, expect, test } from 'bun:test';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { PathnameContext } from 'next/dist/shared/lib/hooks-client-context.shared-runtime';
import { AppHeader } from '../src/components/app-header';
import { Page } from '../src/components/page';
import { Button } from '../src/components/ui/button';
import { copy } from '../src/copy';
import { OWN_SHELL_SECTIONS } from '../src/lib/own-shell';
import { bannedWord } from '../src/lib/words';
import { textOf } from './support/screens';

const header = (me: Parameters<typeof AppHeader>[0]['me']) => renderToStaticMarkup(createElement(AppHeader, { me }));
const UI = join(import.meta.dir, '../src/components/ui');

describe('app header', () => {
  test('signed out: wordmark, Testnet pill, Explore, Sign in, no Sign out', () => {
    const html = header(null);
    const t = textOf(html);
    expect(t).toContain('Enact');
    expect(t).toContain('Testnet');
    expect(t).toContain('Explore');
    expect(t).toContain('Sign in');
    expect(t).not.toContain('Sign out');
    expect(html).toContain('href="/"');
    expect(html).toContain('href="/explore"');
    expect(html).toContain('href="/?signin=1"');
    // the brand seal is drawn from BRAND_HASH, inline
    expect(html).toMatch(/<a [^>]*href="\/"[^>]*><svg viewBox="0 0 200 200"/);
  });
  test("the site's links and the one call to action, all in this app except Karma", () => {
    const html = header(null);
    for (const href of ['/explore', '/market', '/verify', '/create#install', 'https://agentkarma.io', '/create']) expect(html).toContain(`href="${href}"`);
    expect(textOf(html).replace(/\s+/g, ' ')).toContain('Create an agent');
    expect(html).not.toContain('agentenact.io');
    expect(textOf(html)).not.toContain('Dashboard');
  });
  test('signed in with an agent: the email (not the agent name) labels the account, then My agents and Sign out', () => {
    const html = header({ email: 'kerem@example.com', agentName: 'XLM drop alert' });
    const t = textOf(html);
    expect(t).not.toContain('XLM drop alert');
    expect(t).toContain('kerem@example.com');
    expect(t).toContain('My agents');
    expect(t).toContain('Sign out');
    expect(t).not.toContain('Sign in');
    expect(html).toContain('href="/dashboard"');
    expect(html).toMatch(/<a [^>]*href="\/dashboard"[^>]*>Dashboard<\/a>/);
  });
  test('signed in without an agent: the email labels the account and My agent is absent', () => {
    const html = header({ email: 'kerem@example.com' });
    const t = textOf(html);
    expect(t).toContain('kerem@example.com');
    expect(t).toContain('Sign out');
    expect(t).not.toContain('My agent');
    expect(t).not.toContain('Dashboard');
  });
  test('on /draft the Sign in link is left out so the draft is not lost', () => {
    const on = (path: string) => renderToStaticMarkup(createElement(PathnameContext.Provider, { value: path }, createElement(AppHeader, { me: null })));
    expect(on('/draft')).not.toContain('signin=1');
    expect(textOf(on('/draft'))).toContain('Explore');
    expect(on('/')).toContain('href="/?signin=1"');
    expect(on('/dashboard')).toContain('href="/?signin=1"');
  });
  test('the wordmark and the account button are at least 44px tall', () => {
    expect(header(null)).toContain('min-h-11');
    expect(header({ email: 'a@b.co' })).toContain('h-11');
  });
  test('header copy is plain words', () => {
    expect(bannedWord(textOf(header({ email: 'a@b.co', agentName: 'x' })))).toBeNull();
    expect(bannedWord(textOf(header(null)))).toBeNull();
    expect(bannedWord(Object.values(copy.shell).join(' '))).toBeNull();
  });
});

describe('page column', () => {
  test('flow is 680px, wide is 5xl', () => {
    expect(renderToStaticMarkup(createElement(Page, { children: 'x' }))).toContain('max-w-[680px]');
    expect(renderToStaticMarkup(createElement(Page, { width: 'wide', children: 'x' }))).toContain('max-w-5xl');
  });
});

describe('button set', () => {
  const html = (p: Record<string, unknown>) => renderToStaticMarkup(createElement(Button, p, 'Go'));
  test('primary is ink on paper, never white text', () => {
    const m = html({ variant: 'primary' });
    expect(m).not.toContain('text-white');
    expect(m).toContain('bg-fg');
    expect(m).toContain('text-bg');
  });
  test('sizes are 48px (lg) and 44px (default)', () => {
    expect(html({ size: 'lg' })).toContain('h-12');
    expect(html({})).toContain('h-11');
  });
  test('quiet and ghost exist', () => {
    expect(html({ variant: 'quiet' })).toContain('border-line');
    expect(html({ variant: 'ghost' })).toContain('data-variant="ghost"');
  });
});

describe('light only', () => {
  test('no dark: class in components/ui', () => {
    for (const f of readdirSync(UI)) expect(readFileSync(join(UI, f), 'utf8')).not.toContain('dark:');
  });
  test('no white text on the accent fill anywhere in components', () => {
    const dir = join(import.meta.dir, '../src/components');
    for (const f of readdirSync(dir, { recursive: true }) as string[]) {
      if (!f.endsWith('.tsx')) continue;
      const src = readFileSync(join(dir, f), 'utf8');
      expect(/bg-accent[^"'`]*text-white/.test(src)).toBe(false);
    }
  });
});

describe('layout', () => {
  const src = readFileSync(join(import.meta.dir, '../src/app/layout.tsx'), 'utf8');
  const layout = (f: string) => readFileSync(join(import.meta.dir, '../src/app', f), 'utf8');
  test('every customer layout wraps children with the one header and the one footer', () => {
    for (const f of ['(site)/layout.tsx', 'dashboard/layout.tsx', 'draft/layout.tsx', 'connect/layout.tsx']) {
      const l = layout(f);
      expect([f, l.includes('<AppHeader'), l.includes('{children}'), l.includes('<SiteFooter')]).toEqual([f, true, true, true]);
    }
  });
  test('every customer page directory has a layout, so no page renders without the header (only /api, /auth, /email and the sections with their own shell do)', () => {
    const { readdirSync, existsSync } = require('node:fs') as typeof import('node:fs');
    const app = join(import.meta.dir, '../src/app');
    for (const d of readdirSync(app, { withFileTypes: true })) {
      if (!d.isDirectory() || ['api', 'auth', 'email', 'actions', ...OWN_SHELL_SECTIONS].includes(d.name)) continue;
      expect([d.name, existsSync(join(app, d.name, 'layout.tsx'))]).toEqual([d.name, true]);
    }
  });
  test('the root layout reads nothing from the request, so public pages can be static', () => {
    expect(src).toContain('{children}');
    expect(src).not.toMatch(/headers\(|cookies\(|getHeaderMe|getMe|supabase/);
  });
  test('the public layout has no session; the owner pages hand the header the visitor the server knows', () => {
    expect(layout('(site)/layout.tsx')).not.toMatch(/getHeaderMe|getMe|cookies|headers\(/);
    expect(layout('(site)/layout.tsx')).toMatch(/<AppHeader \/>/);
    for (const f of ['dashboard/layout.tsx', 'draft/layout.tsx', 'connect/layout.tsx']) expect(layout(f)).toContain('<AppHeader me={me} />');
  });
  test('the root 404 and error pages bring the header and footer, but not in a section with its own shell', () => {
    for (const f of ['not-found.tsx', 'error.tsx']) {
      const l = layout(f);
      expect([f, /<SiteChrome>\s*<AppHeader \/>\s*<\/SiteChrome>/.test(l), /<SiteChrome>\s*<SiteFooter \/>\s*<\/SiteChrome>/.test(l)]).toEqual([f, true, true]);
    }
  });
  test('the homepage and the site pages draw no site header or footer of their own', () => {
    for (const f of ['components/home-screen.tsx', 'components/hero.tsx', 'app/(site)/explore/page.tsx', 'app/(site)/verify/page.tsx', 'app/(site)/create/page.tsx', 'app/(site)/agents/[id]/page.tsx']) {
      const src = readFileSync(join(import.meta.dir, '../src', f), 'utf8');
      expect([f, /<(AppHeader|SiteHeader|SiteFooter)\b|site-header/.test(src)]).toEqual([f, false]);
    }
  });
  test('dark only: no theme script, toggle or data-theme', () => {
    expect(src).not.toContain('THEME_SCRIPT');
    expect(src).not.toContain('suppressHydrationWarning');
    const css = readFileSync(join(import.meta.dir, '../src/app/globals.css'), 'utf8');
    expect(css).not.toContain('data-theme');
    expect(css).toContain('color-scheme: dark');
  });
  test('not-found, error, icons and sign-out exist', () => {
    const app = join(import.meta.dir, '../src/app');
    for (const f of ['not-found.tsx', 'error.tsx', 'icon.svg', 'apple-icon.png', 'actions/session.ts']) expect(readdirSync(app, { recursive: true }) as string[]).toContain(f);
    expect(readFileSync(join(app, 'actions/session.ts'), 'utf8')).toContain('signOutAction');
  });
});

describe('header account', () => {
  const { createGetHeaderMe } = require('../src/server/account') as typeof import('../src/server/account');
  test('signed out gives null; signed in carries email and agent name', async () => {
    expect(await createGetHeaderMe({ email: async () => undefined, me: async () => null })()).toBeNull();
    expect(await createGetHeaderMe({ email: async () => 'a@b.co', me: async () => ({ agent: { id: '1', name: 'XLM', status: 'active' }, agents: [], agentLimit: null }) })()).toEqual({ email: 'a@b.co', agentName: 'XLM' });
  });
  test('a failing api still shows the email', async () => {
    const boom = async () => {
      throw new Error('x');
    };
    expect(await createGetHeaderMe({ email: async () => 'a@b.co', me: boom })()).toEqual({ email: 'a@b.co' });
  });
});

describe('account menu', () => {
  test('trigger is a collapsed button named by its visible label, no aria-label override', () => {
    const html = header({ email: 'kerem@example.com', agentName: 'XLM drop alert' });
    const trigger = html.match(/<button[^>]*aria-expanded="false"[^>]*><span class="sr-only">Your account: <\/span>/)?.[0];
    expect(trigger).toBeDefined();
    expect(trigger).not.toContain('aria-label');
    expect(html).toContain('truncate');
  });
  test('the Sign in link size is not dead css: .btn lives in a layer', () => {
    const css = readFileSync(join(import.meta.dir, '../src/app/globals.css'), 'utf8');
    expect(css).toMatch(/@layer components \{[\s\S]*\.btn \{/);
  });
});

describe('sign out', () => {
  const { createSignOut } = require('../src/server/sign-out') as typeof import('../src/server/sign-out');
  test('signs out this device only, then redirects to /', async () => {
    const calls: string[] = [];
    const run = createSignOut({
      client: async () => ({ auth: { signOut: async (o) => void calls.push(`signOut:${o.scope}`) } }),
      redirect: ((to: string) => {
        calls.push(`redirect:${to}`);
        throw new Error('NEXT_REDIRECT');
      }) as never,
    });
    await expect(run()).rejects.toThrow('NEXT_REDIRECT');
    expect(calls).toEqual(['signOut:local', 'redirect:/']);
  });
  test('the action uses it and error.tsx takes no props', () => {
    const src = readFileSync(join(import.meta.dir, '../src/app/actions/session.ts'), 'utf8');
    expect(src).toContain('createSignOut');
    expect(readFileSync(join(import.meta.dir, '../src/app/error.tsx'), 'utf8')).toContain('function ErrorPage()');
  });
});

describe('stylesheet', () => {
  const css = readFileSync(join(import.meta.dir, '../src/app/globals.css'), 'utf8');
  test('scroll targets clear the sticky header and smooth scroll is opt-in', () => {
    expect(css).toMatch(/scroll-padding-top:\s*5\.5rem/);
    expect(css).toMatch(/@media \(prefers-reduced-motion: no-preference\) \{\s*html \{\s*scroll-behavior: smooth/);
    expect(css.match(/scroll-behavior: smooth/g)).toHaveLength(1);
  });
  test('one reduced-motion block turns transitions and animations off', () => {
    const m = /@media \(prefers-reduced-motion: reduce\) \{([\s\S]*?)\n\}/.exec(css);
    expect(m?.[1]).toContain('transition-duration: 0s');
    expect(m?.[1]).toContain('animation: none');
    expect(css.match(/prefers-reduced-motion: reduce/g)).toHaveLength(1);
  });
  test('no dead rules', () => {
    // .btn-accent came back with the site: the live proof's "Try a forged copy" button uses it.
    for (const dead of ['.panel-ink', '.object {']) expect(css).not.toContain(dead);
  });
});
