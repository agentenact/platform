import { describe, expect, test } from 'bun:test';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { dropJsSpecifiers } from '../scripts/vendor-lib';

const web = join(import.meta.dir, '..');
const source = join(web, '../api/src/owner-client');
const vendored = join(web, 'src/mirror/owner-client');
const HEADER = '// GENERATED, do not edit; source apps/api/src/owner-client';
const ts = (dir: string) => readdirSync(dir).filter((n) => n.endsWith('.ts')).sort();

describe('vendored owner-client', () => {
  test('the vendored files equal the api\'s owner-client byte for byte after the header line', () => {
    expect(ts(vendored)).toEqual(ts(source));
    expect(ts(source).length).toBeGreaterThan(0);
    for (const n of ts(source)) {
      const body = readFileSync(join(vendored, n), 'utf8');
      const nl = body.indexOf('\n');
      expect(body.slice(0, nl)).toBe(HEADER);
      expect(body.slice(nl + 1)).toBe(dropJsSpecifiers(readFileSync(join(source, n), 'utf8')));
      expect(body).not.toMatch(/from\s+['"]\.{1,2}\/[^'"]*\.js['"]/);
    }
  });
});
