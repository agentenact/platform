/** Strict base58 (Bitcoin alphabet), enough to read a Solana address. No dependency. */
const ALPHABET = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
const INDEX = new Map<string, number>([...ALPHABET].map((c, i) => [c, i]));
const MAX_LENGTH = 100;

/** The bytes a base58 string encodes (each leading '1' is a zero byte), or null for an empty, over-long or non-alphabet string. */
export function decodeBase58(s: string): Uint8Array | null {
  if (s.length === 0 || s.length > MAX_LENGTH) return null;
  let n = 0n;
  for (const ch of s) {
    const v = INDEX.get(ch);
    if (v === undefined) return null;
    n = n * 58n + BigInt(v);
  }
  let zeros = 0;
  while (zeros < s.length && s[zeros] === '1') zeros++;
  const out: number[] = [];
  while (n > 0n) {
    out.push(Number(n & 0xffn));
    n >>= 8n;
  }
  return Uint8Array.from([...Array<number>(zeros).fill(0), ...out.reverse()]);
}

/** A Solana public key: exactly 32 bytes, and not the all-zero key (a small-order point, never a real account). */
export function solanaPublicKey(address: string): Uint8Array | null {
  const bytes = decodeBase58(address);
  if (!bytes || bytes.length !== 32 || bytes.every((b) => b === 0)) return null;
  return bytes;
}
