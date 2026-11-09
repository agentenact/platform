/**
 * Build-time check of the isolate pool: spawns the real pool, runs one `js` and one `extract` job, exits non-zero
 * on any failure. The Dockerfile runs it after the sources are copied, so a missing QuickJS WASM, linkedom or
 * Readability fails `docker build`, not the first compute call in production. Prints fixed words only.
 * Lives under src/ because .dockerignore drops scripts/.
 */
import { createPool } from './isolate.js';

const pool = createPool({ size: 1 });
let failed = false;
const check = (name: string, ok: boolean) => {
  process.stdout.write(`isolate-smoke ${name}: ${ok ? 'ok' : 'FAILED'}\n`);
  if (!ok) failed = true;
};
try {
  const js = await pool.run('js', { code: 'return 1 + 1', input: 'null' }, 15_000);
  check('js', js.ok && js.value === 2);
  const html = '<html><head><title>Smoke</title></head><body><article><p>Stellar moved today. </p><p>Second paragraph of the article.</p></article></body></html>';
  const ex = await pool.run('extract', { html }, 15_000);
  const v = ex.ok ? (ex.value as { title?: unknown; text?: unknown }) : undefined;
  check('extract', v !== undefined && v.title === 'Smoke' && typeof v.text === 'string' && v.text.includes('Stellar moved today'));
} finally {
  await pool.shutdown();
}
process.exit(failed ? 1 : 0);
