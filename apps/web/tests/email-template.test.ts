import { describe, expect, test } from 'bun:test';
import { GET as confirmRoute } from '../src/app/email/confirm-signup/route';
import { GET as magicRoute } from '../src/app/email/magic-link/route';
import { PUBLIC } from '../src/lib/public-config';
import { bannedWord } from '../src/lib/words';
import { CONFIRM_SIGNUP_SUBJECT, MAGIC_LINK_SUBJECT } from '../src/server/email-templates';
import { confirmSignIn } from '../src/server/auth-confirm';

const mails = [
  { name: 'magic-link', get: magicRoute, button: 'Sign in' },
  { name: 'confirm-signup', get: confirmRoute, button: 'Confirm my email' },
] as const;

const visibleText = (html: string) => html.replace(/<title>.*?<\/title>/s, '').replace(/<[^>]+>/g, ' ');

for (const m of mails) {
  describe(`/email/${m.name}`, () => {
    test('is html, carries the GoTrue variables, and links only to the app host', async () => {
      const r = m.get();
      expect(r.headers.get('content-type')).toContain('text/html');
      const html = await r.text();
      expect(html).toContain('href="{{ .RedirectTo }}&token_hash={{ .TokenHash }}&type=email"');
      expect(html).toContain(`>${m.button}</a>`);
      const urls = html.match(/https?:\/\/[^\s"'<>)]+/g) ?? [];
      expect(urls.length).toBeGreaterThan(0);
      for (const u of urls) expect(new URL(u).origin).toBe(PUBLIC.appOrigin);
      expect(html).toContain(`src="${PUBLIC.appOrigin}/brand/seal-night-96.png"`);
    });
    test('passes the banned-words scan', async () => {
      expect(bannedWord(visibleText(await m.get().text()))).toBeNull();
    });
    test('has no script and no external stylesheet', async () => {
      const html = (await m.get().text()).toLowerCase();
      expect(html).not.toContain('<script');
      expect(html).not.toContain('<link');
      expect(html).not.toContain('<style');
      expect(html).not.toContain('@import');
      expect(html).not.toMatch(/\son[a-z]+=/);
    });
  });
}

test('the subjects are plain', () => {
  for (const s of [MAGIC_LINK_SUBJECT, CONFIRM_SIGNUP_SUBJECT]) {
    expect(bannedWord(s)).toBeNull();
    expect(s).not.toMatch(/[{}<>]/);
  }
  expect(MAGIC_LINK_SUBJECT).toBe('Your link to AgentEnact');
});

test('the emailed link type is one /auth/confirm accepts', async () => {
  const calls: unknown[] = [];
  const r = await confirmSignIn(new URL(`${PUBLIC.appOrigin}/auth/confirm?next=%2Fdraft&token_hash=h&type=email`), {
    verifyOtp: async (a) => (calls.push(a), { error: null }),
  });
  expect(calls).toEqual([{ token_hash: 'h', type: 'email' }]);
  expect(r.headers.get('location')).toBe(`${PUBLIC.appOrigin}/draft`);
});
