import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { randomBytes } from 'node:crypto';
import { Keypair } from '@stellar/stellar-sdk';
import { createWalletHistory } from '../src/agents/wallet-history.js';
import type { Db } from '../src/db/index.js';
import { createKeys } from '../src/keys/index.js';
import { localAgentKeys, type AgentKeys } from '../src/keys/rpc.js';
import { createVault } from '../src/keys/vault.js';
import { createPayments } from '../src/tools/payments.js';
import type { SafeFetch } from '../src/tools/safe-fetch.js';
import { freshDb } from './support/db.js';
import { activeAgent } from './support/specs.js';

const NOW = Date.parse('2026-10-29T12:00:00Z');
const USDC_ISSUER = 'GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5';
const enc = (j: unknown) => new TextEncoder().encode(JSON.stringify(j));
const addr = (hash: string, extra: Record<string, unknown> = {}) => ({ hash, is_contract: false, name: null, ...extra });

/** Horizon /payments: a hire paid in USDC through the SAC (as x402 settles), a friendbot top-up, and an old payment out of the window. */
function horizon(me: string, payee: string, hireTx: string) {
  return {
    _embedded: {
      records: [
        {
          id: '300', type: 'invoke_host_function', created_at: '2026-10-29T11:00:00Z', transaction_hash: hireTx, transaction_successful: true,
          asset_balance_changes: [{ asset_type: 'credit_alphanum4', asset_code: 'USDC', asset_issuer: USDC_ISSUER, type: 'transfer', from: me, to: payee, amount: '0.0100000' }],
        },
        { id: '200', type: 'payment', created_at: '2026-10-28T09:00:00Z', transaction_hash: 'f1'.repeat(32), asset_type: 'native', from: 'GAIH3ULLFQ4DGSECF2AR555KZ4KNDGEKN4AFI4SU2M7B43MGK3QJZNSR', to: me, amount: '10000.0000000' },
        { id: '100', type: 'payment', created_at: '2026-08-01T09:00:00Z', transaction_hash: 'f2'.repeat(32), asset_type: 'native', from: me, to: payee, amount: '1.0000000' },
      ],
    },
  };
}

/** Blockscout: a USDC→WETH trade, a failed call, plain ETH received, and an airdropped scam token. */
function blockscout(me: string) {
  const router = `0x${'77'.repeat(20)}`;
  const funder = `0x${'88'.repeat(20)}`;
  return {
    transactions: {
      items: [
        { hash: `0x${'c1'.repeat(32)}`, timestamp: '2026-10-29T10:00:00.000000Z', status: 'ok', value: '0', from: addr(me), to: addr(router, { is_contract: true }), method: 'swapExactTokensForTokens' },
        { hash: `0x${'c2'.repeat(32)}`, timestamp: '2026-10-29T09:00:00.000000Z', status: 'error', value: '0', from: addr(me), to: addr(router, { is_contract: true }), method: 'swapExactTokensForTokens' },
        { hash: `0x${'c3'.repeat(32)}`, timestamp: '2026-10-28T09:00:00.000000Z', status: 'ok', value: '50000000000000000', from: addr(funder), to: addr(me) },
      ],
      next_page_params: null,
    },
    transfers: {
      items: [
        { transaction_hash: `0x${'c1'.repeat(32)}`, timestamp: '2026-10-29T10:00:00.000000Z', type: 'token_transfer', from: addr(me), to: addr(router), token: { symbol: 'USDC', decimals: '6', reputation: 'ok' }, total: { decimals: '6', value: '2500000' } },
        { transaction_hash: `0x${'c1'.repeat(32)}`, timestamp: '2026-10-29T10:00:00.000000Z', type: 'token_transfer', from: addr(router), to: addr(me), token: { symbol: 'WETH', decimals: '18', reputation: 'ok' }, total: { decimals: '18', value: '1000000000000000' } },
        { transaction_hash: `0x${'c4'.repeat(32)}`, timestamp: '2026-10-29T08:00:00.000000Z', type: 'token_transfer', from: addr(funder), to: addr(me), token: { symbol: 'Claim at evil.test', decimals: '18', reputation: 'scam' }, total: { decimals: '18', value: '1' } },
        { transaction_hash: `0x${'c5'.repeat(32)}`, timestamp: '2026-10-29T07:00:00.000000Z', type: 'token_transfer', from: addr(funder), to: addr(me), token: { symbol: 'visit evil.test', decimals: '6', reputation: 'ok' }, total: { decimals: '6', value: '1000000' } },
      ],
      next_page_params: null,
    },
  };
}

