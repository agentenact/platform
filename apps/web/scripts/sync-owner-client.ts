/**
 * Copies apps/api/src/owner-client/*.ts into src/mirror/owner-client/ so the browser runs the exact
 * gate the api tests prove, and apps/api/src/gateway/client-ip.ts into src/mirror/gateway/ so the panel server
 * resolves the visitor address with the api's own algorithm. The copies are generated (header line, and relative `.js` specifiers dropped, see vendor-lib.ts): edit the api side, then
 * `bun run sync:owner-client`. tests/owner-client-drift.test.ts and tests/client-ip.test.ts fail when they differ.
 */
import { mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { CLIENT_IP_HEADER, dropJsSpecifiers, HEADER } from './vendor-lib';

const web = join(import.meta.dir, '..');
const from = join(web, '../api/src/owner-client');
const to = join(web, 'src/mirror/owner-client');

rmSync(to, { recursive: true, force: true });
mkdirSync(to, { recursive: true });
const files = readdirSync(from).filter((n) => n.endsWith('.ts')).sort();
for (const n of files) writeFileSync(join(to, n), `${HEADER}\n${dropJsSpecifiers(readFileSync(join(from, n), 'utf8'))}`);
console.log(`synced ${files.length} files to src/mirror/owner-client`);

// client-ip.ts imports only node:net, so it vendors as is.
const gatewayTo = join(web, 'src/mirror/gateway');
mkdirSync(gatewayTo, { recursive: true });
writeFileSync(join(gatewayTo, 'client-ip.ts'), `${CLIENT_IP_HEADER}\n${dropJsSpecifiers(readFileSync(join(web, '../api/src/gateway/client-ip.ts'), 'utf8'))}`);
console.log('synced client-ip.ts to src/mirror/gateway');
