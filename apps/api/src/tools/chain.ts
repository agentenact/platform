/**
 * `stellar_price`, `stellar_price_change` and `stellar_read` (plan D17, P4 Task 3). Prices come from the Reflector
 * CEX/DEX feed of the chosen network (SEP-40, USD base, 14 decimals, 300 s resolution; testnet default, mainnet
 * read-only; see networks.ts), called as a raw JSON-RPC simulateTransaction so the request goes through safeFetch.
 * XLM also gets that network's SDEX XLM/USDC book. Accounts and transactions come from that network's Horizon.
 */
import { Account, BASE_FEE, Contract, StrKey, TransactionBuilder, nativeToScVal, scValToNative, xdr } from '@stellar/stellar-sdk';
import { toolError } from './errors.js';
import type { SafeFetch } from './safe-fetch.js';
import { STELLAR_READ, type StellarNetwork } from './networks.js';
import { REFLECTOR_SYMBOLS } from './schemas.js';

export const REFLECTOR_TESTNET = STELLAR_READ.testnet.reflector;
export const REFLECTOR_DECIMALS = 14;
/** A price older than 3x Reflector's 300 s resolution is flagged `stale`. */
export const STALE_PRICE_SECONDS = 900;
const MAX_BALANCES = 50;
/** Valid, fund-less, never-signing source for read-only simulations (the library adapter uses the same). */
const VIEW_SOURCE = 'GAAQCAIBAEAQCAIBAEAQCAIBAEAQCAIBAEAQCAIBAEAQCAIBAEAQDZ7H';

export interface StellarPrice {
  symbol: string;
  usd: string;
  at: string;
  ageSeconds: number;
  stale?: true;
  network: StellarNetwork;
  source: 'reflector-testnet' | 'reflector-pubnet';
  sdex?: { pair: string; bid: string | null; ask: string | null };
}

export interface PriceChange {
  symbol: string;
  network: StellarNetwork;
  windowSeconds: number;
  from: { usd: string; at: string };
  to: { usd: string; at: string };
  /** Percent change, two decimals, truncated toward zero (bigint math). */
  changePct: number;
  /** The latest price is older than STALE_PRICE_SECONDS. */
  stale?: true;
}

type Net = { network?: StellarNetwork };

export interface ChainReads {
  stellarPrice(a: { symbol: string } & Net, signal?: AbortSignal): Promise<StellarPrice>;
  stellarPriceChange(a: { symbol: string; window_s: number } & Net, signal?: AbortSignal): Promise<PriceChange>;
  stellarRead(a: ({ kind: 'account'; id: string } | { kind: 'transaction'; hash: string }) & Net, signal?: AbortSignal): Promise<Record<string, unknown>>;
}

/** Reflector's price resolution: history is only stored on multiples of this. */
const RESOLUTION_S = 300;

/** A fixed-point integer as a decimal string, truncated to `places` fraction digits, trailing zeros dropped. */
export function scaled(v: bigint, decimals: number, places = 8): string {
  const neg = v < 0n;
  const s = (neg ? -v : v).toString().padStart(decimals + 1, '0');
  const int = s.slice(0, s.length - decimals);
  const frac = s.slice(s.length - decimals).slice(0, places).replace(/0+$/, '');
  return `${neg ? '-' : ''}${int}${frac ? `.${frac}` : ''}`;
}

const decode = (b: Uint8Array) => new TextDecoder().decode(b);

