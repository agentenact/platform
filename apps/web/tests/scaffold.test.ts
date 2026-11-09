import postcss from 'postcss';
import { describe, expect, test } from 'bun:test';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { PUBLIC } from '../src/lib/public-config';

const root = join(import.meta.dir, '..');
const css = readFileSync(join(root, 'src/app/globals.css'), 'utf8');

// Night (the site's design since 2026-10-26): ground, text, wax and danger.
const TOKENS = {
  ground: '#0b0a09',
  text: '#f3efe8',
  wax: '#ff5a36',
  danger: '#ff5c8a',
} as const;

function walk(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const p = join(dir, name);
    return statSync(p).isDirectory() ? walk(p) : [p];
  });
}
const sources = walk(join(root, 'src')).filter((f) => /\.(ts|tsx)$/.test(f));

describe('design tokens', () => {
  test('match the literal values', () => {
    for (const [name, value] of Object.entries(TOKENS)) {
      expect(css).toContain(`--${name}: ${value}`);
    }
  });
});

describe('public-config', () => {
  test('holds only public values', () => {
    expect(Object.keys(PUBLIC).some((k) => /secret/i.test(k))).toBe(false);
    expect(JSON.stringify(PUBLIC)).not.toContain('PANEL_SECRET');
    const payload = JSON.parse(Buffer.from(PUBLIC.supabaseAnonKey.split('.')[1]!, 'base64url').toString());
    expect(payload.role).toBe('anon');
  });
  test('pins the agreed endpoints', () => {
    expect(PUBLIC.apiUrl).toBe('https://api.agentenact.io');
    expect(PUBLIC.appOrigin).toBe('https://agentenact.io');
    expect(PUBLIC.sorobanRpc).toBe('https://soroban-testnet.stellar.org');
    expect(PUBLIC.uriPrefix).toBe('https://agentenact.io/a/');
    expect(PUBLIC.rpId).toBe('agentenact.io');
  });
});

describe('deploy files', () => {
  const yaml = readFileSync(join(root, 'servel.yaml'), 'utf8');
  test('servel.yaml has no secrets block', () => {
    expect(yaml).not.toMatch(/^\s*secrets\s*:/m);
    expect(yaml).toMatch(/^name: agentenact-web$/m);
    expect(yaml).toMatch(/^domain: agentenact\.io$/m);
    // The old host stays only to redirect, and the origin is the new one (anything else turns the redirect off).
    expect(yaml).toMatch(/^domains:\n {4}- agentenact\.io\n {4}- app\.agentenact\.io$/m);
    expect(yaml).toMatch(/^ {4}APP_ORIGIN: https:\/\/agentenact\.io$/m);
  });
  test('.gitignore and .dockerignore ignore .servel/', () => {
    for (const f of ['.gitignore', '.dockerignore']) {
      expect(readFileSync(join(root, f), 'utf8').split('\n').map((l) => l.trim())).toContain('.servel/');
    }
  });
});

describe('server boundary', () => {
  test('PANEL_SECRET and process.env appear only under src/server/', () => {
    const offenders = sources
      .filter((f) => !relative(join(root, 'src'), f).startsWith('server/'))
      .filter((f) => {
        const src = readFileSync(f, 'utf8');
        // lib/snippets.ts holds the /create code samples: text shown to developers for their own apps, never executed
        // here, so its process.env reads are skipped. PANEL_SECRET and NEXT_PUBLIC are still checked there.
        if (relative(join(root, 'src'), f) === join('lib', 'snippets.ts')) return /PANEL_SECRET|NEXT_PUBLIC/.test(src);
        return /PANEL_SECRET|process\.env|NEXT_PUBLIC/.test(src);
      });
    expect(offenders).toEqual([]);
  });
  test('PANEL_SECRET is read by src/server/api.ts alone', () => {
    const readers = sources.filter((f) => /PANEL_SECRET/.test(readFileSync(f, 'utf8'))).map((f) => relative(root, f));
    expect(readers).toEqual([join('src', 'server', 'api.ts')]);
  });
  test("no 'use client' file imports from src/server/", () => {
    const offenders = sources.filter((f) => {
      const s = readFileSync(f, 'utf8');
      return /^\s*['"]use client['"]/.test(s) && /from\s+['"][^'"]*server\//.test(s);
    });
    expect(offenders).toEqual([]);
  });
});

describe('globals.css', () => {
  // The unit tests only read this file as text; an unclosed block passes them all and then fails the production build.
  test('parses: every block is closed', () => {
    expect(() => postcss.parse(css)).not.toThrow();
  });
});
