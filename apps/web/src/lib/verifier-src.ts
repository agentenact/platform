import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import path from 'node:path';

let src: string | undefined;

/** The verifier bundle's URL, versioned by its content so browsers never keep a stale copy. Server only (reads the file once). */
export function verifierSrc(): string {
  if (src === undefined) {
    const bundle = readFileSync(path.join(process.cwd(), 'public', 'verifier', 'agentenact.js'));
    src = `/verifier/agentenact.js?v=${createHash('sha256').update(bundle).digest('hex').slice(0, 12)}`;
  }
  return src;
}