export function createChainReads(o: { safeFetch: SafeFetch; now?: () => number }): ChainReads {
  const now = o.now ?? Date.now;

  async function horizon(net: (typeof STELLAR_READ)[StellarNetwork], path: string, signal?: AbortSignal): Promise<Record<string, unknown> | null> {
    const r = await o.safeFetch(`${net.horizonUrl}${path}`, { headers: { accept: 'application/json' }, signal });
    if (r.status === 404) return null;
    if (r.status !== 200) throw toolError('horizon_failed');
    try {
      return JSON.parse(decode(r.body)) as Record<string, unknown>;
    } catch {
      throw toolError('horizon_failed');
    }
  }

  /** SEP-40 `lastprice(asset)` (no timestamp) or `price(asset, timestamp)`; a read-only simulation, never signed or sent. */
  async function readPrice(net: (typeof STELLAR_READ)[StellarNetwork], symbol: string, at: number | null, signal?: AbortSignal): Promise<{ price: bigint; timestamp: number } | null> {
    const asset = xdr.ScVal.scvVec([xdr.ScVal.scvSymbol('Other'), xdr.ScVal.scvSymbol(symbol)]);
    const call = at === null ? new Contract(net.reflector).call('lastprice', asset) : new Contract(net.reflector).call('price', asset, nativeToScVal(BigInt(at), { type: 'u64' }));
    const tx = new TransactionBuilder(new Account(VIEW_SOURCE, '0'), { fee: BASE_FEE, networkPassphrase: net.passphrase }).addOperation(call).setTimeout(30).build();
    const r = await o.safeFetch(net.rpcUrl, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'simulateTransaction', params: { transaction: tx.toXDR() } }),
      signal,
    });
    if (r.status !== 200) throw toolError('rpc_failed');
    let j: { result?: { error?: string; results?: { xdr?: string }[] } };
    try {
      j = JSON.parse(decode(r.body));
    } catch {
      throw toolError('rpc_failed');
    }
    const ret = j.result?.results?.[0]?.xdr;
    if (j.result?.error || !ret) throw toolError('rpc_failed');
    let v: { price?: unknown; timestamp?: unknown } | null | undefined;
    try {
      v = scValToNative(xdr.ScVal.fromXDR(ret, 'base64')) as typeof v;
    } catch {
      throw toolError('rpc_failed');
    }
    if (v === null || v === undefined) return null;
    if (typeof v !== 'object' || typeof v.price !== 'bigint' || v.price <= 0n) throw toolError('no_price');
    const timestamp = typeof v.timestamp === 'bigint' || typeof v.timestamp === 'number' ? Number(v.timestamp) : NaN;
    if (!Number.isFinite(timestamp) || timestamp <= 0 || !Number.isFinite(new Date(timestamp * 1000).getTime())) throw toolError('no_price');
    return { price: v.price, timestamp };
  }

  return {
    async stellarPrice(a, signal) {
      const symbol = a.symbol.toUpperCase();
      if (!(REFLECTOR_SYMBOLS as readonly string[]).includes(symbol)) throw toolError('unknown_symbol');
      const network = a.network ?? 'testnet';
      const net = STELLAR_READ[network];
      const last = await readPrice(net, symbol, null, signal);
      if (!last) throw toolError('no_price');
      const ageSeconds = Math.max(0, Math.round(now() / 1000 - last.timestamp));
      const out: StellarPrice = {
        symbol,
        usd: scaled(last.price, REFLECTOR_DECIMALS),
        at: new Date(last.timestamp * 1000).toISOString(),
        ageSeconds,
        network,
        source: net.source,
      };
      if (ageSeconds > STALE_PRICE_SECONDS) out.stale = true;
      if (symbol === 'XLM') {
        // The SDEX book is optional: any failure keeps the Reflector price (an abort still aborts).
        try {
          const book = await horizon(
            net,
            `/order_book?selling_asset_type=native&buying_asset_type=credit_alphanum4&buying_asset_code=USDC&buying_asset_issuer=${net.usdcIssuer}&limit=1`,
            signal,
          );
          const top = (side: unknown) => (Array.isArray(side) && side[0] && typeof side[0].price === 'string' ? (side[0].price as string) : null);
          out.sdex = { pair: `XLM/USDC (${network} SDEX)`, bid: top(book?.bids), ask: top(book?.asks) };
        } catch (e) {
          if (signal?.aborted) throw e;
        }
      }
      return out;
    },

    async stellarPriceChange(a, signal) {
      const symbol = a.symbol.toUpperCase();
      if (!(REFLECTOR_SYMBOLS as readonly string[]).includes(symbol)) throw toolError('unknown_symbol');
      if (!Number.isInteger(a.window_s) || a.window_s < RESOLUTION_S) throw toolError('bad_args');
      const network = a.network ?? 'testnet';
      const net = STELLAR_READ[network];
      const to = await readPrice(net, symbol, null, signal);
      if (!to) throw toolError('no_price');
      const t0 = Math.floor((to.timestamp - a.window_s) / RESOLUTION_S) * RESOLUTION_S;
      const from = await readPrice(net, symbol, t0, signal);
      if (!from) throw toolError('no_price');
      const out: PriceChange = {
        symbol,
        network,
        windowSeconds: a.window_s,
        from: { usd: scaled(from.price, REFLECTOR_DECIMALS), at: new Date(from.timestamp * 1000).toISOString() },
        to: { usd: scaled(to.price, REFLECTOR_DECIMALS), at: new Date(to.timestamp * 1000).toISOString() },
        changePct: Number(((to.price - from.price) * 10_000n) / from.price) / 100,
      };
      if (Math.max(0, Math.round(now() / 1000 - to.timestamp)) > STALE_PRICE_SECONDS) out.stale = true;
      return out;
    },

    async stellarRead(a, signal) {
      const net = STELLAR_READ[a.network ?? 'testnet'];
      if (a.kind === 'account') {
        if (!StrKey.isValidEd25519PublicKey(a.id)) throw toolError('bad_args');
        const acc = await horizon(net, `/accounts/${a.id}`, signal);
        if (!acc) return { exists: false };
        const balances = (Array.isArray(acc.balances) ? acc.balances : []).slice(0, MAX_BALANCES) as { balance: string; asset_type: string; asset_code?: string; asset_issuer?: string; liquidity_pool_id?: string }[];
        return {
          exists: true,
          id: a.id,
          sequence: String(acc.sequence ?? ''),
          balances: balances.map((b) => ({
            asset: b.asset_type === 'native' ? 'XLM' : b.asset_type === 'liquidity_pool_shares' ? `LP:${b.liquidity_pool_id ?? 'unknown'}` : `${b.asset_code}:${b.asset_issuer}`,
            balance: b.balance,
          })),
        };
      }
      if (!/^[0-9a-f]{64}$/.test(a.hash)) throw toolError('bad_args');
      const tx = await horizon(net, `/transactions/${a.hash}`, signal);
      if (!tx) return { exists: false };
      return {
        exists: true,
        hash: a.hash,
        successful: tx.successful === true,
        createdAt: String(tx.created_at ?? ''),
        operationCount: Number(tx.operation_count ?? 0),
        memo: typeof tx.memo === 'string' ? tx.memo : null,
        feeCharged: String(tx.fee_charged ?? ''),
      };
    },
  };
}
