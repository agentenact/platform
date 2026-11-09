import { describe, expect, it } from 'bun:test';
import { addressFits, CHAINS, createWalletReads, decimal, units } from '../src/tools/wallets.js';
import { associatedTokenAccount, encodeBase58, onCurve } from '../src/tools/solana-ata.js';
import { decodeBase58 } from '../src/base58.js';
import { createPayments } from '../src/tools/payments.js';
import { createChainReads } from '../src/tools/chain.js';
import { WalletBalanceArgs, WalletPaymentsArgs } from '../src/tools/schemas.js';
import { parseSpec } from '../src/specs/schema.js';
import { readingOf } from '../src/checks/readings.js';
import { conditionRuleProblem, walletProblem } from '../src/builder/scope.js';
import { applyParam } from '../src/builder/params.js';
import { handoffProblem } from '../src/builder/handoff.js';
import { bigUsdc, lowBalance, watchAccount } from '../src/builder/examples.js';
import type { SafeFetchOptions } from '../src/tools/safe-fetch.js';
import { fakeSafeFetch } from './support/safe-fetch.js';

const NOW = Date.parse('2026-10-28T16:20:00Z');
const sec = (s: number) => Math.floor((NOW - s * 1000) / 1000);
const hex = (n: number | bigint) => `0x${n.toString(16)}`;

const EVM_ME = '0x4cfc111e7aa7b1594b3699cdf48521073bd723e6';
const EVM_OTHER = '0xb80d90fcf2ed0e4febe02d2a209109bf1f62df95';
const SOL_ME = '9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM';
const SOL_ME_USDC = 'FGETo8T8wMcN2wCjav8VK6eh3dLk63evNDPxzLSJra8B'; // its USDC associated account, as getTokenAccountsByOwner listed it (2026-10-28)
const SOL_OTHER = 'EZRQsM26KwDrWy3AcLXQgzW14VMps6sRcUGHuYDtCpjY';
const SOL_USDC = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';
const BTC_ME = 'bc1qm34lsc65zpw79lxes69zkqmk6ee3ewf0j77s3h';
const BTC_OTHER = 'bc1qlj9amslge3yvc5mjqxp7spqy897s8cavu70lcu';
const G_ME = 'GDO73LCGQTKWCEKQ55C5BUBOFKGCAXXOP6MZ35YQ6BRSQKCKDDSAWECM';
const BASE_USDC = '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913';
const BASE_USDT = '0xfde4c96c8593536e31f229ea8f37b2ada2699bb2';
const TRANSFER = '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef';
const topic = (a: string) => `0x${'0'.repeat(24)}${a.slice(2)}`;

/** What a Solana node answers for an account that was never created. */
const NO_ACCOUNT = Symbol('no account');
type Call = { jsonrpc: string; id: number; method: string; params: unknown[] };
/** A JSON-RPC node: answers each batch entry through `answer` (undefined → a JSON-RPC error), as the real nodes do. */
function node(url: string, answer: (c: Call) => unknown) {
  return fakeSafeFetch((u, o: SafeFetchOptions) => {
    if (u !== url) return undefined;
    const body = JSON.parse(String(o.body)) as Call | Call[];
    const one = (c: Call) => {
      const r = answer(c);
      if (r === NO_ACCOUNT) return { jsonrpc: '2.0', id: c.id, error: { code: -32602, message: 'Invalid param: could not find account' } };
      return r === undefined ? { jsonrpc: '2.0', id: c.id, error: { code: -32601, message: 'method not found' } } : { jsonrpc: '2.0', id: c.id, result: r };
    };
    return { body: Array.isArray(body) ? body.map(one) : one(body) };
  });
}
const reads = (sf: ReturnType<typeof fakeSafeFetch>, env: Record<string, string> = {}) =>
  createWalletReads({ safeFetch: sf, payments: createPayments({ safeFetch: sf, now: () => NOW }), chain: createChainReads({ safeFetch: sf, now: () => NOW }), env, now: () => NOW });
