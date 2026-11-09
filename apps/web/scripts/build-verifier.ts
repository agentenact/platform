/**
 * Builds public/verifier/agentenact.js, the browser bundle the Verify buttons (/, /verify) and the in-browser create
 * panel (/create#own-wallet) import at runtime. It is the PUBLISHED library, not a reimplementation: the entry re-exports
 * from the `agentenact` dependency, which is the vendored tarball libs/agentenact-0.4.0.tgz (a copy of
 * apps/api/libs/agentenact-0.4.0.tgz; tests/verifier-bundle.test.ts fails if the two differ or the bundle is stale).
 *
 *   bun run verifier
 *
 * The output is committed, so the Docker build needs no extra step. The first line of the bundle carries the tarball's
 * sha256; rerun this after `vendor:lib` updates the tarball.
 *
 * Where the entry lives: the library's package.json has `"sideEffects": false` next to an `exports` map, and Bun.build
 * silently tree-shakes an entry's own exports when the entry sits inside THAT package's tree
 * (agentenact/site/verifier/README.md). Our temporary entry sits in apps/web, outside it, and imports by bare specifier,
 * so the bundler resolves every package (the SDK included) with browser conditions and bundles one SDK copy.
 */
import { createHash } from 'node:crypto';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';

const root = path.resolve(import.meta.dir, '..');
const tarball = path.join(root, 'libs', 'agentenact-0.4.0.tgz');
const outFile = path.join(root, 'public', 'verifier', 'agentenact.js');

/** The banner on the bundle's first line; the drift test reads it back. */
export const bannerFor = (sha: string) => `/* agentenact 0.4.0 verifier bundle, built from libs/agentenact-0.4.0.tgz sha256:${sha} by scripts/build-verifier.ts; do not edit */`;

async function main() {
  const sha = createHash('sha256').update(await readFile(tarball)).digest('hex');
  const pkg = (name: string) => JSON.stringify(name);
  const entry = path.join(root, `.verifier-entry-${process.pid}.ts`);
  await writeFile(
    entry,
    [
      `export { verifyRecord, parseRecord, sha256Hex, decodeRecordHeader, canonicalBytes } from ${pkg('agentenact')};`,
      `export { createStellarAdapter } from ${pkg('agentenact/adapters/stellar')};`,
      `export { createStellarAgent } from ${pkg('agentenact/create')};`,
      `export { Keypair, Networks, TransactionBuilder } from ${pkg('@stellar/stellar-sdk')};`,
      '',
    ].join('\n'),
  );
  try {
    const result = await Bun.build({ entrypoints: [entry], target: 'browser', format: 'esm', minify: true });
    if (!result.success) {
      for (const log of result.logs) console.error(log);
      throw new Error('verifier bundle failed');
    }
    const code = await result.outputs[0]!.text();
    // An entry whose exports were shaken away still "succeeds" with a dangling export list; refuse that.
    for (const name of ['verifyRecord', 'createStellarAdapter', 'createStellarAgent', 'parseRecord', 'Keypair']) {
      if (!new RegExp(`\\bas ${name}\\b`).test(code) && !new RegExp(`\\b${name}\\b`).test(code)) throw new Error(`bundle lacks ${name}`);
    }
    await mkdir(path.dirname(outFile), { recursive: true });
    await writeFile(outFile, `${bannerFor(sha)}\n${code}`);
    console.log(`wrote ${path.relative(process.cwd(), outFile)} (${(code.length / 1024).toFixed(1)} kB)`);
  } finally {
    await rm(entry, { force: true });
  }
}

if (import.meta.main) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
