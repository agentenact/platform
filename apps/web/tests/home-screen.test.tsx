import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { renderToStaticMarkup } from 'react-dom/server';
import { HomeView, signinMode } from '../src/components/home-screen';
import type { CapturedProof } from '../src/lib/proof-types';
import { clampPrompt, PROMPT_MAX } from '../src/lib/prompt';
import { signinFromSearch, signinToOpen } from '../src/lib/signin-mode';
import { createGetMe } from '../src/server/me';
import { textOf } from './support/screens';

const root = join(import.meta.dir, '..');
const proof = JSON.parse(readFileSync(join(root, 'public/proofs/latest.json'), 'utf8')) as CapturedProof;

const run = async () => renderToStaticMarkup(<HomeView proof={proof} verifierSrc="/verifier/agentenact.js?v=test" />);
/** What the browser decides for an address bar and a visitor (null = signed out, undefined = not known yet). */
const opens = (search: string, me: Parameters<typeof signinToOpen>[1]) => signinToOpen(signinFromSearch(new URLSearchParams(search)), me);
const OWNER = { email: 'a@b.co', agentName: 'n' };

describe('homepage', () => {
  test("holds the site's sections in order: hero, numbers, network agents, ready agents, how it works, live proof", async () => {
    const html = await run();
    expect(html.match(/<h1/g)).toHaveLength(1);
    expect(html).toContain('id="create"');
    const at = (s: string) => {
      const i = html.indexOf(s);
      expect([s, i >= 0]).toEqual([s, true]);
      return i;
    };
    const order = [at('class="night'), at('/create?template=xlm-drop'), at('id="verify"')];
    expect([...order].sort((a, b) => a - b)).toEqual(order);
  });
  test('the ask posts to /draft in this app and never to another origin', async () => {
    const html = await run();
    expect(html).toMatch(/<form[^>]*action="\/draft"/);
    expect(html).toContain('name="prompt"');
    expect(html).not.toContain('app.agentenact.io');
  });
  test('repeated signin values are ignored', () => {
    expect(opens('signin=a&signin=b', null)).toBeUndefined();
    expect(opens('signin=1&signin=1', null)).toBeUndefined();
  });
  test('signin=expired opens the dialog, saying the link expired', () => {
    expect(opens('signin=expired', null)).toBe('expired');
  });
  test('signin=1 opens the dialog without the expired line', () => {
    expect(opens('signin=1', null)).toBe('open');
  });
  test('no signin opens nothing', () => {
    expect(opens('', null)).toBeUndefined();
    expect(opens('', OWNER)).toBeUndefined();
  });
  test('a signed-in owner sees the public homepage: no redirect, no sign-in dialog', async () => {
    expect(opens('signin=1', OWNER)).toBeUndefined();
    expect(opens('signin=expired', OWNER)).toBeUndefined();
    expect(textOf(await run())).toContain('Describe your agent');
  });
  test('a signed-in user with no agent never sees the sign-in dialog', () => {
    expect(opens('signin=open', { email: 'a@b.co' })).toBeUndefined();
    expect(opens('signin=1', { email: 'a@b.co' })).toBeUndefined();
  });
  test('nothing opens before the visitor is known, so a signed-in visitor never sees it flash', () => {
    expect(opens('signin=1', undefined)).toBeUndefined();
  });
  test('the page reads nothing from the request: no session, no search params on the server', () => {
    const page = readFileSync(join(root, 'src/app/(site)/page.tsx'), 'utf8');
    expect(page).not.toMatch(/searchParams|getMe|cookies|headers\(/);
    expect(readFileSync(join(root, 'src/components/home-screen.tsx'), 'utf8')).not.toMatch(/getMe|searchParams/);
  });
});

describe('signinMode', () => {
  test('maps the query value; anything else is ignored', () => {
    expect(signinMode('expired')).toBe('expired');
    expect(signinMode('1')).toBe('open');
    expect(signinMode('yes')).toBeUndefined();
    expect(signinMode(undefined)).toBeUndefined();
    expect(signinMode(['1', '1'])).toBeUndefined();
  });
});

describe('prompt cap', () => {
  test('a 501-character prompt is cut to 500', () => {
    expect(clampPrompt('a'.repeat(501))).toHaveLength(PROMPT_MAX);
    expect(PROMPT_MAX).toBe(500);
  });
});

describe('createGetMe', () => {
  const ok = (json: unknown, status = 200) => createGetMe({ token: async () => 't', api: async () => ({ status, json }) });
  test('no token: signed out, the api is not called', async () => {
    let called = false;
    const g = createGetMe({ token: async () => undefined, api: async () => ((called = true), { status: 200, json: {} }) });
    expect(await g()).toBeNull();
    expect(called).toBe(false);
  });
  test('reads the agent from /api/me', async () => {
    const a = { id: '3f2b8c1e-5a4d-4e6f-9b7a-1c2d3e4f5a6b', name: 'x', status: 'active' };
    const b = { id: '4f2b8c1e-5a4d-4e6f-9b7a-1c2d3e4f5a6b', name: 'y', status: 'paused' };
    expect(await ok({ agent: a, agents: [a, b], agentLimit: 3 })()).toEqual({ agent: a, agents: [a, b], agentLimit: 3 });
    // An api from before several agents sends only `agent` and no limit.
    expect(await ok({ agent: a })()).toEqual({ agent: a, agents: [a], agentLimit: null });
    expect(await ok({ agent: null })()).toEqual({ agent: null, agents: [], agentLimit: null });
    // A malformed entry is dropped, never handed on.
    expect(await ok({ agents: [{ id: 'nope', name: 'x', status: 'active' }, b] })()).toEqual({ agent: b, agents: [b], agentLimit: null });
  });
  test('an api failure shows the page instead of an error page', async () => {
    expect(await ok(null, 502)()).toBeNull();
    expect(await createGetMe({ token: async () => 't', api: async () => { throw new Error('x'); } })()).toBeNull();
  });
});
