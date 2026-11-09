import { httpError, withRetry, type RetryOpts } from './registry.js';
import { parseUnits7 } from './units.js';

export type ChainTransfer = {
  opId: string;
  idx: number;
  txHash: string;
  from: string;
  to: string;
  amountUnits: bigint;
  asset: string;
  at: string;
};

type AssetRef = { asset_type?: string; asset_code?: string; asset_issuer?: string };
type BalanceChange = AssetRef & { type?: string; from?: string; to?: string; amount?: string };

/**
 * A Horizon operation record from `/accounts/{id}/payments`. Every field but `id` may be absent. The hash, time and success
 * flag are on the record itself; a joined `transaction` (not requested: it triples the page) is read only as a fallback.
 */
export type HorizonPaymentRecord = BalanceChange & {
  id: string;
  paging_token?: string;
  created_at?: string;
  transaction_hash?: string;
  transaction_successful?: boolean;
  transaction?: { hash?: string; successful?: boolean; created_at?: string };
  asset_balance_changes?: BalanceChange[];
};

const G_ADDRESS = /^G[A-Z2-7]{55}$/;

const CLASSIC = new Set(['payment', 'path_payment_strict_send', 'path_payment_strict_receive']);

/** `XLM` for native, `CODE:ISSUER` otherwise; null when the asset is unidentifiable. */
function canonicalAsset(a: AssetRef): string | null {
  if (a.asset_type === 'native') return 'XLM';
  return a.asset_code && a.asset_issuer ? `${a.asset_code}:${a.asset_issuer}` : null;
}

/** Flatten one operation into the transfers it carries. Anything incomplete is skipped, never guessed. */
export function transfersOf(record: HorizonPaymentRecord): ChainTransfer[] {
  if (record.transaction_successful === false || record.transaction?.successful === false) return [];
  const txHash = record.transaction_hash ?? record.transaction?.hash;
  const at = record.created_at ?? record.transaction?.created_at;
  if (!txHash || !at) return [];
  const entries: BalanceChange[] = CLASSIC.has(record.type ?? '')
    ? [record]
    : record.type === 'invoke_host_function'
      ? (record.asset_balance_changes ?? []).filter((c) => c.type === 'transfer')
      : [];
  const out: ChainTransfer[] = [];
  entries.forEach((c, idx) => {
    const asset = canonicalAsset(c);
    if (!c.from || !c.to || !c.amount || !asset) return;
    let amountUnits: bigint;
    try {
      amountUnits = parseUnits7(c.amount);
    } catch {
      return;
    }
    // The payments table requires amount_units > 0, and anyone can send a zero transfer: never let one reach it.
    if (amountUnits <= 0n) return;
    out.push({ opId: record.id, idx, txHash, from: c.from, to: c.to, amountUnits, asset, at });
  });
  return out;
}

export interface HorizonReader {
  accountPayments(wallet: string, cursor: string | null, limit: number): Promise<{ transfers: ChainTransfer[]; cursor: string | null; done: boolean }>;
}

/** Per request. A timed-out read throws like any other transport failure: that wallet is logged and rescheduled. */
const HORIZON_TIMEOUT_MS = 30_000;

export function createHorizonReader(o: {
  horizonUrl: string;
  fetch?: typeof fetch;
  limiter?: () => Promise<void>;
  retry?: RetryOpts;
}): HorizonReader {
  const base = o.horizonUrl.replace(/\/$/, '');
  const doFetch = o.fetch ?? globalThis.fetch;

  return {
    async accountPayments(wallet, cursor, limit) {
      // A contract address (C...) has no Horizon account: /accounts/C.../payments answers HTTP 400 (seen live for
      // three testnet agents). Nothing to read, and nothing to fail on every poll.
      if (!G_ADDRESS.test(wallet)) return { transfers: [], cursor, done: true };
      const qs = new URLSearchParams({ order: 'asc', limit: String(limit), include_failed: 'false' });
      qs.set('cursor', cursor ?? '');
      const url = `${base}/accounts/${encodeURIComponent(wallet)}/payments?${qs}`;
      const body = await withRetry(async () => {
        await o.limiter?.();
        const res = await doFetch(url, { signal: AbortSignal.timeout(HORIZON_TIMEOUT_MS) }); // a read that never answers must not hold the payments stage
        if (res.status === 404) return null;
        if (!res.ok) throw httpError(res.status, 'Horizon payments read');
        return (await res.json()) as { _embedded?: { records?: HorizonPaymentRecord[] } };
      }, o.retry);
      if (!body) return { transfers: [], cursor, done: true };
      const records = body._embedded?.records ?? [];
      // Without a token the cursor cannot move, and the caller would re-read this page forever.
      if (records.length > 0 && !records.at(-1)?.paging_token) throw new Error('Horizon payments page without paging_token');
      return {
        transfers: records.flatMap(transfersOf),
        cursor: records.at(-1)?.paging_token ?? cursor,
        done: records.length < limit,
      };
    },
  };
}

/** Spaces calls `1000/rps` ms apart. `now` and `sleep` are injectable for tests. */
export function createRateLimiter(
  rps: number,
  now: () => number = Date.now,
  sleep: (ms: number) => Promise<void> = (ms) => new Promise((r) => setTimeout(r, ms)),
): () => Promise<void> {
  const spacing = 1000 / rps;
  let next = 0;
  return async () => {
    const slot = Math.max(now(), next);
    next = slot + spacing;
    const wait = slot - now();
    if (wait > 0) await sleep(wait);
  };
}
