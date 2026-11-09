/**
 * RFC 6962 §2.1 Merkle tree hash over sha256: leaf = H(0x00 ‖ data), node = H(0x01 ‖ left ‖ right), and a list of n > 1
 * leaves splits at the largest power of two below n. Chosen over a home-made tree because it is specified, the
 * certificate-transparency tools check it, and it fixes the odd-leaf and second-preimage questions. The audit path
 * (§2.1.1) proves one leaf against the root without the other leaves.
 */
import { createHash } from 'node:crypto';

const h = (...parts: Uint8Array[]): Buffer => {
  const x = createHash('sha256');
  for (const p of parts) x.update(p);
  return x.digest();
};
const LEAF = Uint8Array.of(0);
const NODE = Uint8Array.of(1);

export const leafHash = (data: string): Buffer => h(LEAF, Buffer.from(data, 'utf8'));

const split = (n: number): number => {
  let k = 1;
  while (k * 2 < n) k *= 2;
  return k;
};

function mth(leaves: Buffer[]): Buffer {
  if (leaves.length === 0) return h();
  if (leaves.length === 1) return leaves[0]!;
  const k = split(leaves.length);
  return h(NODE, mth(leaves.slice(0, k)), mth(leaves.slice(k)));
}

/** The root of these leaves' bytes (each a canonical leaf document), as 64 lowercase hex. */
export function merkleRoot(data: readonly string[]): string {
  return mth(data.map(leafHash)).toString('hex');
}

/** The audit path of leaf `index` (0-based) among `data`, bottom up, as hex. */
export function auditPath(data: readonly string[], index: number): string[] {
  if (!Number.isInteger(index) || index < 0 || index >= data.length) throw new Error('merkle: index out of range');
  const path = (m: number, leaves: Buffer[]): Buffer[] => {
    if (leaves.length <= 1) return [];
    const k = split(leaves.length);
    return m < k ? [...path(m, leaves.slice(0, k)), mth(leaves.slice(k))] : [...path(m - k, leaves.slice(k)), mth(leaves.slice(0, k))];
  };
  return path(index, data.map(leafHash)).map((b) => b.toString('hex'));
}

/** RFC 9162 §2.1.3.2: checks a leaf's audit path against a root of a tree of `size` leaves. */
export function verifyPath(data: string, index: number, size: number, path: readonly string[], root: string): boolean {
  if (!Number.isInteger(index) || index < 0 || index >= size) return false;
  let fn = index;
  let sn = size - 1;
  let r = leafHash(data);
  for (const p of path) {
    if (sn === 0) return false;
    const sib = Buffer.from(p, 'hex');
    if (fn % 2 === 1 || fn === sn) {
      r = h(NODE, sib, r);
      if (fn % 2 === 0) {
        while (fn % 2 === 0 && fn !== 0) {
          fn >>= 1;
          sn >>= 1;
        }
      }
    } else {
      r = h(NODE, r, sib);
    }
    fn >>= 1;
    sn >>= 1;
  }
  return sn === 0 && r.toString('hex') === root;
}