const pargs = (a: Record<string, unknown>) => WalletPaymentsArgs.parse(a);

describe('addresses', () => {
  it('each chain takes only its own wallets', () => {
    expect(addressFits('base', EVM_ME)).toBe(true);
    expect(addressFits('base', G_ME)).toBe(false);
    expect(addressFits('stellar', G_ME)).toBe(true);
    expect(addressFits('stellar', EVM_ME)).toBe(false);
    expect(addressFits('solana', SOL_ME)).toBe(true);
    expect(addressFits('solana', BTC_ME)).toBe(false);
    expect(addressFits('solana', '1'.repeat(32))).toBe(false); // 32 zero bytes: never a real account
    expect(addressFits('solana', '3J98t1WpEZ73CNmQviecrnyiWrnqRhWNLy')).toBe(false); // a Bitcoin legacy address: 25 bytes
    expect(addressFits('bitcoin', BTC_ME)).toBe(true);
    expect(addressFits('bitcoin', '3J98t1WpEZ73CNmQviecrnyiWrnqRhWNLy')).toBe(true);
    expect(addressFits('bitcoin', 'tb1qw508d6qejxtdg4y5r3zarvary0c5xw7kxpjzsx')).toBe(false);
    expect(addressFits('bitcoin-testnet4', 'tb1qw508d6qejxtdg4y5r3zarvary0c5xw7kxpjzsx')).toBe(true);
  });
  it('the schema stores any chain’s wallet and refuses the rest', () => {
    for (const address of [EVM_ME, G_ME, SOL_ME, BTC_ME]) expect(WalletBalanceArgs.safeParse({ chain: 'base', address }).success).toBe(true);
    for (const address of ['', 'not an address', '0x1234', `G${'A'.repeat(54)}`]) expect(WalletBalanceArgs.safeParse({ chain: 'base', address }).success).toBe(false);
    expect(WalletBalanceArgs.safeParse({ chain: 'dogecoin', address: EVM_ME }).success).toBe(false);
  });
});

describe('solana associated token account', () => {
  it('derives the account wallets and RPCs use', () => {
    expect(associatedTokenAccount(SOL_ME, SOL_USDC)).toBe(SOL_ME_USDC);
    expect(associatedTokenAccount('not a key', SOL_USDC)).toBeNull();
  });
  it('base58 round-trips and the curve check knows a real key from a derived one', () => {
    expect(encodeBase58(decodeBase58(SOL_ME)!)).toBe(SOL_ME);
    expect(encodeBase58(Uint8Array.of(0, 0, 1))).toBe('112');
    expect(onCurve(decodeBase58(SOL_ME)!)).toBe(true);
    expect(onCurve(decodeBase58(SOL_ME_USDC)!)).toBe(false);
  });
});

describe('amounts', () => {
  it('units and decimal are exact and cut, never round', () => {
    expect(units('10000', 6)).toBe(10_000_000_000n);
    expect(units('0.1234567', 6)).toBe(123_456n);
    expect(decimal(123_456n, 6)).toBe('0.123456');
    expect(decimal(43_953_569_088_218_408_947_054n, 18)).toBe('43953.569088218408947054');
    expect(decimal(10n ** 18n, 18)).toBe('1');
    expect(decimal(0n, 8)).toBe('0');
  });
});

