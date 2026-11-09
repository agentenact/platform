/**
 * `wallet_payments` and `wallet_balance`: one wallet on any chain the table below knows, READ-ONLY. No path here signs,
 * submits or holds a key (tests/invariants.test.ts); mainnets are read like testnets.
 *
 * Sources (all public, no key; each overridable with `RPC_URL_<CHAIN>`, e.g. RPC_URL_BASE, for a keyed provider):
 * - Stellar: the existing Horizon reads (payments.ts, chain.ts).
 * - EVM: plain JSON-RPC. Payments are ERC-20 `Transfer` logs of the pinned stablecoins (USDC, USDT), never native coin
 *   moves (those leave no log; reading them needs an indexer). Windows stop at one hour: the public nodes are not
 *   archive nodes. Token contracts verified with symbol()/decimals() on 2026-10-28.
 * - Solana: JSON-RPC. Signatures of the wallet and of its USDC/USDT token accounts, then each transaction's balance
 *   changes for the wallet (pre/post lamports and token balances).
 * - Bitcoin: mempool.space (the newest 25 transactions; sats in minus sats out per transaction). Confirmed ones only, so a
 *   payment shows after its first block.
 * Amounts are compared as bigints in the asset's own decimals, never as Number.
 */
import type { z } from 'zod';
import { solanaPublicKey } from '../base58.js';
import { toolError } from './errors.js';
import { associatedTokenAccount } from './solana-ata.js';
import type { SafeFetch } from './safe-fetch.js';
import type { ChainId, StellarPaymentsArgs, StellarReadArgs, WalletBalanceArgs, WalletPaymentsArgs } from './schemas.js';

type Family = 'stellar' | 'evm' | 'solana' | 'bitcoin';
export type TokenSymbol = 'USDC' | 'USDT';
interface Token {
  /** EVM: the lowercase contract; Solana: the mint; Stellar: CODE:ISSUER. */
  id: string;
  decimals: number;
}
export interface ChainInfo {
  family: Family;
  label: string;
  testnet: boolean;
  native: { symbol: string; decimals: number };
  tokens: Partial<Record<TokenSymbol, Token>>;
  /** EVM, Solana: JSON-RPC; Bitcoin: the mempool.space api root. Stellar reads go through STELLAR_READ. */
  url?: string;
  /** EVM: seconds per block, to turn a time window into a block range (rounded down: the window is only ever wider). */
  blockS?: number;
  stellarNetwork?: 'mainnet' | 'testnet';
}

const evm = (label: string, url: string, blockS: number, tokens: ChainInfo['tokens'], testnet = false, native = 'ETH'): ChainInfo => ({
  family: 'evm', label, testnet, native: { symbol: native, decimals: 18 }, tokens, url, blockS,
});
const t6 = (id: string): Token => ({ id: id.toLowerCase(), decimals: 6 });

