/**
 * Finding a payment on chain when the facilitator's answer was lost (2026-11-05: its settle call failed at 30 s, 2 s after
 * the transaction landed, and the buyer paid for an output we then threw away).
 *
 * A match is exact, never a guess: the buyer's signed authorization carries a nonce the chain burns, so the one transaction
 * whose envelope holds the same address and nonce is this payment, and no other can be. The buyer, seller, amount and asset
 * only narrow which envelopes are worth reading. Any doubt answers null, and the caller reports the money state as unknown.
 */
import { FeeBumpTransaction, Networks, StrKey, TransactionBuilder, xdr } from '@stellar/stellar-sdk';
import { TESTNET } from '../owner-client/testnet.js';
import type { PaymentsRead } from '../tools/payments.js';
import { usdcToUnits } from './usdc.js';

/** With the 30 s handler and the facilitator's ~30 s, this stays under the 100 s the edge allows a response. */
export const LOOKUP_WAIT_MS = 25_000;
export const LOOKUP_EVERY_MS = 3_000;
/** The window a look reads, and the fewest the payments read allows. */
const LOOKUP_SINCE_S = 300;

export interface FindSettlementInput {
  /** The x402 payment payload, as the library hands it to settle. */
  payload: unknown;
  payer: string;
  payTo: string;
  /** Base units (7 decimals). */
  units: string;
}
export type FindSettlement = (i: FindSettlementInput) => Promise<string | null>;

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null;

/** The first address authorization of a transaction's contract call: who signed it and the nonce the chain burns. Null when there is none. */
export function authOf(txXdr: string, passphrase: string = Networks.TESTNET): { address: string; nonce: string } | null {
  try {
    const parsed = TransactionBuilder.fromXDR(txXdr, passphrase);
    const tx = parsed instanceof FeeBumpTransaction ? parsed.innerTransaction : parsed;
    for (const op of tx.operations) {
      if (op.type !== 'invokeHostFunction') continue;
      for (const entry of op.auth ?? []) {
        const c = entry.credentials();
        if (c.switch() !== xdr.SorobanCredentialsType.sorobanCredentialsAddress()) continue;
        const a = c.address();
        const sc = a.address();
        if (sc.switch() !== xdr.ScAddressType.scAddressTypeAccount()) continue;
        return { address: StrKey.encodeEd25519PublicKey(sc.accountId().ed25519()), nonce: a.nonce().toString() };
      }
    }
  } catch {
    // not a transaction we can read
  }
  return null;
}

const payloadTx = (payload: unknown): string | null => {
  const inner = isObj(payload) ? payload.payload : null;
  return isObj(inner) && typeof inner.transaction === 'string' ? inner.transaction : null;
};

export function createSettlementLookup(d: {
  /** The seller's recent incoming USDC (tools/payments.ts). */
  payments: (a: { account: string; network: 'testnet'; asset: string; direction: 'in'; since_s: number; limit: number }) => Promise<Pick<PaymentsRead, 'payments'>>;
  /** A transaction's envelope, base64. Throws when the chain does not have it. */
  envelope: (txHash: string) => Promise<string>;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
  waitMs?: number;
  everyMs?: number;
}): FindSettlement {
  const sleep = d.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const now = d.now ?? Date.now;
  const waitMs = d.waitMs ?? LOOKUP_WAIT_MS;
  const everyMs = d.everyMs ?? LOOKUP_EVERY_MS;

  return async ({ payload, payer, payTo, units }) => {
    const txXdr = payloadTx(payload);
    const signed = txXdr ? authOf(txXdr) : null;
    if (!signed || signed.address !== payer) return null;
    const want = BigInt(units);
    const seen = new Set<string>();
    const deadline = now() + waitMs;
    for (;;) {
      try {
        const { payments } = await d.payments({ account: payTo, network: 'testnet', asset: TESTNET.usdc, direction: 'in', since_s: LOOKUP_SINCE_S, limit: 20 });
        for (const p of payments) {
          if (seen.has(p.tx) || p.from !== payer || p.to !== payTo || p.asset !== TESTNET.usdc || usdcToUnits(p.amount) !== want) continue;
          const onChain = authOf(await d.envelope(p.tx));
          seen.add(p.tx);
          if (onChain?.address === signed.address && onChain.nonce === signed.nonce) return p.tx;
        }
      } catch {
        // this look failed; the next one may not
      }
      if (now() + everyMs > deadline) return null;
      await sleep(everyMs);
    }
  };
}