describe('wallet_payments on EVM', () => {
  const URL = CHAINS.base.url!;
  const TIP = 37_478_444n;
  // A log as base-rpc.publicnode.com returns it (2026-10-28): blockTimestamp present, removed false.
  const log = (o: { from: string; to: string; amount: bigint; block: bigint; index: number; token?: string; stamp?: boolean; tx?: string }) => ({
    address: o.token ?? BASE_USDC,
    topics: [TRANSFER, topic(o.from), topic(o.to)],
    data: `0x${o.amount.toString(16).padStart(64, '0')}`,
    blockNumber: hex(o.block),
    transactionHash: o.tx ?? `0x${o.index.toString(16).padStart(64, 'a')}`,
    transactionIndex: '0x13',
    blockHash: `0x${'2c'.repeat(32)}`,
    ...(o.stamp === false ? {} : { blockTimestamp: hex(sec(Number(TIP - o.block) * 2)) }),
    logIndex: hex(o.index),
    removed: false,
  });
  const chainOf = (logs: ReturnType<typeof log>[]) =>
    node(URL, (c) => {
      if (c.method === 'eth_blockNumber') return hex(TIP);
      if (c.method === 'eth_getLogs') {
        const f = c.params[0] as { topics: (string | null)[]; fromBlock: string; address: string[] };
        expect(BigInt(f.fromBlock)).toBe(TIP - 210n); // 420 s at 2 s a block
        expect(f.address).toEqual([BASE_USDC, BASE_USDT]);
        return logs.filter((l) => (f.topics[1] ? l.topics[1] === f.topics[1] : l.topics[2] === f.topics[2]));
      }
      if (c.method === 'eth_getBlockByNumber') return { number: c.params[0], timestamp: hex(sec(Number(TIP - BigInt(c.params[0] as string)) * 2)), hash: `0x${'1'.repeat(64)}` };
      return undefined;
    });

  it('reads USDC/USDT transfers both ways, newest first, with exact amounts', async () => {
    const sf = chainOf([
      log({ from: EVM_ME, to: EVM_OTHER, amount: 103_749_627n, block: TIP - 1n, index: 2 }),
      log({ from: EVM_OTHER, to: EVM_ME, amount: 54_790_992n, block: TIP - 10n, index: 7, token: BASE_USDT, stamp: false }),
    ]);
    const r = await reads(sf).walletPayments(pargs({ chain: 'base', address: EVM_ME, since_s: 420 }));
    expect(r.payments.map((p) => [p.direction, p.asset, p.amount, p.from, p.to])).toEqual([
      ['out', `USDC:${BASE_USDC}`, '103.749627', EVM_ME, EVM_OTHER],
      ['in', `USDT:${BASE_USDT}`, '54.790992', EVM_OTHER, EVM_ME],
    ]);
    expect(r.truncated).toBe(false);
    // One header fetched: the log without blockTimestamp.
    const bodies = sf.calls.map((c) => String(c.o.body));
    expect(bodies.filter((b) => b.includes('eth_getBlockByNumber'))).toHaveLength(1);
  });

  it('a self transfer is one payment; min_amount, direction and asset filter', async () => {
    const sf = chainOf([
      log({ from: EVM_ME, to: EVM_ME, amount: 5_000_000n, block: TIP - 3n, index: 1 }),
      log({ from: EVM_OTHER, to: EVM_ME, amount: 20_000_000_000n, block: TIP - 4n, index: 4 }),
    ]);
    const w = reads(sf);
    expect((await w.walletPayments(pargs({ chain: 'base', address: EVM_ME, since_s: 420 }))).payments).toHaveLength(2);
    expect((await w.walletPayments(pargs({ chain: 'base', address: EVM_ME, since_s: 420, min_amount: '10000' }))).payments.map((p) => p.amount)).toEqual(['20000']);
    expect((await w.walletPayments(pargs({ chain: 'base', address: EVM_ME, since_s: 420, direction: 'in' }))).payments.map((p) => p.amount)).toEqual(['20000']);
  });

  it('a checksummed address matches its lowercase logs', async () => {
    const sf = chainOf([log({ from: EVM_OTHER, to: EVM_ME, amount: 1_000_000n, block: TIP - 1n, index: 0 })]);
    const r = await reads(sf).walletPayments(pargs({ chain: 'base', address: '0x4CFC111e7aa7b1594b3699cdf48521073bd723e6', since_s: 420 }));
    expect(r.payments).toHaveLength(1);
    expect(r.payments[0]!.direction).toBe('in');
  });

  it('native coin moves are refused (no log), as are windows past one hour and other chains’ wallets', async () => {
    const w = reads(chainOf([]));
    await expect(w.walletPayments(pargs({ chain: 'base', address: EVM_ME, asset: 'native' }))).rejects.toMatchObject({ code: 'native_transfers_unreadable' });
    await expect(w.walletPayments(pargs({ chain: 'base', address: EVM_ME, since_s: 7200 }))).rejects.toMatchObject({ code: 'window_too_long' });
    await expect(w.walletPayments(pargs({ chain: 'base', address: G_ME }))).rejects.toMatchObject({ code: 'address_not_on_chain' });
  });

  it('a node error or a non-200 is rpc_failed, never an empty answer', async () => {
    const limited = node(URL, (c) => (c.method === 'eth_blockNumber' ? hex(TIP) : undefined));
    await expect(reads(limited).walletPayments(pargs({ chain: 'base', address: EVM_ME, since_s: 420 }))).rejects.toMatchObject({ code: 'rpc_failed' });
    const down = fakeSafeFetch(() => ({ status: 503, body: 'busy' }));
    await expect(reads(down).walletPayments(pargs({ chain: 'base', address: EVM_ME, since_s: 420 }))).rejects.toMatchObject({ code: 'rpc_failed' });
  });

  it('RPC_URL_<CHAIN> points a chain at another node', async () => {
    const sf = node('https://base.example-rpc.com/k', (c) => (c.method === 'eth_blockNumber' ? hex(TIP) : c.method === 'eth_getLogs' ? [] : undefined));
    expect((await reads(sf, { RPC_URL_BASE: 'https://base.example-rpc.com/k' }).walletPayments(pargs({ chain: 'base', address: EVM_ME, since_s: 420 }))).payments).toEqual([]);
  });
});