export const CHAINS = {
  stellar: { family: 'stellar', label: 'Stellar', testnet: false, native: { symbol: 'XLM', decimals: 7 }, stellarNetwork: 'mainnet', tokens: { USDC: { id: 'USDC:GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN', decimals: 7 } } },
  ethereum: evm('Ethereum', 'https://ethereum-rpc.publicnode.com', 12, { USDC: t6('0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48'), USDT: t6('0xdAC17F958D2ee523a2206206994597C13D831ec7') }),
  base: evm('Base', 'https://base-rpc.publicnode.com', 2, { USDC: t6('0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913'), USDT: t6('0xfde4C96c8593536E31F229EA8f37b2ADa2699bb2') }),
  arbitrum: evm('Arbitrum', 'https://arb1.arbitrum.io/rpc', 0.25, { USDC: t6('0xaf88d065e77c8cC2239327C5EDb3A432268e5831'), USDT: t6('0xFd086bC7CD5C481DCC9C85ebE478A1C0b69FCbb9') }),
  optimism: evm('Optimism', 'https://optimism-rpc.publicnode.com', 2, { USDC: t6('0x0b2C639c533813f4Aa9D7837CAf62653d097Ff85'), USDT: t6('0x94b008aA00579c1307B0EF2c499aD98a8ce58e58') }),
  polygon: evm('Polygon', 'https://polygon-bor-rpc.publicnode.com', 2, { USDC: t6('0x3c499c542cEF5E3811e1192ce70d8cC03d5c3359'), USDT: t6('0xc2132D05D31c914a87C6611C10748AEb04B58e8F') }, false, 'POL'),
  celo: evm('Celo', 'https://forno.celo.org', 1, { USDC: t6('0xcebA9300f2b948710d2653dD7B07f33A8B32118C'), USDT: t6('0x48065fbBE25f71C9282ddf5e1cD6D6A887483D5e') }, false, 'CELO'),
  solana: { family: 'solana', label: 'Solana', testnet: false, native: { symbol: 'SOL', decimals: 9 }, url: 'https://api.mainnet-beta.solana.com', tokens: { USDC: { id: 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v', decimals: 6 }, USDT: { id: 'Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB', decimals: 6 } } },
  bitcoin: { family: 'bitcoin', label: 'Bitcoin', testnet: false, native: { symbol: 'BTC', decimals: 8 }, url: 'https://mempool.space/api', tokens: {} },
  'stellar-testnet': { family: 'stellar', label: 'Stellar testnet', testnet: true, native: { symbol: 'XLM', decimals: 7 }, stellarNetwork: 'testnet', tokens: { USDC: { id: 'USDC:GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5', decimals: 7 } } },
  'ethereum-sepolia': evm('Ethereum Sepolia', 'https://ethereum-sepolia-rpc.publicnode.com', 12, { USDC: t6('0x1c7D4B196Cb0C7B01d743Fbc6116a902379C7238') }, true),
  'base-sepolia': evm('Base Sepolia', 'https://base-sepolia-rpc.publicnode.com', 2, { USDC: t6('0x036CbD53842c5426634e7929541eC2318f3dCF7e') }, true),
  'arbitrum-sepolia': evm('Arbitrum Sepolia', 'https://arbitrum-sepolia-rpc.publicnode.com', 0.25, { USDC: t6('0x75faf114eafb1BDbe2F0316DF893fd58CE46AA4d') }, true),
  'avalanche-fuji': evm('Avalanche Fuji', 'https://avalanche-fuji-c-chain-rpc.publicnode.com', 2, { USDC: t6('0x5425890298aed601595a70AB815c96711a31Bc65') }, true, 'AVAX'),
  'polygon-amoy': evm('Polygon Amoy', 'https://polygon-amoy-bor-rpc.publicnode.com', 2, { USDC: t6('0x41E94Eb019C0762f9Bfcf9Fb1E58725BfB0e7582') }, true, 'POL'),
  'solana-devnet': { family: 'solana', label: 'Solana devnet', testnet: true, native: { symbol: 'SOL', decimals: 9 }, url: 'https://api.devnet.solana.com', tokens: { USDC: { id: '4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU', decimals: 6 } } },
  'bitcoin-testnet4': { family: 'bitcoin', label: 'Bitcoin testnet4', testnet: true, native: { symbol: 'BTC', decimals: 8 }, url: 'https://mempool.space/testnet4/api', tokens: {} },
} satisfies Record<ChainId, ChainInfo>;

/** EVM reads stop at one hour (non-archive public nodes). */
export const EVM_MAX_SINCE_S = 3600;

const EVM_ADDRESS = /^0x[0-9a-fA-F]{40}$/;
const STELLAR_ADDRESS = /^G[A-Z2-7]{55}$/;
const BASE58 = /^[1-9A-HJ-NP-Za-km-z]{25,44}$/;
const BECH32 = /^(bc1|tb1)[02-9ac-hj-np-z]{11,87}$/;
const BTC_LEGACY = /^[13mn2][1-9A-HJ-NP-Za-km-z]{25,34}$/;

/** Whether `address` is a wallet address of `chain` (format, and for Solana a 32-byte key; Bitcoin mainnet vs testnet prefixes). */
export function addressFits(chain: ChainId, address: string): boolean {
  const c: ChainInfo = CHAINS[chain];
  if (c.family === 'stellar') return STELLAR_ADDRESS.test(address);
  if (c.family === 'evm') return EVM_ADDRESS.test(address);
  if (c.family === 'solana') return BASE58.test(address) && solanaPublicKey(address) !== null;
  const main = address.startsWith('bc1') || /^[13]/.test(address);
  return (BECH32.test(address) || BTC_LEGACY.test(address)) && main === !c.testnet;
}

export interface WalletPayment {
  id: string;
  at: string;
  direction: 'in' | 'out';
  /** The counterparty side: for a payment in, `from` is who paid (best effort on Solana and Bitcoin, where one transaction can have several). */
  from: string;
  to: string;
  /** `SYMBOL` for the native coin, `SYMBOL:<contract|mint|issuer>` for a token. */
  asset: string;
  amount: string;
  tx: string;
}
export interface WalletPaymentsRead {
  chain: ChainId;
  address: string;
  payments: WalletPayment[];
  truncated: boolean;
}
export interface WalletBalanceRead {
  chain: ChainId;
  address: string;
  /** false: the chain has never seen this wallet (Stellar: no account; Bitcoin: no transaction). EVM and Solana always answer true. */
  exists: boolean;
  /** The native coin first, then USDC and USDT where held. */
  balances: { symbol: string; asset: string; amount: string }[];
}

type PaymentsArgs = z.output<typeof WalletPaymentsArgs>;

// ---- amounts ----

/** `v` (a decimal string) in units of 10^-decimals; extra places are cut, never rounded up. */
export function units(v: string, decimals: number): bigint {
  const [i, f = ''] = v.split('.');
  return BigInt(i!) * 10n ** BigInt(decimals) + BigInt((f.slice(0, decimals) || '0').padEnd(decimals, '0'));
}
/** A count of 10^-decimals units as a plain decimal string, without trailing zeros. */
export function decimal(n: bigint, decimals: number): string {
  const neg = n < 0n;
  const a = neg ? -n : n;
  const s = a.toString().padStart(decimals + 1, '0');
  const i = decimals ? s.slice(0, -decimals) : s;
  const f = decimals ? s.slice(-decimals).replace(/0+$/, '') : '';
  return `${neg ? '-' : ''}${i}${f ? `.${f}` : ''}`;
}

const decode = (b: Uint8Array) => new TextDecoder().decode(b);
const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const TRANSFER = '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef';
const topicOf = (address: string) => `0x${'0'.repeat(24)}${address.slice(2).toLowerCase()}`;
const addressOfTopic = (t: unknown) => (typeof t === 'string' && /^0x[0-9a-fA-F]{64}$/.test(t) ? `0x${t.slice(26).toLowerCase()}` : null);
const hexInt = (v: unknown): bigint | null => (typeof v === 'string' && /^0x[0-9a-fA-F]{1,64}$/.test(v) ? BigInt(v) : typeof v === 'string' && v === '0x' ? 0n : null);

export function createWalletReads(o: {
  safeFetch: SafeFetch;
  /** payments.ts and chain.ts, injected so this file never imports the mainnet table's readers. */
  payments: { stellarPayments(a: z.output<typeof StellarPaymentsArgs>, signal?: AbortSignal): Promise<{ payments: (WalletPayment & { kind: string })[]; truncated: boolean }> };
  chain: { stellarRead(a: z.output<typeof StellarReadArgs>, signal?: AbortSignal): Promise<unknown> };
  env?: Record<string, string | undefined>;
  now?: () => number;
}) {
  const now = o.now ?? Date.now;
  const env = o.env ?? process.env;
  const urlOf = (id: ChainId): string => env[`RPC_URL_${id.toUpperCase().replaceAll('-', '_')}`] || (CHAINS[id] as ChainInfo).url!;

  /** One JSON-RPC batch; the results in request order. Any error, missing answer or odd shape is `rpc_failed`; with errorsAsNull a "could not find account" answer is null. */
  async function rpc(id: ChainId, calls: [string, unknown[]][], signal?: AbortSignal, maxBytes?: number, errorsAsNull = false): Promise<unknown[]> {
    const body = JSON.stringify(calls.map(([method, params], i) => ({ jsonrpc: '2.0', id: i, method, params })));
    const r = await o.safeFetch(urlOf(id), { method: 'POST', headers: { 'content-type': 'application/json', accept: 'application/json' }, body, signal, ...(maxBytes ? { maxBytes } : {}) });
    if (r.status !== 200) throw toolError('rpc_failed');
    let j: unknown;
    try {
      j = JSON.parse(decode(r.body));
    } catch {
      throw toolError('rpc_failed');
    }
    const list = Array.isArray(j) ? j : [j];
    const out: unknown[] = [];
    for (let i = 0; i < calls.length; i++) {
      const a = list.find((x) => isObj(x) && x.id === i) as Record<string, unknown> | undefined;
      // Only "no such account" is a null; a rate limit or a provider refusal must never read as a zero balance.
      if (a && errorsAsNull && isObj(a.error) && /could not find account/i.test(String(a.error.message))) {
        out.push(null);
        continue;
      }
      if (!a || a.error !== undefined || !('result' in a)) throw toolError('rpc_failed');
      out.push(a.result);
    }
    return out;
  }

  async function mempool(id: ChainId, path: string, signal?: AbortSignal): Promise<unknown | null> {
    const r = await o.safeFetch(`${urlOf(id)}${path}`, { headers: { accept: 'application/json' }, signal });
    if (r.status === 400 || r.status === 404) return null;
    if (r.status !== 200) throw toolError('rpc_failed');
    try {
      return JSON.parse(decode(r.body));
    } catch {
      throw toolError('rpc_failed');
    }
  }

  const tokensFor = (c: ChainInfo, asset: PaymentsArgs['asset']): [TokenSymbol, Token][] =>
    (Object.entries(c.tokens) as [TokenSymbol, Token][]).filter(([s]) => asset === undefined || asset === s);

  function finish(chain: ChainId, a: PaymentsArgs, found: WalletPayment[], more = false): WalletPaymentsRead {
    const min = a.min_amount;
    const c: ChainInfo = CHAINS[chain];
    const decimalsOf = (asset: string) => (asset === c.native.symbol ? c.native.decimals : Object.values(c.tokens).find((t) => asset.endsWith(`:${t.id}`))?.decimals ?? 7);
    const kept = found
      .filter((p) => a.direction === 'both' || p.direction === a.direction)
      .filter((p) => min === undefined || units(p.amount, decimalsOf(p.asset)) >= units(min, decimalsOf(p.asset)))
      .sort((x, y) => y.at.localeCompare(x.at));
    return { chain, address: a.address, payments: kept.slice(0, a.limit), truncated: more || kept.length > a.limit };
  }

  // ---- EVM ----

  async function evmPayments(chain: ChainId, a: PaymentsArgs, signal?: AbortSignal): Promise<WalletPaymentsRead> {
    const c: ChainInfo = CHAINS[chain];
    if (a.asset === 'native') throw toolError('native_transfers_unreadable');
    if (a.since_s > EVM_MAX_SINCE_S) throw toolError('window_too_long');
    const tokens = tokensFor(c, a.asset);
    if (!tokens.length) return { chain, address: a.address, payments: [], truncated: false };
    const [tip] = await rpc(chain, [['eth_blockNumber', []]], signal);
    const latest = hexInt(tip);
    if (latest === null) throw toolError('rpc_failed');
    const span = BigInt(Math.ceil(a.since_s / c.blockS!));
    const from = `0x${(latest > span ? latest - span : 0n).toString(16)}`;
    const me = topicOf(a.address);
    const filter = (topics: (string | null)[]) => ({ fromBlock: from, toBlock: `0x${latest.toString(16)}`, address: tokens.map(([, t]) => t.id), topics });
    const [outLogs, inLogs] = await rpc(chain, [['eth_getLogs', [filter([TRANSFER, me])]], ['eth_getLogs', [filter([TRANSFER, null, me])]]], signal, 4_000_000);
    if (!Array.isArray(outLogs) || !Array.isArray(inLogs)) throw toolError('rpc_failed');

    const self = a.address.toLowerCase();
    const seen = new Set<string>();
    const rows: { block: bigint; index: bigint; p: WalletPayment }[] = [];
    const times = new Map<bigint, number>();
    for (const l of [...outLogs, ...inLogs]) {
      if (!isObj(l) || l.removed === true || !Array.isArray(l.topics)) continue;
      const fromA = addressOfTopic(l.topics[1]);
      const toA = addressOfTopic(l.topics[2]);
      const amount = hexInt(l.data);
      const block = hexInt(l.blockNumber);
      const index = hexInt(l.logIndex);
      const token = tokens.find(([, t]) => t.id === String(l.address).toLowerCase());
      if (!fromA || !toA || amount === null || block === null || index === null || !token || typeof l.transactionHash !== 'string') continue;
      const id = `${l.transactionHash}:${index}`;
      if (seen.has(id)) continue; // a self transfer matches both filters
      seen.add(id);
      // Newer nodes put the block time on each log; older ones need the block header (fetched below).
      const stamp = hexInt(l.blockTimestamp);
      if (stamp !== null) times.set(block, Number(stamp) * 1000);
      rows.push({ block, index, p: { id, at: '', direction: fromA === self ? 'out' : 'in', from: fromA, to: toA, asset: `${token[0]}:${token[1].id}`, amount: decimal(amount, token[1].decimals), tx: l.transactionHash } });
    }
    rows.sort((x, y) => (y.block === x.block ? Number(y.index - x.index) : y.block > x.block ? 1 : -1));
    // Timestamps for the blocks that can still make the answer (at most limit × 2 blocks, one batch).
    const blocks = [...new Set(rows.map((r) => r.block))].filter((b) => !times.has(b)).slice(0, a.limit * 2);
    if (blocks.length) {
      const heads = await rpc(chain, blocks.map((b) => ['eth_getBlockByNumber', [`0x${b.toString(16)}`, false]] as [string, unknown[]]), signal);
      heads.forEach((h, i) => {
        const t = isObj(h) ? hexInt(h.timestamp) : null;
        if (t !== null) times.set(blocks[i]!, Number(t) * 1000);
      });
    }
    const since = now() - a.since_s * 1000;
    const found: WalletPayment[] = [];
    for (const r of rows) {
      const t = times.get(r.block);
      if (t === undefined || t < since) continue;
      found.push({ ...r.p, at: new Date(t).toISOString() });
    }
    return finish(chain, a, found, rows.some((r) => !times.has(r.block)) && found.length >= a.limit);
  }

  async function evmBalance(chain: ChainId, address: string, signal?: AbortSignal): Promise<WalletBalanceRead> {
    const c: ChainInfo = CHAINS[chain];
    const tokens = tokensFor(c, undefined);
    const data = (t: Token) => ({ to: t.id, data: `0x70a08231${'0'.repeat(24)}${address.slice(2).toLowerCase()}` });
    const res = await rpc(chain, [['eth_getBalance', [address, 'latest']], ...tokens.map(([, t]) => ['eth_call', [data(t), 'latest']] as [string, unknown[]])], signal);
    const native = hexInt(res[0]);
    if (native === null) throw toolError('rpc_failed');
    const balances = [{ symbol: c.native.symbol, asset: c.native.symbol, amount: decimal(native, c.native.decimals) }];
    tokens.forEach(([s, t], i) => {
      const n = hexInt(res[i + 1]);
      if (n !== null && n > 0n) balances.push({ symbol: s, asset: `${s}:${t.id}`, amount: decimal(n, t.decimals) });
    });
    return { chain, address, exists: true, balances };
  }

  // ---- Solana ----

  const SOL_SIGS = 25;
  const SOL_TXS = 10;
  type TokenBal = { accountIndex?: number; mint?: string; owner?: string; uiTokenAmount?: { amount?: string; decimals?: number } };

  async function solanaPayments(chain: ChainId, a: PaymentsArgs, signal?: AbortSignal): Promise<WalletPaymentsRead> {
    const c: ChainInfo = CHAINS[chain];
    const mints = a.asset === 'native' ? [] : tokensFor(c, a.asset);
    // Signatures of the wallet itself (its own coin, and every transfer it signs) and of its associated token accounts
    // (a token payment in names only the receiving token account, never the wallet).
    const atas = mints.flatMap(([, t]) => associatedTokenAccount(a.address, t.id) ?? []);
    const watch = [...(a.asset === undefined || a.asset === 'native' ? [a.address] : []), ...atas];
    if (!watch.length) return { chain, address: a.address, payments: [], truncated: false };
    const sigLists = await rpc(chain, watch.map((w) => ['getSignaturesForAddress', [w, { limit: SOL_SIGS }]] as [string, unknown[]]), signal);
    const since = now() - a.since_s * 1000;
    const sigs = new Map<string, number>();
    let full = false;
    for (const list of sigLists) {
      if (!Array.isArray(list)) throw toolError('rpc_failed');
      if (list.length >= SOL_SIGS) {
        const last = list[list.length - 1] as { blockTime?: number };
        if (typeof last?.blockTime === 'number' && last.blockTime * 1000 >= since) full = true;
      }
      for (const s of list) {
        if (!isObj(s) || typeof s.signature !== 'string' || typeof s.blockTime !== 'number' || s.err !== null) continue;
        if (s.blockTime * 1000 < since) continue;
        sigs.set(s.signature, s.blockTime * 1000);
      }
    }
    const newest = [...sigs.entries()].sort((x, y) => y[1] - x[1]);
    const take = newest.slice(0, SOL_TXS);
    if (!take.length) return { chain, address: a.address, payments: [], truncated: full };
    const txs = await rpc(chain, take.map(([s]) => ['getTransaction', [s, { encoding: 'jsonParsed', maxSupportedTransactionVersion: 0 }]] as [string, unknown[]]), signal, 4_000_000);

    const found: WalletPayment[] = [];
    txs.forEach((tx, i) => {
      const [signature, at] = take[i]!;
      if (!isObj(tx) || !isObj(tx.meta) || tx.meta.err !== null) return;
      const meta = tx.meta as { fee?: number; preBalances?: number[]; postBalances?: number[]; preTokenBalances?: TokenBal[]; postTokenBalances?: TokenBal[] };
      const keys = ((tx.transaction as { message?: { accountKeys?: { pubkey?: string }[] } })?.message?.accountKeys ?? []).map((k) => k?.pubkey ?? '');
      // Native coin: the wallet's lamport change, with the fee given back when it paid it (index 0 is the fee payer).
      if (a.asset === undefined || a.asset === 'native') {
        const k = keys.indexOf(a.address);
        const pre = meta.preBalances?.[k];
        const post = meta.postBalances?.[k];
        if (k >= 0 && typeof pre === 'number' && typeof post === 'number') {
          const delta = BigInt(post) - BigInt(pre) + (k === 0 ? BigInt(meta.fee ?? 0) : 0n);
          if (delta !== 0n) {
            let other = '';
            let best = 0n;
            keys.forEach((key, j) => {
              if (j === k) return;
              const d = BigInt(meta.postBalances?.[j] ?? 0) - BigInt(meta.preBalances?.[j] ?? 0);
              if ((delta > 0n ? -d : d) > best) {
                best = delta > 0n ? -d : d;
                other = key;
              }
            });
            const inbound = delta > 0n;
            found.push({ id: `${signature}:sol`, at: new Date(at).toISOString(), direction: inbound ? 'in' : 'out', from: inbound ? other : a.address, to: inbound ? a.address : other, asset: c.native.symbol, amount: decimal(inbound ? delta : -delta, c.native.decimals), tx: signature });
          }
        }
      }
      // Tokens: the wallet's change per watched mint, summed over its token accounts.
      for (const [sym, t] of mints) {
        const sum = (list: TokenBal[] | undefined, owner: (o: string | undefined) => boolean) =>
          (list ?? []).filter((b) => b.mint === t.id && owner(b.owner)).reduce((s, b) => s + (/^\d{1,30}$/.test(b.uiTokenAmount?.amount ?? '') ? BigInt(b.uiTokenAmount!.amount!) : 0n), 0n);
        const mine = (x: string | undefined) => x === a.address;
        const delta = sum(meta.postTokenBalances, mine) - sum(meta.preTokenBalances, mine);
        if (delta === 0n) continue;
        // The counterparty: the other owner whose balance of this mint moved the opposite way the most.
        const owners = new Set([...(meta.preTokenBalances ?? []), ...(meta.postTokenBalances ?? [])].filter((b) => b.mint === t.id && b.owner && b.owner !== a.address).map((b) => b.owner!));
        let other = '';
        let best = 0n;
        for (const ow of owners) {
          const d = sum(meta.postTokenBalances, (x) => x === ow) - sum(meta.preTokenBalances, (x) => x === ow);
          const v = delta > 0n ? -d : d;
          if (v > best) [best, other] = [v, ow];
        }
        const inbound = delta > 0n;
        found.push({ id: `${signature}:${sym}`, at: new Date(at).toISOString(), direction: inbound ? 'in' : 'out', from: inbound ? other : a.address, to: inbound ? a.address : other, asset: `${sym}:${t.id}`, amount: decimal(inbound ? delta : -delta, t.decimals), tx: signature });
      }
    });
    return finish(chain, a, found, full || newest.length > SOL_TXS);
  }

  async function solanaBalance(chain: ChainId, address: string, signal?: AbortSignal): Promise<WalletBalanceRead> {
    const c: ChainInfo = CHAINS[chain];
    const accounts = tokensFor(c, undefined).flatMap(([symbol, token]) => {
      const pubkey = associatedTokenAccount(address, token.id);
      return pubkey ? [{ pubkey, symbol, token }] : [];
    });
    // One batch: the coin, then each associated token account (a missing account answers an error: a zero balance).
    const res = await rpc(chain, [['getBalance', [address]], ...accounts.map((x) => ['getTokenAccountBalance', [x.pubkey]] as [string, unknown[]])], signal, undefined, true);
    const bal = res[0];
    if (!isObj(bal) || typeof bal.value !== 'number') throw toolError('rpc_failed');
    const balances = [{ symbol: c.native.symbol, asset: c.native.symbol, amount: decimal(BigInt(bal.value), c.native.decimals) }];
    accounts.forEach((x, i) => {
      const r = res[i + 1];
      const raw = isObj(r) && isObj(r.value) ? r.value.amount : undefined;
      const n = typeof raw === 'string' && /^\d{1,30}$/.test(raw) ? BigInt(raw) : 0n;
      if (n > 0n) balances.push({ symbol: x.symbol, asset: `${x.symbol}:${x.token.id}`, amount: decimal(n, x.token.decimals) });
    });
    return { chain, address, exists: true, balances };
  }

  // ---- Bitcoin ----

  type BtcTx = { txid?: string; status?: { confirmed?: boolean; block_time?: number }; vin?: { prevout?: { scriptpubkey_address?: string; value?: number } }[]; vout?: { scriptpubkey_address?: string; value?: number }[] };

  async function bitcoinPayments(chain: ChainId, a: PaymentsArgs, signal?: AbortSignal): Promise<WalletPaymentsRead> {
    const c: ChainInfo = CHAINS[chain];
    if (a.asset !== undefined && a.asset !== 'native') return { chain, address: a.address, payments: [], truncated: false };
    const list = await mempool(chain, `/address/${a.address}/txs`, signal);
    if (list === null) throw toolError('bad_args');
    if (!Array.isArray(list)) throw toolError('rpc_failed');
    const since = now() - a.since_s * 1000;
    const found: WalletPayment[] = [];
    for (const tx of list as BtcTx[]) {
      if (typeof tx?.txid !== 'string') continue;
      // Confirmed only, timed by their block: an unconfirmed one would be seen again once it confirms (a second alert).
      if (!tx.status?.confirmed || typeof tx.status.block_time !== 'number') continue;
      const at = tx.status.block_time * 1000;
      if (at < since) continue;
      const spent = (tx.vin ?? []).filter((v) => v.prevout?.scriptpubkey_address === a.address).reduce((s, v) => s + BigInt(v.prevout?.value ?? 0), 0n);
      const got = (tx.vout ?? []).filter((v) => v.scriptpubkey_address === a.address).reduce((s, v) => s + BigInt(v.value ?? 0), 0n);
      const delta = got - spent;
      if (delta === 0n) continue;
      const inbound = delta > 0n;
      const other = inbound
        ? (tx.vin ?? []).map((v) => v.prevout?.scriptpubkey_address).find((x) => x && x !== a.address) ?? ''
        : [...(tx.vout ?? [])].filter((v) => v.scriptpubkey_address && v.scriptpubkey_address !== a.address).sort((x, y) => (y.value ?? 0) - (x.value ?? 0))[0]?.scriptpubkey_address ?? '';
      found.push({ id: tx.txid, at: new Date(at).toISOString(), direction: inbound ? 'in' : 'out', from: inbound ? other : a.address, to: inbound ? a.address : other, asset: c.native.symbol, amount: decimal(inbound ? delta : -delta, 8), tx: tx.txid });
    }
    const last = (list as BtcTx[])[list.length - 1];
    const windowOpen = list.length >= 25 && (!last?.status?.block_time || last.status.block_time * 1000 >= since);
    return finish(chain, a, found, windowOpen);
  }

  async function bitcoinBalance(chain: ChainId, address: string, signal?: AbortSignal): Promise<WalletBalanceRead> {
    const j = await mempool(chain, `/address/${address}`, signal);
    if (j === null) throw toolError('bad_args');
    const s = (k: string) => (isObj(j) && isObj(j[k]) ? (j[k] as Record<string, unknown>) : null);
    const chainStats = s('chain_stats');
    const pool = s('mempool_stats');
    if (!chainStats || !pool) throw toolError('rpc_failed');
    const n = (o: Record<string, unknown>, k: string) => BigInt(typeof o[k] === 'number' ? (o[k] as number) : 0);
    const sats = n(chainStats, 'funded_txo_sum') - n(chainStats, 'spent_txo_sum') + n(pool, 'funded_txo_sum') - n(pool, 'spent_txo_sum');
    const exists = n(chainStats, 'tx_count') + n(pool, 'tx_count') > 0n;
    return { chain, address, exists, balances: [{ symbol: 'BTC', asset: 'BTC', amount: decimal(sats, 8) }] };
  }

  // ---- Stellar (the existing Horizon reads) ----

  async function stellarPayments(chain: ChainId, a: PaymentsArgs, signal?: AbortSignal): Promise<WalletPaymentsRead> {
    const c: ChainInfo = CHAINS[chain];
    if (a.asset === 'USDT') return { chain, address: a.address, payments: [], truncated: false };
    const asset = a.asset === 'native' ? 'XLM' : a.asset === 'USDC' ? c.tokens.USDC!.id : undefined;
    if (a.min_amount !== undefined && !/^\d{1,15}(\.\d{1,7})?$/.test(a.min_amount)) throw toolError('bad_args');
    const r = await o.payments.stellarPayments(
      { account: a.address, network: c.stellarNetwork!, direction: a.direction, since_s: a.since_s, limit: a.limit, ...(asset ? { asset } : {}), ...(a.min_amount ? { min_amount: a.min_amount } : {}) },
      signal,
    );
    return { chain, address: a.address, payments: r.payments.map(({ kind: _k, ...p }) => p), truncated: r.truncated };
  }

  async function stellarBalance(chain: ChainId, address: string, signal?: AbortSignal): Promise<WalletBalanceRead> {
    const c: ChainInfo = CHAINS[chain];
    const r = (await o.chain.stellarRead({ kind: 'account', id: address, network: c.stellarNetwork! }, signal)) as { exists: boolean; balances?: { asset: string; balance: string }[] };
    if (!r.exists) return { chain, address, exists: false, balances: [] };
    const list = r.balances ?? [];
    const xlm = list.find((b) => b.asset === 'XLM');
    const usdc = list.find((b) => b.asset === c.tokens.USDC!.id);
    const balances = [{ symbol: 'XLM', asset: 'XLM', amount: xlm ? decimal(units(xlm.balance, 7), 7) : '0' }];
    if (usdc && units(usdc.balance, 7) > 0n) balances.push({ symbol: 'USDC', asset: usdc.asset, amount: decimal(units(usdc.balance, 7), 7) });
    return { chain, address, exists: true, balances };
  }

  return {
    async walletPayments(a: PaymentsArgs, signal?: AbortSignal): Promise<WalletPaymentsRead> {
      if (!addressFits(a.chain, a.address)) throw toolError('address_not_on_chain');
      const fam = (CHAINS[a.chain] as ChainInfo).family;
      if (fam === 'evm') return evmPayments(a.chain, a, signal);
      if (fam === 'solana') return solanaPayments(a.chain, a, signal);
      if (fam === 'bitcoin') return bitcoinPayments(a.chain, a, signal);
      return stellarPayments(a.chain, a, signal);
    },
    async walletBalance(a: z.output<typeof WalletBalanceArgs>, signal?: AbortSignal): Promise<WalletBalanceRead> {
      if (!addressFits(a.chain, a.address)) throw toolError('address_not_on_chain');
      const fam = (CHAINS[a.chain] as ChainInfo).family;
      if (fam === 'evm') return evmBalance(a.chain, a.address, signal);
      if (fam === 'solana') return solanaBalance(a.chain, a.address, signal);
      if (fam === 'bitcoin') return bitcoinBalance(a.chain, a.address, signal);
      return stellarBalance(a.chain, a.address, signal);
    },
  };
}
