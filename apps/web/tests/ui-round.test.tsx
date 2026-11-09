import { describe, expect, test } from 'bun:test';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { StepRing } from '../src/components/step-ring';
import { SignInDialogBody, SignInDialog } from '../src/components/sign-in-dialog';
import { copy } from '../src/copy';
import { bannedWord } from '../src/lib/words';
import { readFileSync } from 'node:fs';
import { textOf } from './support/screens';

describe('step ring', () => {
  test('each state draws its own ring and only done shows the check', () => {
    for (const state of ['idle', 'working', 'asking', 'done'] as const) {
      const html = renderToStaticMarkup(createElement(StepRing, { state, n: 2 }));
      expect(html).toContain(`data-ring="${state}"`);
      expect(html).toContain('aria-hidden="true"');
      if (state === 'done') expect(html).toContain('data-tick');
      else {
        expect(html).not.toContain('data-tick');
        expect(textOf(html)).toContain('2');
      }
    }
  });
});

describe('sign-in dialog', () => {
  test('the body is the email step with a title; the expired line only when asked', () => {
    const plain = renderToStaticMarkup(createElement(SignInDialogBody, {}));
    expect(textOf(plain)).toContain(copy.signIn.title);
    expect(plain).toContain('sign-in-email');
    expect(textOf(plain)).not.toContain(copy.signIn.expired);
    const expired = renderToStaticMarkup(createElement(SignInDialogBody, { expired: true }));
    expect(textOf(expired)).toContain(copy.signIn.expired);
    expect(bannedWord(textOf(expired))).toBeNull();
  });

  test('on the server the dialog leaves only a marker (it opens in the browser, over the page)', () => {
    const html = renderToStaticMarkup(createElement(SignInDialog, { defaultOpen: true, expired: true }));
    expect(html).toContain('data-signin-dialog="expired"');
    expect(html).not.toContain('sign-in-email');
  });
});

describe('ring motion', () => {
  test('the working arc travels by dash offset, never by rotating the circle (rotation drifted off-center in Chrome)', () => {
    const css = readFileSync(new URL('../src/app/globals.css', import.meta.url), 'utf8');
    const travel = /@keyframes ring-travel \{([\s\S]*?)\n  \}/.exec(css)?.[1] ?? '';
    expect(travel).toContain('stroke-dashoffset');
    expect(travel).not.toContain('rotate');
    expect(css).not.toMatch(/\.ring-draw \{[^}]*transform-origin/);
  });
});
