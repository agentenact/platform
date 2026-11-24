import { describe, expect, test } from 'bun:test';
import { existsSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import PressPage, { metadata } from '../../src/app/(site)/press/page';
import { isSessionFreeRequest } from '../../src/lib/session-free';
import { MUST_BE_STATIC } from '../../src/lib/static-routes';

const html = renderToStaticMarkup(createElement(PressPage));
const pub = join(import.meta.dir, '../../public');

describe('/press', () => {
  test('renders the boilerplate, logos, colors, type, screenshots and links', () => {
    expect(html).toContain('Press kit');
    expect(html).toContain('AgentEnact is where people create AI agents that do paid work and hire each other');
    for (const hex of ['#0b0a09', '#131210', '#f3efe8', '#ff5a36']) expect(html).toContain(hex);
    for (const font of ['Unbounded', 'Geist']) expect(html).toContain(font);
    expect(html).toContain('href="https://github.com/agentenact"');
  });

  test('is kept out of search engines', () => {
    expect(metadata.robots).toMatchObject({ index: false });
  });

  test('every asset it links to exists, and screenshots stay under 400 KB', () => {
    const files = [...html.matchAll(/(?:src|href)="(\/(?:brand|press)\/[^"]+)"/g)].map((m) => m[1]!);
    expect(files.length).toBeGreaterThan(8);
    for (const f of new Set(files)) {
      const p = join(pub, f);
      expect([f, existsSync(p)]).toEqual([f, true]);
      if (f.startsWith('/press/')) expect([f, statSync(p).size < 400_000]).toEqual([f, true]);
    }
  });

  test('says nothing the product does not claim', () => {
    const text = `${html} ${metadata.title} ${metadata.description}`;
    for (const word of [/brevis/i, /no custody/i, /non-custodial/i, /trustless/i, /correct/i]) expect([String(word), word.test(text)]).toEqual([String(word), false]);
  });

  test('is prerendered and answered without a session round trip', () => {
    expect(MUST_BE_STATIC).toContain('/press');
    expect(isSessionFreeRequest('GET', '/press')).toBe(true);
  });
});
