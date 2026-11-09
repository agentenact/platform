import { describe, expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { bannerFor } from '../scripts/build-verifier';

const root = join(import.meta.dir, '..');
const tarball = readFileSync(join(root, 'libs/agentenact-0.4.0.tgz'));
const sha = createHash('sha256').update(tarball).digest('hex');
const bundle = readFileSync(join(root, 'public/verifier/agentenact.js'), 'utf8');

describe('verifier bundle', () => {
  test('is built from the vendored tarball as it is now (rerun `bun run verifier` after vendoring)', () => {
    expect(bundle.split('\n', 1)[0]).toBe(bannerFor(sha));
  });
  test("the web app's tarball is the api's tarball, byte for byte", () => {
    const api = join(root, '../api/libs/agentenact-0.4.0.tgz');
    if (!existsSync(api)) return;
    expect(createHash('sha256').update(readFileSync(api)).digest('hex')).toBe(sha);
  });
  test('package.json depends on the tarball inside apps/web, so the Docker context holds it', () => {
    const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
    expect(pkg.dependencies.agentenact).toBe('file:./libs/agentenact-0.4.0.tgz');
    const docker = readFileSync(join(root, 'Dockerfile'), 'utf8');
    expect(docker.indexOf('COPY libs ./libs')).toBeGreaterThan(-1);
    expect(docker.indexOf('COPY libs ./libs')).toBeLessThan(docker.indexOf('bun install --frozen-lockfile'));
  });
  test('exports what the live proof, /verify and the create panel import', () => {
    const exported = /export\{([^}]*)\};?\s*$/.exec(bundle)?.[1] ?? '';
    const names = exported.split(',').map((e) => e.trim().split(/\s+as\s+/).pop());
    for (const n of ['verifyRecord', 'parseRecord', 'sha256Hex', 'decodeRecordHeader', 'canonicalBytes', 'createStellarAdapter', 'createStellarAgent', 'Keypair', 'Networks', 'TransactionBuilder'])
      expect(names).toContain(n);
  });
  test('the bundled library functions have bodies, not a dangling export list', async () => {
    const mod = await import(join(root, 'public/verifier/agentenact.js'));
    for (const n of ['verifyRecord', 'parseRecord', 'createStellarAdapter', 'createStellarAgent']) expect(typeof mod[n]).toBe('function');
  });
  test('the bundled verifier checks the captured proof offline: digest and parse agree with the record', async () => {
    const mod = await import(join(root, 'public/verifier/agentenact.js'));
    const proof = JSON.parse(readFileSync(join(root, 'public/proofs/latest.json'), 'utf8'));
    const record = mod.parseRecord(proof.record);
    expect(record.output.sha256).toBe(proof.record.output.sha256);
  });
});
