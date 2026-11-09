/**
 * `stellar_payments` (plan D17, P4 Task 4): the recent payments of one Stellar account, read from that network's
 * Horizon (testnet default; mainnet read-only, see networks.ts). One GET of the newest 50 operations, filtered in
 * code. Classic `payment` and `path_payment_*` operations, plus Soroban `invoke_host_function` transfers read from
 * `asset_balance_changes` (that is how x402 / USDC SAC settlements appear). Amounts are compared as bigints scaled
 * to 7 places, never as Number. READ-ONLY: it never signs, submits or holds a key (tests/invariants.test.ts).
 */
import { StrKey } from '@stellar/stellar-sdk';
import type { z } from 'zod';
import { toolError } from './errors.js';
import { STELLAR_READ, type StellarNetwork } from './networks.js';
import type { SafeFetch } from './safe-fetch.js';
import type { StellarPaymentsArgs } from './schemas.js';

const FETCH_LIMIT = 50;
const PATH = new Set(['path_payment_strict_send', 'path_payment_strict_receive']);
const CLASSIC = new Set(['payment', 'path_payment_strict_send', 'path_payment_strict_receive']);

export interface Payment {
  /** Operation id; `${op.id}:${i}` for the i-th transfer-type balance change of a contract call (mint/burn/clawback skipped before counting). Self payments (from === to) report as out. create_account / account_merge are not read. */
  id: string;
  at: string;
  direction: 'in' | 'out';
  kind: 'payment' | 'contract_transfer';
  from: string;
  to: string;
  /** `XLM`, or `CODE:ISSUER`. */
  asset: string;
  amount: string;
  tx: string;
}

export interface PaymentsRead {
  account: string;
  network: StellarNetwork;
  payments: Payment[];
  truncated: boolean;
}

interface Transfer {
  asset_type?: string;
  asset_code?: string;
  asset_issuer?: string;
  type?: string;
  from?: string;
  to?: string;
  amount?: string;
}
/** Path payments carry what left the sender in `source_*`; the plain fields are the destination side. */
interface Op0 extends Transfer {
  source_asset_type?: string;
  source_asset_code?: string;
  source_asset_issuer?: string;
  source_amount?: string;
}
interface Op extends Op0 {
  id?: string;
  created_at?: string;
  transaction_hash?: string;
  asset_balance_changes?: Transfer[];
}

/** A Horizon decimal amount as an integer count of 1e-7 units; null when it is not a plain decimal of at most 7 places. */
function stroops(v: string | undefined): bigint | null {
  const m = /^(\d{1,20})(?:\.(\d{1,7}))?$/.exec(v ?? '');
  return m ? BigInt(m[1]!) * 10_000_000n + BigInt((m[2] ?? '').padEnd(7, '0')) : null;
}

const assetOf = (t: Transfer): string | null => (t.asset_type === 'native' ? 'XLM' : t.asset_code && t.asset_issuer ? `${t.asset_code}:${t.asset_issuer}` : null);

export function createPayments(o: { safeFetch: SafeFetch; now?: () => number }) {
  const now = o.now ?? Date.now;
  return {
    async stellarPayments(a: z.output<typeof StellarPaymentsArgs>, signal?: AbortSignal): Promise<PaymentsRead> {
      if (!StrKey.isValidEd25519PublicKey(a.account)) throw toolError('bad_args');
      const network = a.network ?? 'testnet';
      const r = await o.safeFetch(`${STELLAR_READ[network].horizonUrl}/accounts/${a.account}/payments?order=desc&limit=${FETCH_LIMIT}&include_failed=false`, { headers: { accept: 'application/json' }, signal });
      const none: PaymentsRead = { account: a.account, network, payments: [], truncated: false };
      if (r.status === 404) return none;
      if (r.status !== 200) throw toolError('horizon_failed');
      let ops: Op[];
      try {
        const j = JSON.parse(new TextDecoder().decode(r.body)) as { _embedded?: { records?: unknown } };
        if (!Array.isArray(j._embedded?.records)) throw new Error('shape');
        ops = j._embedded.records as Op[];
      } catch {
        throw toolError('horizon_failed');
      }

      const since = now() - a.since_s * 1000;
      const min = a.min_amount === undefined ? null : stroops(a.min_amount);
      const dir = a.direction ?? 'both';
      const matches: Payment[] = [];
      for (const op of ops) {
        const at = Date.parse(op.created_at ?? '');
        if (!Number.isFinite(at) || at < since) continue;
        const kind = CLASSIC.has(op.type ?? '') ? 'payment' : op.type === 'invoke_host_function' ? 'contract_transfer' : null;
        if (!kind) continue;
        const transfers = kind === 'payment' ? [op] : (Array.isArray(op.asset_balance_changes) ? op.asset_balance_changes : []).filter((c) => c.type === 'transfer');
        transfers.forEach((t0, i) => {
          const direction = t0.from === a.account ? 'out' : t0.to === a.account ? 'in' : null;
          // An outgoing path payment spent its source asset; the destination asset is what the receiver got.
          const t: Transfer = direction === 'out' && PATH.has(op.type ?? '') && kind === 'payment'
            ? { ...t0, asset_type: op.source_asset_type, asset_code: op.source_asset_code, asset_issuer: op.source_asset_issuer, amount: op.source_amount }
            : t0;
          const asset = assetOf(t);
          const amount = stroops(t.amount);
          if (!asset || amount === null || !t0.from || !t0.to) return;
          if (!direction || (dir !== 'both' && dir !== direction)) return;
          if (a.asset !== undefined && a.asset !== asset) return;
          if (min !== null && amount < min) return;
          matches.push({
            id: kind === 'payment' ? String(op.id ?? '') : `${op.id ?? ''}:${i}`,
            at: op.created_at!,
            direction,
            kind,
            from: t0.from,
            to: t0.to,
            asset,
            amount: t.amount!,
            tx: String(op.transaction_hash ?? ''),
          });
        });
      }
      // The single 50-record page may not reach back to since_s: older matches could be hidden past it.
      const oldest = Date.parse(ops[ops.length - 1]?.created_at ?? '');
      const windowOpen = ops.length >= FETCH_LIMIT && Number.isFinite(oldest) && oldest >= since;
      return { account: a.account, network, payments: matches.slice(0, a.limit), truncated: matches.length > a.limit || windowOpen };
    },
  };
}
