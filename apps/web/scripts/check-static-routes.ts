/** Run after `next build`: the public pages must be prerendered and the session pages must not (src/lib/static-routes.ts). */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { staticRouteProblems } from '../src/lib/static-routes';

const manifest = JSON.parse(readFileSync(join(import.meta.dir, '../.next/prerender-manifest.json'), 'utf8')) as { routes: Record<string, unknown> };
const problems = staticRouteProblems(Object.keys(manifest.routes));
if (problems.length) {
  console.error(`static route check failed:\n  ${problems.join('\n  ')}`);
  process.exit(1);
}
console.log('static route check: /, /explore, /verify and /create are prerendered; the session pages are not');
