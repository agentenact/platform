/**
 * A Solana wallet's associated token account for a mint, derived locally (no RPC). Public RPCs throttle
 * `getTokenAccountsByOwner` hard (429 on a big wallet, 2026-10-28) and it also returns dust accounts others opened for the
 * wallet; the associated account is the one wallets and exchanges actually use. Classic SPL Token program only (USDC, USDT).
 *
 * PDA rule: sha256(seeds ‖ bump ‖ programId ‖ "ProgramDerivedAddress"), the first bump from 255 down whose hash is NOT a
 * point on ed25519. No dependency: sha256 from node:crypto, the curve check below.
 */
import { createHash } from 'node:crypto';
import { solanaPublicKey } from '../base58.js';

const ALPHABET = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
export const TOKEN_PROGRAM = 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA';
export const ATA_PROGRAM = 'ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL';

export function encodeBase58(bytes: Uint8Array): string {
  let n = 0n;
  for (const b of bytes) n = (n << 8n) | BigInt(b);
  let out = '';
  while (n > 0n) {
    out = ALPHABET[Number(n % 58n)]! + out;
    n /= 58n;
  }
  for (const b of bytes) {
    if (b !== 0) break;
    out = `1${out}`;
  }
  return out;
}

const P = 2n ** 255n - 19n;
const D = (-121665n * inv(121666n)) % P;
function mod(a: bigint): bigint {
  const r = a % P;
  return r < 0n ? r + P : r;
}
function pow(b: bigint, e: bigint): bigint {
  let r = 1n;
  b = mod(b);
  while (e > 0n) {
    if (e & 1n) r = (r * b) % P;
    b = (b * b) % P;
    e >>= 1n;
  }
  return r;
}
function inv(a: bigint): bigint {
  return pow(a, P - 2n);
}

/** Whether 32 bytes decode to a point on ed25519 (RFC 8032 §5.1.3 decoding, sign bit ignored as Solana does). */
export function onCurve(bytes: Uint8Array): boolean {
  let y = 0n;
  for (let i = 31; i >= 0; i--) y = (y << 8n) | BigInt(bytes[i]!);
  y &= (1n << 255n) - 1n;
  if (y >= P) return false;
  const y2 = mod(y * y);
  const u = mod(y2 - 1n);
  const v = mod(D * y2 + 1n);
  // x = u v^3 (u v^7)^((p-5)/8); a root exists when v x² = ±u.
  const v3 = mod(v * v * v);
  const x = mod(u * v3 * pow(u * v3 * v3 * v, (P - 5n) / 8n));
  const vx2 = mod(v * x * x);
  return vx2 === u || vx2 === mod(-u);
}

/** The associated token account of `owner` for `mint`, or null when either is not a Solana key. */
export function associatedTokenAccount(owner: string, mint: string): string | null {
  const o = solanaPublicKey(owner);
  const m = solanaPublicKey(mint);
  const t = solanaPublicKey(TOKEN_PROGRAM);
  const a = solanaPublicKey(ATA_PROGRAM);
  if (!o || !m || !t || !a) return null;
  for (let bump = 255; bump >= 0; bump--) {
    const h = createHash('sha256').update(o).update(t).update(m).update(Uint8Array.of(bump)).update(a).update('ProgramDerivedAddress').digest();
    if (!onCurve(h)) return encodeBase58(h);
  }
  return null;
}
