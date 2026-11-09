import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { SignInView } from '../src/components/sign-in';
import { copy } from '../src/copy';
import { nextFor, retryOnce, signInFailure } from '../src/lib/sign-in-next';
import { bannedWord } from '../src/lib/words';
import { textOf } from './support/screens';

const html = (phase: 'idle' | 'sending' | 'sent', error?: string) => renderToStaticMarkup(createElement(SignInView, { phase, ...(error ? { error } : {}) }));

describe('SignInCard', () => {
  test('stores nothing in browser storage', () => {
    for (const f of ['src/components/sign-in.tsx', 'src/lib/supabase/browser.ts', 'src/lib/supabase/server.ts']) {
      expect(readFileSync(join(import.meta.dir, '..', f), 'utf8')).not.toMatch(/localStorage|sessionStorage|indexedDB/);
    }
  });
  test('shows the email field and "Send me a link"', () => {
    const out = html('idle');
    expect(out).toContain('type="email"');
    expect(out).toContain(copy.signIn.send);
  });
  test('is built from the panel\'s own field and button, stacked, with no heading of its own', () => {
    const out = html('idle');
    // Raw unstyled elements made a bare box with the label and button squeezed beside it.
    expect(out).toMatch(/<input[^>]*data-slot="input"/);
    expect(out).toMatch(/<button[^>]*data-slot="button"/);
    expect(out).toMatch(/<label[^>]*class="[^"]*\bblock\b/);
    // Every place that shows the card already titles it ("Create your agent on testnet", "Sign in to keep drafting").
    expect(out).not.toContain('<h2');
  });
  test('shows the check-your-email state', () => {
    const out = html('sent');
    expect(out).toContain('Check your email');
    expect(out).not.toContain('type="email"');
  });
  test('shows a plain error', () => {
    expect(html('idle', copy.signIn.badEmail)).toContain(copy.signIn.badEmail);
  });
  test('the redirect carries the handoff id through /auth/confirm?next=', () => {
    const src = readFileSync(join(import.meta.dir, '../src/components/sign-in.tsx'), 'utf8');
    expect(src).toContain('/auth/confirm?next=${encodeURIComponent(next)}');
    expect(src).toContain('nextFor({ parkedId, handoff, prompt,');
  });
});

const NAME = 'XLM drop alert';
const create = (phase: 'idle' | 'sending' | 'sent', extra: Record<string, unknown> = {}) =>
  renderToStaticMarkup(createElement(SignInView, { phase, create: { name: NAME, onBack: () => {} }, ...extra }));

