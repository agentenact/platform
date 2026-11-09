import { describe, expect, test } from 'bun:test';
import { createElement } from 'react';
import { renderToString } from 'react-dom/server';
import { DesktopSetup } from '../src/components/desktop-setup';
import { KEY_PLACEHOLDER, OWNER_MCP_URL } from '../src/lib/connect-config';
import { DESKTOP_APPS } from '../src/lib/desktop-setup';

const KEY = `ae_pat_${'A'.repeat(43)}`;

describe('desktop app setup on /connect', () => {
  test('Grok Bot comes first, then Claude, then the Codex app', () => {
    expect(DESKTOP_APPS.map((a) => a.id)).toEqual(['grok-bot', 'claude', 'codex']);
  });

  test('every app ends by asking in plain words, and every paste names our server', () => {
    for (const app of DESKTOP_APPS) {
      expect(app.steps.at(-1)?.scene.kind).toBe('ask');
      const pastes = app.steps.flatMap((s) => (s.paste ? [s.paste(KEY)] : []));
      expect(pastes.some((p) => p.includes(OWNER_MCP_URL) || p === KEY || p === `Bearer ${KEY}`)).toBe(true);
    }
  });

  test('the key is pasted with the Bearer scheme where the app sends the value as is', () => {
    const claude = DESKTOP_APPS.find((a) => a.id === 'claude')!;
    expect(claude.steps.map((s) => s.paste?.(KEY)).filter(Boolean)).toContain(`Bearer ${KEY}`);
    expect(claude.fallback!.lines(KEY)).toContain(`"AUTH": "Bearer ${KEY}"`);
    const codex = DESKTOP_APPS.find((a) => a.id === 'codex')!;
    expect(codex.steps[0]!.paste!(KEY)).toContain(`http_headers = { "Authorization" = "Bearer ${KEY}" }`);
  });

  test('the sketch never shows the whole key, the paste row does (inside data-advanced)', () => {
    const html = renderToString(createElement(DesktopSetup, { apiKey: KEY }));
    expect(html).toContain('role="tablist"');
    expect(html).toContain('aria-hidden="true"');
    const sketch = /<figure[\s\S]*?<\/figure>/.exec(html)![0];
    expect(sketch).not.toContain(KEY);
  });

  test('signed out, there is no key row to copy', () => {
    const html = renderToString(createElement(DesktopSetup, { apiKey: KEY_PLACEHOLDER }));
    expect(html).not.toContain('>Key<');
  });
});
