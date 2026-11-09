import { describe, expect, test } from 'bun:test';
import { hasSessionCookie, signedOutRedirect } from '../src/lib/signed-out';

describe('a signed-out visit to the owner pages', () => {
  test('goes home before anything renders', () => {
    expect(signedOutRedirect('/dashboard', [])).toBe('/');
    expect(signedOutRedirect('/dashboard/0b6f1c2e-0000-4000-8000-000000000000/chat', ['other'])).toBe('/');
  });
  test('a session cookie, whole or split, lets the page decide', () => {
    expect(signedOutRedirect('/dashboard', ['sb-abc-auth-token'])).toBeNull();
    expect(signedOutRedirect('/dashboard', ['sb-abc-auth-token.0', 'sb-abc-auth-token.1'])).toBeNull();
    expect(hasSessionCookie(['sb-abc-auth-token-code-verifier'])).toBe(false);
  });
  test('other pages are not touched', () => {
    expect(signedOutRedirect('/', [])).toBeNull();
    expect(signedOutRedirect('/draft', [])).toBeNull();
    expect(signedOutRedirect('/dashboards', [])).toBeNull();
    expect(signedOutRedirect('/connect', [])).toBeNull();
    expect(signedOutRedirect('/dashboard/pause', [])).toBeNull();
    expect(signedOutRedirect('/dashboard/pause/confirm', [])).toBeNull();
  });
});