describe('wallet history', () => {
  let sql: Db;
  let drop: () => Promise<void>;
  let keys: AgentKeys;
  beforeAll(async () => {
    ({ sql, drop } = await freshDb());
    keys = localAgentKeys(createVault({ sql, keys: createKeys(sql, { KEYS_MASTER_SECRET: randomBytes(32).toString('base64') }) }));
  });
  afterAll(() => drop());

  const setup = async (o: { evm?: boolean; fail?: RegExp } = {}) => {
    const a = await activeAgent(sql);
    const { publicKey } = await keys.generate(a.agentId);
    const evm = o.evm ? (await keys.evmWallet(a.agentId, 'eip155:84532')).toLowerCase() : null;
    const payee = Keypair.random().publicKey();
    const hireTx = 'a1'.repeat(32).replace(/^a1/, randomBytes(1).toString('hex'));
    const calls: string[] = [];
    const safeFetch: SafeFetch = async (url) => {
      calls.push(url);
      if (o.fail?.test(url)) return { status: 503, url, contentType: 'application/json', headers: new Headers(), body: enc({}) };
      const b = evm ? blockscout(evm) : null;
      const json = url.includes('horizon') ? horizon(publicKey, payee, hireTx) : url.endsWith('/token-transfers') ? b!.transfers : b!.transactions;
      return { status: 200, url, contentType: 'application/json', headers: new Headers(), body: enc(json) };
    };
    let now = NOW;
    const decisions = async (_: string, runIds: string[]) => new Map(runIds.map((r) => [r, { status: 'sent' as const, tx: 'd'.repeat(64) }]));
    const history = createWalletHistory({ sql, keys, safeFetch, stellarPayments: (a) => createPayments({ safeFetch, now: () => now }).stellarPayments(a), seals: { decisions }, now: () => now });
    return { ...a, publicKey, evm, payee, hireTx, calls, history, tick: (ms: number) => (now += ms) };
  };

  it('reads the Stellar wallet: a hire with its sealed decision, a top-up, nothing older than the window', async () => {
    const s = await setup();
    const [run] = (await sql`insert into app.runs (agent_id, mode, status, ended_at) values (${s.agentId}, 'mission', 'done', now()) returning id`) as { id: string }[];
    await sql`insert into app.spend (agent_id, run_id, url, payee, amount_usdc, tx_hash, decision) values (${s.agentId}, ${run!.id}, 'https://s.test', ${s.payee}, 0.01, ${s.hireTx}, 'settled')`;
    const [stellar, base] = await s.history.list(s.userId, s.agentId);
    expect(base).toEqual({ network: 'eip155:84532', label: 'Base Sepolia', state: 'none', txs: [] });
    expect(stellar!.state).toBe('ok');
    expect(stellar!.txs).toEqual([
      { hash: s.hireTx, at: '2026-10-29T11:00:00Z', kind: 'hire', ok: true, moves: [{ direction: 'out', symbol: 'USDC', amount: '0.01' }], counterparty: s.payee, runId: run!.id, decision: { status: 'sent', tx: 'd'.repeat(64) } },
      { hash: 'f1'.repeat(32), at: '2026-10-28T09:00:00Z', kind: 'received', ok: true, moves: [{ direction: 'in', symbol: 'XLM', amount: '10000' }], counterparty: 'GAIH3ULLFQ4DGSECF2AR555KZ4KNDGEKN4AFI4SU2M7B43MGK3QJZNSR' },
    ]);
  });

  it('reads the Base Sepolia wallet: a trade as one swap, a failed call, coin received, scam tokens dropped, odd symbols plain', async () => {
    const s = await setup({ evm: true });
    const base = (await s.history.list(s.userId, s.agentId))[1]!;
    expect(base.state).toBe('ok');
    expect(base.txs.map((t) => [t.hash.slice(0, 2), t.kind, t.ok, t.moves])).toEqual([
      ['c1', 'swap', true, [{ direction: 'out', symbol: 'USDC', amount: '2.5' }, { direction: 'in', symbol: 'WETH', amount: '0.001' }]],
      ['c2', 'other', false, []],
      ['c5', 'received', true, [{ direction: 'in', symbol: '?', amount: '1' }]],
      ['c3', 'received', true, [{ direction: 'in', symbol: 'ETH', amount: '0.05' }]],
    ]);
    expect(base.txs.every((t) => /^[0-9a-f]{64}$/.test(t.hash))).toBe(true);
    expect(JSON.stringify(base)).not.toContain('evil');
    expect(s.calls.filter((u) => u.includes('blockscout'))).toEqual([
      `https://base-sepolia.blockscout.com/api/v2/addresses/${s.evm}/transactions?filter=from`,
      `https://base-sepolia.blockscout.com/api/v2/addresses/${s.evm}/transactions?filter=to`,
      `https://base-sepolia.blockscout.com/api/v2/addresses/${s.evm}/token-transfers`,
      `https://arbitrum-sepolia.blockscout.com/api/v2/addresses/${s.evm}/transactions?filter=from`,
      `https://arbitrum-sepolia.blockscout.com/api/v2/addresses/${s.evm}/transactions?filter=to`,
      `https://arbitrum-sepolia.blockscout.com/api/v2/addresses/${s.evm}/token-transfers`,
    ]);
  });

  it('a failed chain read says unavailable, never an empty list, and is tried again soon', async () => {
    const s = await setup({ evm: true, fail: /blockscout/ });
    const [stellar, base] = await s.history.list(s.userId, s.agentId);
    expect(stellar!.state).toBe('ok');
    expect(base).toEqual({ network: 'eip155:84532', label: 'Base Sepolia', state: 'unavailable', txs: [] });
    const n = s.calls.length;
    await s.history.list(s.userId, s.agentId);
    expect(s.calls.length).toBe(n);
    s.tick(15_000);
    await s.history.list(s.userId, s.agentId);
    expect(s.calls.length).toBeGreaterThan(n);
  });

  it('answers from memory for a minute, and only to the owner', async () => {
    const s = await setup();
    await s.history.list(s.userId, s.agentId);
    const n = s.calls.length;
    s.tick(30_000);
    await s.history.list(s.userId, s.agentId);
    expect(s.calls.length).toBe(n);
    s.tick(31_000);
    await s.history.list(s.userId, s.agentId);
    expect(s.calls.length).toBe(n + 1);
    const other = await activeAgent(sql);
    expect(await s.history.list(other.userId, s.agentId).then(() => 200, (e: { status?: number }) => e.status)).toBe(404);
  });
});