describe('wallet_balance on EVM', () => {
  it('the coin first, then the stablecoins it holds', async () => {
    const sf = node(CHAINS.base.url!, (c) => {
      if (c.method === 'eth_getBalance') return '0x94eb72d5b6bd37f7a26e'; // 703,256.8… ETH: an exchange wallet
      if (c.method === 'eth_call') return (c.params[0] as { to: string }).to === BASE_USDC ? `0x${(79_709_105_020n).toString(16).padStart(64, '0')}` : `0x${'0'.repeat(64)}`;
      return undefined;
    });
    const r = await reads(sf).walletBalance({ chain: 'base', address: EVM_ME });
    expect(r.exists).toBe(true);
    expect(r.balances.map((b) => [b.symbol, b.amount])).toEqual([
      ['ETH', decimal(0x94eb72d5b6bd37f7a26en, 18)],
      ['USDC', '79709.10502'],
    ]);
  });
});

describe('wallet_payments and wallet_balance on Solana', () => {
  const URL = CHAINS.solana.url!;
  const tokenBal = (owner: string, accountIndex: number, amount: string) => ({ accountIndex, mint: SOL_USDC, owner, programId: 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA', uiTokenAmount: { amount, decimals: 6, uiAmount: Number(amount) / 1e6, uiAmountString: String(Number(amount) / 1e6) } });
  const key = (pubkey: string, signer = false) => ({ pubkey, signer, source: 'transaction', writable: true });
  // getTransaction (jsonParsed) shapes from api.mainnet-beta.solana.com, 2026-10-28.
  const TXS: Record<string, unknown> = {
    solIn: { blockTime: sec(60), slot: 1, meta: { err: null, fee: 5301, preBalances: [3_034_947_455, 20_000_000, 11_175_975_429_787_702], postBalances: [3_008_942_154, 20_000_000, 11_175_975_442_787_702], preTokenBalances: [], postTokenBalances: [] }, transaction: { message: { accountKeys: [key(SOL_OTHER, true), key('7cPrd7imFfp43HMNFWxkhPpRPKcLiLWV4emM4PbUUAoa'), key(SOL_ME)] }, signatures: ['solIn'] } },
    usdcIn: { blockTime: sec(120), slot: 2, meta: { err: null, fee: 5000, preBalances: [1, 2, 3], postBalances: [1, 2, 3], preTokenBalances: [tokenBal(SOL_OTHER, 1, '900000000'), tokenBal(SOL_ME, 2, '1107086785')], postTokenBalances: [tokenBal(SOL_OTHER, 1, '650000000'), tokenBal(SOL_ME, 2, '1357086785')] }, transaction: { message: { accountKeys: [key(SOL_OTHER, true), key('FzbcyEZ9m8xjtergWgWDq7mfPoHEbboBF791B6cTpzbq'), key(SOL_ME_USDC)] }, signatures: ['usdcIn'] } },
    failed: { blockTime: sec(30), slot: 3, meta: { err: { InstructionError: [0, 'Custom'] }, fee: 5000, preBalances: [10, 0], postBalances: [5, 5], preTokenBalances: [], postTokenBalances: [] }, transaction: { message: { accountKeys: [key(SOL_ME, true), key(SOL_OTHER)] }, signatures: ['failed'] } },
  };
  const sig = (signature: string, ago: number, err: unknown = null) => ({ signature, slot: 1, err, memo: null, blockTime: sec(ago), confirmationStatus: 'finalized' });
  const solana = (o: { usdcAccount?: boolean; limited?: boolean } = {}) =>
    node(URL, (c) => {
      if (o.limited) return undefined;
      if (c.method === 'getSignaturesForAddress') {
        const who = c.params[0];
        if (who === SOL_ME) return [sig('failed', 30, { InstructionError: [0, 'Custom'] }), sig('solIn', 60), sig('old', 3000)];
        if (who === SOL_ME_USDC) return [sig('usdcIn', 120)];
        return [];
      }
      if (c.method === 'getTransaction') return TXS[c.params[0] as string] ?? null;
      if (c.method === 'getBalance') return { context: { apiVersion: '4.3.2', slot: 462_537_301 }, value: 11_175_975_442_787_702 };
      if (c.method === 'getTokenAccountBalance') return c.params[0] === SOL_ME_USDC && o.usdcAccount !== false ? { context: { slot: 1 }, value: { amount: '1357086785', decimals: 6, uiAmount: 1357.086785, uiAmountString: '1357.086785' } } : NO_ACCOUNT;
      return undefined;
    });

  it('reads coin and USDC moves from the wallet and its USDC account; failed and old ones are skipped', async () => {
    const r = await reads(solana()).walletPayments(pargs({ chain: 'solana', address: SOL_ME, since_s: 420 }));
    expect(r.payments.map((p) => [p.direction, p.asset, p.amount, p.from, p.to])).toEqual([
      ['in', 'SOL', '0.013', SOL_OTHER, SOL_ME],
      ['in', `USDC:${SOL_USDC}`, '250', SOL_OTHER, SOL_ME],
    ]);
  });

  it('asset USDC watches only the USDC account', async () => {
    const sf = solana();
    const r = await reads(sf).walletPayments(pargs({ chain: 'solana', address: SOL_ME, since_s: 420, asset: 'USDC' }));
    expect(r.payments.map((p) => p.amount)).toEqual(['250']);
    expect(String(sf.calls[0]!.o.body)).not.toContain(`"${SOL_ME}"`);
  });

  it('balance: the coin and USDC; a missing token account is a zero, a rate limit is a failure', async () => {
    expect((await reads(solana()).walletBalance({ chain: 'solana', address: SOL_ME })).balances).toEqual([
      { symbol: 'SOL', asset: 'SOL', amount: '11175975.442787702' },
      { symbol: 'USDC', asset: `USDC:${SOL_USDC}`, amount: '1357.086785' },
    ]);
    const missing = fakeSafeFetch((u, o) => {
      if (u !== URL) return undefined;
      const calls = JSON.parse(String(o.body)) as Call[];
      return { body: calls.map((c) => (c.method === 'getBalance' ? { jsonrpc: '2.0', id: c.id, result: { context: { slot: 1 }, value: 0 } } : { jsonrpc: '2.0', id: c.id, error: { code: -32602, message: 'Invalid param: could not find account' } })) };
    });
    expect((await reads(missing).walletBalance({ chain: 'solana', address: SOL_ME })).balances).toEqual([{ symbol: 'SOL', asset: 'SOL', amount: '0' }]);
    const limited = fakeSafeFetch((u, o) => {
      const calls = JSON.parse(String(o.body)) as Call[];
      return { body: calls.map((c) => ({ jsonrpc: '2.0', id: c.id, error: { code: 429, message: 'Too many requests for a specific RPC call' } })) };
    });
    await expect(reads(limited).walletBalance({ chain: 'solana', address: SOL_ME })).rejects.toMatchObject({ code: 'rpc_failed' });
  });
});

describe('wallet_payments and wallet_balance on Bitcoin', () => {
  // mempool.space shapes (2026-10-28), trimmed to the fields read.
  const tx = (txid: string, o: { confirmed: boolean; ago?: number; vin: [string, number][]; vout: [string, number][] }) => ({
    txid,
    version: 2,
    locktime: 0,
    vin: o.vin.map(([a, v]) => ({ txid: 'ce'.repeat(32), vout: 1, prevout: { scriptpubkey: '0014', scriptpubkey_type: 'v0_p2wpkh', scriptpubkey_address: a, value: v }, sequence: 4294967293 })),
    vout: o.vout.map(([a, v]) => ({ scriptpubkey: '0014', scriptpubkey_type: 'v0_p2wpkh', scriptpubkey_address: a, value: v })),
    size: 222,
    weight: 561,
    fee: 1410,
    status: o.confirmed ? { confirmed: true, block_height: 972_921, block_hash: '00'.repeat(32), block_time: sec(o.ago!) } : { confirmed: false },
  });
  const mempool = () =>
    fakeSafeFetch((u) => {
      if (u === `https://mempool.space/api/address/${BTC_ME}/txs`)
        return {
          body: [
            tx('pending', { confirmed: false, vin: [[BTC_OTHER, 50_000]], vout: [[BTC_ME, 48_000]] }),
            tx('out1', { confirmed: true, ago: 200, vin: [[BTC_ME, 1_700_000_000]], vout: [[BTC_OTHER, 1_648_024_910], [BTC_ME, 51_973_680]] }),
            tx('in1', { confirmed: true, ago: 300, vin: [[BTC_OTHER, 7_000_000]], vout: [[BTC_ME, 6_019_952], [BTC_OTHER, 978_000]] }),
            tx('old', { confirmed: true, ago: 5000, vin: [[BTC_OTHER, 1]], vout: [[BTC_ME, 1]] }),
          ],
        };
      if (u === `https://mempool.space/api/address/${BTC_ME}`) return { body: { address: BTC_ME, chain_stats: { funded_txo_count: 9, funded_txo_sum: 1_600_000_000_000, spent_txo_count: 4, spent_txo_sum: 2_040_003_042, tx_count: 13 }, mempool_stats: { funded_txo_count: 0, funded_txo_sum: 0, spent_txo_count: 0, spent_txo_sum: 0, tx_count: 0 } } };
      if (u.startsWith('https://mempool.space/api/address/')) return { status: 400, body: 'Invalid Bitcoin address', contentType: 'text/plain' };
      return undefined;
    });

  it('net sats per confirmed transaction; change is not a payment; unconfirmed waits for its block', async () => {
    const r = await reads(mempool()).walletPayments(pargs({ chain: 'bitcoin', address: BTC_ME, since_s: 420 }));
    expect(r.payments.map((p) => [p.id, p.direction, p.amount, p.from, p.to])).toEqual([
      ['out1', 'out', '16.4802632', BTC_ME, BTC_OTHER],
      ['in1', 'in', '0.06019952', BTC_OTHER, BTC_ME],
    ]);
    expect((await reads(mempool()).walletPayments(pargs({ chain: 'bitcoin', address: BTC_ME, since_s: 420, asset: 'USDC' }))).payments).toEqual([]);
  });
  it('balance and an address mempool refuses', async () => {
    expect(await reads(mempool()).walletBalance({ chain: 'bitcoin', address: BTC_ME })).toEqual({ chain: 'bitcoin', address: BTC_ME, exists: true, balances: [{ symbol: 'BTC', asset: 'BTC', amount: '15979.59996958' }] });
    await expect(reads(mempool()).walletBalance({ chain: 'bitcoin', address: '3J98t1WpEZ73CNmQviecrnyiWrnqRhWNLy' })).rejects.toMatchObject({ code: 'bad_args' });
  });
});

describe('wallet_payments and wallet_balance on Stellar (the Horizon reads)', () => {
  const MAIN_USDC = 'USDC:GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN';
  it('asks Horizon with the pinned USDC and drops the internal kind', async () => {
    const sf = fakeSafeFetch((u) => {
      if (u.startsWith(`https://horizon.stellar.org/accounts/${G_ME}/payments`))
        return { body: { _embedded: { records: [{ id: '279960266299744257', type: 'payment', created_at: new Date(NOW - 60_000).toISOString(), transaction_hash: 'ab'.repeat(32), asset_type: 'credit_alphanum4', asset_code: 'USDC', asset_issuer: MAIN_USDC.split(':')[1], from: 'GAFK7XFZHMLSNV7OJTBO7BAIZA66X6QIBV5RMZZYXK4Q7ZSO52J5C3WQ', to: G_ME, amount: '12.5000000' }] } } };
      if (u === `https://horizon.stellar.org/accounts/${G_ME}`) return { body: { id: G_ME, sequence: '1', balances: [{ asset_type: 'credit_alphanum4', asset_code: 'USDC', asset_issuer: MAIN_USDC.split(':')[1], balance: '40.0000000' }, { asset_type: 'native', balance: '32099.9354850' }] } };
      return undefined;
    });
    const r = await reads(sf).walletPayments(pargs({ chain: 'stellar', address: G_ME, asset: 'USDC', since_s: 420 }));
    expect(r.payments).toEqual([{ id: '279960266299744257', at: new Date(NOW - 60_000).toISOString(), direction: 'in', from: 'GAFK7XFZHMLSNV7OJTBO7BAIZA66X6QIBV5RMZZYXK4Q7ZSO52J5C3WQ', to: G_ME, asset: MAIN_USDC, amount: '12.5000000', tx: 'ab'.repeat(32) }]);
    expect((await reads(sf).walletBalance({ chain: 'stellar', address: G_ME })).balances).toEqual([
      { symbol: 'XLM', asset: 'XLM', amount: '32099.935485' },
      { symbol: 'USDC', asset: MAIN_USDC, amount: '40' },
    ]);
  });
  it('a missing account reads as not existing', async () => {
    const r = await reads(fakeSafeFetch(() => undefined)).walletBalance({ chain: 'stellar', address: G_ME });
    expect(r).toEqual({ chain: 'stellar', address: G_ME, exists: false, balances: [] });
  });
});

describe('wallet tools in specs, drafts and readings', () => {
  const cond = (args: Record<string, unknown>, tool = 'wallet_payments') => ({
    persona: 'A calm wallet watcher.',
    system_prompt: 'Watch.',
    tools: ['send_email'],
    triggers: [{ kind: 'condition', fetch: { tool, args }, code: 'return input.payments.length > 0;', every_s: 300, cooldown_s: 420, mission: 'Tell the owner.' }],
    delivery: { email: true },
  });
  it('a spec stores a wallet read on any chain; a bad chain or address is refused', () => {
    expect(parseSpec(cond({ chain: 'solana', address: SOL_ME, since_s: 420 })).ok).toBe(true);
    expect(parseSpec(cond({ chain: 'base', address: EVM_ME }, 'wallet_balance')).ok).toBe(true);
    expect(parseSpec(cond({ chain: 'tron', address: EVM_ME })).ok).toBe(false);
    expect(parseSpec(cond({ chain: 'base', address: 'me' })).ok).toBe(false);
  });
  it('the payment rules apply to wallet_payments, and EVM polls stay within an hour', () => {
    const p = parseSpec({ ...cond({ chain: 'base', address: EVM_ME, since_s: 7200 }), triggers: [{ ...cond({}).triggers[0], fetch: { tool: 'wallet_payments', args: { chain: 'base', address: EVM_ME, since_s: 7200 } }, every_s: 7000, cooldown_s: 7200 }] });
    expect(p.ok).toBe(true);
    if (p.ok) expect(conditionRuleProblem(p.spec)).toContain('at most 3600');
    const q = parseSpec(cond({ chain: 'base', address: EVM_ME, since_s: 300 }));
    if (q.ok) expect(conditionRuleProblem({ ...q.spec, triggers: [{ ...q.spec.triggers[0]!, every_s: 600 } as never] })).toContain('since_s');
  });
  it('a template switches network and wallet one tap at a time; only a final draft must match', () => {
    const step1 = applyParam(watchAccount(), 'chain', 'base');
    expect(step1.ok).toBe(true);
    if (!step1.ok) return;
    expect(walletProblem(step1.draft.spec)).toContain('not a Base wallet address');
    expect('problem' in handoffProblem(step1.draft)).toBe(true);
    const step2 = applyParam(step1.draft, 'account', EVM_ME);
    expect(step2.ok).toBe(true);
    if (!step2.ok) return;
    expect(walletProblem(step2.draft.spec)).toBeNull();
    expect('draft' in handoffProblem(step2.draft)).toBe(true);
    expect(step2.draft.spec.triggers[0]).toMatchObject({ fetch: { tool: 'wallet_payments', args: { chain: 'base', address: EVM_ME } } });
  });
  it('big USDC offers no Bitcoin; low balance reads the coin first', () => {
    const opts = (bigUsdc().params.find((p) => p.id === 'chain') as { options: { value: unknown }[] }).options.map((o) => o.value);
    expect(opts).not.toContain('bitcoin');
    expect(opts).toContain('optimism');
    const lb = lowBalance();
    expect(lb.spec.triggers[0]).toMatchObject({ fetch: { tool: 'wallet_balance' }, params: { min_balance: 100 } });
  });
  it('readings: payments and balances on any chain read in plain words', () => {
    expect(readingOf('wallet_payments', {}, { chain: 'base', address: EVM_ME, payments: [{ id: '1', at: '', direction: 'in', from: EVM_OTHER, to: EVM_ME, asset: `USDC:${BASE_USDC}`, amount: '103.749627', tx: '0x1' }], truncated: false }).line).toBe('1 payment of 103.749627 USDC');
    expect(readingOf('wallet_balance', {}, { chain: 'solana', address: SOL_ME, exists: true, balances: [{ symbol: 'SOL', asset: 'SOL', amount: '1.5' }, { symbol: 'USDC', asset: `USDC:${SOL_USDC}`, amount: '1357.086785' }] })).toEqual({
      reading: { account: '9WzD…AWWM', SOL: 1.5, USDC: 1357.086785 },
      line: '9WzD…AWWM holds 1.5 SOL and 1357.086785 USDC',
    });
    expect(readingOf('wallet_balance', {}, { chain: 'stellar', address: G_ME, exists: false, balances: [] }).line).toBeNull();
  });
});
