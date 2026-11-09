import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { dropJsSpecifiers } from '../scripts/vendor-lib';
import { visitorIp } from '../src/server/client-ip';

const h = (o: Record<string, string>) => new Headers(o);

describe('vendored client-ip', () => {
  test("equals the api's gateway/client-ip.ts byte for byte after the header line (relative .js specifiers dropped)", () => {
    const body = readFileSync(join(import.meta.dir, '../src/mirror/gateway/client-ip.ts'), 'utf8');
    const nl = body.indexOf('\n');
    expect(body.slice(0, nl)).toBe('// GENERATED, do not edit; source apps/api/src/gateway/client-ip.ts');
    const source = readFileSync(join(import.meta.dir, '../../api/src/gateway/client-ip.ts'), 'utf8');
    expect(source.length).toBeGreaterThan(500);
    expect(body.slice(nl + 1)).toBe(dropJsSpecifiers(source));
  });
});

describe('dropJsSpecifiers', () => {
  test('drops .js from relative specifiers only', () => {
    expect(dropJsSpecifiers("import { a } from './x.js';\nimport type { B } from '../y/z.js';\nconst m = await import('./w.js');\nimport 'node:net';\nimport { c } from 'pkg/file.js';\nimport './side.js';")).toBe(
      "import { a } from './x';\nimport type { B } from '../y/z';\nconst m = await import('./w');\nimport 'node:net';\nimport { c } from 'pkg/file.js';\nimport './side';",
    );
  });
});

describe('visitorIp (the api cases, no socket)', () => {
  test('Cloudflare peer + visitor header gives the visitor', () => {
    expect(visitorIp(h({ 'x-forwarded-for': '162.158.10.1', 'cf-connecting-ip': '203.0.113.7' }))).toBe('203.0.113.7');
    expect(visitorIp(h({ 'x-forwarded-for': '2606:4700::6810:1', 'cf-connecting-ip': '2001:db8::7' }))).toBe('2001:db8::7');
  });
  test('a direct peer: a forged CF-Connecting-IP is ignored', () => {
    expect(visitorIp(h({ 'x-forwarded-for': '198.51.100.9', 'cf-connecting-ip': '203.0.113.7' }))).toBe('198.51.100.9');
  });
  test('only the last X-Forwarded-For entry counts', () => {
    expect(visitorIp(h({ 'x-forwarded-for': '1.1.1.1, 198.51.100.9' }))).toBe('198.51.100.9');
    expect(visitorIp(h({ 'x-forwarded-for': '162.158.10.1, 198.51.100.9', 'cf-connecting-ip': '203.0.113.7' }))).toBe('198.51.100.9');
  });
  test('a Cloudflare peer with a missing or malformed visitor header falls back to the peer', () => {
    expect(visitorIp(h({ 'x-forwarded-for': '162.158.10.1' }))).toBe('162.158.10.1');
    expect(visitorIp(h({ 'x-forwarded-for': '162.158.10.1', 'cf-connecting-ip': 'nope' }))).toBe('162.158.10.1');
  });
  test('no headers: no address', () => {
    expect(visitorIp(h({}))).toBeUndefined();
  });
});