describe('the sign-in step inside the create card', () => {
  test('asks for the email first, with the way back and nothing of the draft', () => {
    const out = create('idle');
    const t = textOf(out);
    expect(t).toContain(`Create ${NAME}`);
    expect(out).toMatch(/<h2[^>]*>First, your email<\/h2>/);
    expect(t).toContain('We send you a link. Open it and you are back on your draft. Press Create, then approve three times with your screen lock.');
    expect(out).toContain('type="email"');
    expect(t).toContain('Send me a link');
    expect(t).toContain('← Back to my draft');
    expect(t).not.toContain('Try it');
    expect(out).not.toContain('data-param');
  });
  test('the first screen card has no create eyebrow and no step heading', () => {
    const out = html('idle');
    expect(textOf(out)).not.toContain('Create ');
    expect(out).not.toContain('First, your email');
    expect(textOf(out)).not.toContain('Back to my draft');
  });
  test('the draft name is shown as plain text, never as markup', () => {
    const out = renderToStaticMarkup(createElement(SignInView, { phase: 'idle', create: { name: '<img src=x onerror=1>' } }));
    expect(out).not.toContain('<img');
    expect(out).toContain('&lt;img');
  });
  test('sent: the address, the saved line only when a draft was parked, a resend that waits, another email', () => {
    const out = create('sent', { email: 'kerem@example.com', saved: true, resendIn: 30 });
    const t = textOf(out);
    expect(t).toContain('Check your email');
    expect(t).toContain(`Create ${NAME}`);
    expect(t).toContain('We sent a link to kerem@example.com.');
    expect(t).toContain('Your draft is saved; you can open the link on any device.');
    expect(out).toMatch(/<button[^>]*disabled=""[^>]*>[^<]*Send again[^<]*\(in 30 s\)/);
    expect(t).toContain('Use a different email');
    expect(out).not.toContain('type="email"');
    const unsaved = textOf(create('sent', { email: 'kerem@example.com', saved: false, resendIn: 12 }));
    expect(unsaved).toContain('We sent a link to kerem@example.com.');
    expect(unsaved).not.toContain('draft is saved');
    expect(unsaved).toContain('(in 12 s)');
  });
  test('the resend button is live once the wait is over', () => {
    const out = create('sent', { email: 'a@b.co', resendIn: 0 });
    expect(out).toMatch(/<button[^>]*>Send again<\/button>/);
    expect(out).not.toMatch(/<button[^>]*\sdisabled=""/);
  });
  test('the address is echoed as text only', () => {
    const out = create('sent', { email: '"><script>x</script>@a.co' });
    expect(out).not.toContain('<script>');
  });
  test('the sent state also fits the first screen card (no create eyebrow)', () => {
    const out = renderToStaticMarkup(createElement(SignInView, { phase: 'sent', email: 'a@b.co', resendIn: 5 }));
    expect(textOf(out)).toContain('We sent a link to a@b.co.');
    expect(textOf(out)).not.toContain('Create ');
  });
  test('every line is plain words', () => {
    for (const f of [create('idle'), create('sent', { email: 'a@b.co', saved: true, resendIn: 3 })]) expect(bannedWord(textOf(f))).toBeNull();
  });
  test('resend and the link carry the same path: one send function, the draft parked once', () => {
    const src = readFileSync(join(import.meta.dir, '../src/components/sign-in.tsx'), 'utf8');
    expect(src).toContain('onResend');
    expect(src).toContain('onChangeEmail');
    expect(src.match(/createParker\(handoffAction\)/g)).toHaveLength(1);
    expect(src.match(/park\(draft, to\)/g)).toHaveLength(1);
    expect(src.match(/signInWithOtp\(/g)).toHaveLength(1);
  });
  test('the typed email is sent with the park call, and never logged', () => {
    const src = readFileSync(join(import.meta.dir, '../src/components/sign-in.tsx'), 'utf8');
    expect(readFileSync(join(import.meta.dir, '../src/lib/sign-in-park.ts'), 'utf8')).toMatch(/handoff\(draft, to\)/);
    expect(src).toMatch(/park\(draft, to\)/);
    expect(src).not.toMatch(/console\./);
    const act = readFileSync(join(import.meta.dir, '../src/app/actions/builder.ts'), 'utf8');
    expect(act).toContain('handoff(draft, email)');
    expect(act).not.toMatch(/console\./);
    const srv = readFileSync(join(import.meta.dir, '../src/server/builder-actions.ts'), 'utf8');
    expect(srv).not.toMatch(/log\([^)]*email/);
  });
});

describe('where the link lands (nextFor)', () => {
  const id = 'AbCdEfGhIjKlMnOpQrStUv';
  test('a parked draft wins, then a waiting handoff, then the prompt, then plain /draft', () => {
    expect(nextFor({ parkedId: id, handoff: 'x'.repeat(22), prompt: 'watch xlm' })).toBe(`/draft?h=${id}`);
    expect(nextFor({ handoff: id, prompt: 'watch xlm' })).toBe(`/draft?h=${id}`);
    expect(nextFor({ prompt: 'watch xlm' })).toBe('/draft?prompt=watch%20xlm');
    expect(nextFor({})).toBe('/draft');
    expect(nextFor({ prompt: '   ' })).toBe('/draft');
  });
  test('intent=create rides only on a /draft?h= result', () => {
    expect(nextFor({ parkedId: id, intent: 'create' })).toBe(`/draft?h=${id}&intent=create`);
    expect(nextFor({ handoff: id, intent: 'create' })).toBe(`/draft?h=${id}&intent=create`);
    expect(nextFor({ prompt: 'watch xlm', intent: 'create' })).toBe('/draft?prompt=watch%20xlm');
    expect(nextFor({ intent: 'create' })).toBe('/draft');
    expect(nextFor({ parkedId: id })).toBe(`/draft?h=${id}`);
  });
  test('the whole next stays one same-origin path with the one id and one intent after the confirm guard', () => {
    const next = nextFor({ parkedId: id, intent: 'create' });
    const u = new URL(next, 'http://x.test');
    expect(u.pathname).toBe('/draft');
    expect([...u.searchParams.keys()]).toEqual(['h', 'intent']);
  });
  test('the prompt is encoded so it cannot add parameters or break out of next=', () => {
    const next = nextFor({ prompt: 'a&h=evil #x?y' });
    expect(next).toBe('/draft?prompt=a%26h%3Devil%20%23x%3Fy');
    expect(new URL(next, 'http://x.test').searchParams.get('prompt')).toBe('a&h=evil #x?y');
    expect(new URL(next, 'http://x.test').searchParams.has('h')).toBe(false);
  });
  test('the copy only promises what the link does', () => {
    expect(copy.draft.kept).not.toMatch(/browser/i);
    expect(copy.signIn.saved).not.toMatch(/waiting|this device/i);
  });
});

describe('signInFailure', () => {
  test('a 429 says wait, a 504 says slow, a service failure says busy, an unknown 4xx stays generic', () => {
    expect(signInFailure({ status: 429 })).toBe('tooSoon');
    expect(signInFailure({ code: 'over_email_send_rate_limit' })).toBe('tooSoon');
    expect(signInFailure({ status: 504, code: 'request_timeout' })).toBe('slow');
    expect(signInFailure({ status: 504 })).toBe('slow');
    // GoTrue failing to reach its database answers 500; auth-js turns 5xx and 52x into AuthRetryableFetchError.
    expect(signInFailure({ status: 500, code: 'unexpected_failure' })).toBe('busy');
    expect(signInFailure({ status: 500, name: 'AuthRetryableFetchError' })).toBe('busy');
    expect(signInFailure({ status: 502 })).toBe('busy');
    expect(signInFailure({ status: 503 })).toBe('busy');
    expect(signInFailure({ status: 522 })).toBe('busy');
    expect(signInFailure({ status: 0, name: 'AuthRetryableFetchError' })).toBe('busy');
    expect(signInFailure({ status: 400, code: 'validation_failed' })).toBe('generic');
    expect(signInFailure({})).toBe('generic');
  });

  test('only a fast service failure is retried on its own', () => {
    expect(retryOnce('busy')).toBe(true);
    expect(retryOnce('slow')).toBe(false);
    expect(retryOnce('tooSoon')).toBe(false);
    expect(retryOnce('generic')).toBe(false);
  });

  test('the card retries once, then shows the busy message, never the generic one for a 5xx', () => {
    const src = readFileSync(join(import.meta.dir, '..', 'src/components/sign-in.tsx'), 'utf8');
    expect(src).toContain('retryOnce(signInFailure(err))');
    expect(src).toContain("why === 'generic' ? copy.errors.generic : copy.signIn[why]");
    // An unnamed failure carries its status and code, so a screenshot is enough to tell which one it was.
    expect(src).toContain("why === 'busy' || why === 'generic'");
  });

  test('the wait messages pass the words check', () => {
    expect(bannedWord(copy.signIn.tooSoon)).toBeNull();
    expect(bannedWord(copy.signIn.slow)).toBeNull();
    expect(bannedWord(copy.signIn.busy)).toBeNull();
  });
});
