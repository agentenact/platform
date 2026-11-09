import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { randomBytes } from 'node:crypto';
import type { Db } from '../src/db/index.js';
import { createAgentWallets, type AgentWallets } from '../src/agents/wallets.js';
import { createKeys } from '../src/keys/index.js';
import { localAgentKeys, type AgentKeys } from '../src/keys/rpc.js';
import { createVault } from '../src/keys/vault.js';
import { freshDb } from './support/db.js';
import { activeAgent } from './support/specs.js';

const SOLANA = 'solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1';
const status = async (p: Promise<unknown>) => p.then(() => 200, (e: { status?: number; code?: string }) => e.status ?? e.code);

describe('agent wallets', () => {
  let sql: Db;
  let drop: () => Promise<void>;
  let keys: AgentKeys;
  let wallets: AgentWallets;
  let failBalance = false;
  beforeAll(async () => {
    ({ sql, drop } = await freshDb());
    keys = localAgentKeys(createVault({ sql, keys: createKeys(sql, { KEYS_MASTER_SECRET: randomBytes(32).toString('base64') }) }));
    wallets = createAgentWallets({
      sql,
      keys,
      balance: async (a) => {
        if (failBalance) throw new Error('rpc_failed');
        return { chain: a.chain, address: a.address, exists: true, balances: [{ symbol: a.chain === 'base-sepolia' ? 'ETH' : 'XLM', asset: 'native', amount: '1' }, { symbol: 'USDC', asset: 'x', amount: '2.5' }] };
      },
    });
  });
  afterAll(() => drop());

  const agent = async () => {
    const a = await activeAgent(sql);
    const { publicKey } = await keys.generate(a.agentId);
    return { ...a, publicKey };
  };

  it('lists the Stellar wallet and an unopened slot per EVM testnet, then opens the one EVM key for all of them, once', async () => {
    const a = await agent();
    const before = await wallets.list(a.userId, a.agentId);
    expect(before).toEqual([
      { network: 'stellar:testnet', label: 'Stellar testnet', address: a.publicKey, usdc: '2.5', assets: [{ symbol: 'XLM', amount: '1' }, { symbol: 'USDC', amount: '2.5' }], explorer: `https://stellar.expert/explorer/testnet/account/${a.publicKey}`, reserve: 'free' },
      { network: 'eip155:84532', label: 'Base Sepolia', address: null, usdc: null, assets: null, explorer: null },
      { network: 'eip155:421614', label: 'Arbitrum Sepolia', address: null, usdc: null, assets: null, explorer: null },
      { network: 'eip155:43113', label: 'Avalanche Fuji', address: null, usdc: null, assets: null, explorer: null },
      { network: 'eip155:80002', label: 'Polygon Amoy', address: null, usdc: null, assets: null, explorer: null },
      { network: SOLANA, label: 'Solana devnet', address: null, usdc: null, assets: null, explorer: null },
    ]);
    const after = await wallets.open(a.userId, a.agentId, 'eip155:84532');
    const evm = after[1]!.address!;
    expect(evm).toMatch(/^0x[0-9a-f]{40}$/);
    expect(after[1]).toMatchObject({ usdc: '2.5', assets: [{ symbol: 'ETH', amount: '1' }, { symbol: 'USDC', amount: '2.5' }], explorer: `https://sepolia.basescan.org/address/${evm}` });
    expect((await wallets.open(a.userId, a.agentId, 'eip155:84532'))[1]!.address).toBe(evm);
    // One key: the other EVM testnets show the same address, each with its own explorer.
    expect(after.slice(2, 5).map((w) => [w.address, w.explorer])).toEqual([
      [evm, `https://sepolia.arbiscan.io/address/${evm}`],
      [evm, `https://testnet.snowtrace.io/address/${evm}`],
      [evm, `https://amoy.polygonscan.com/address/${evm}`],
    ]);
    expect((await wallets.open(a.userId, a.agentId, 'eip155:80002'))[4]!.address).toBe(evm);
    // Solana is its own key, opened on its own.
    expect(after[5]!.address).toBeNull();
    const sol = (await wallets.open(a.userId, a.agentId, SOLANA))[5]!;
    expect(sol.address).toMatch(/^[1-9A-HJ-NP-Za-km-z]{32,44}$/);
    expect(sol).toMatchObject({ usdc: '2.5', explorer: `https://explorer.solana.com/address/${sol.address}?cluster=devnet` });
    expect((await wallets.open(a.userId, a.agentId, SOLANA))[5]!.address).toBe(sol.address);
  });

  it('a failed balance read shows no number, never a zero', async () => {
    const a = await agent();
    failBalance = true;
    try {
      expect((await wallets.list(a.userId, a.agentId))[0]).toMatchObject({ usdc: null, assets: null });
    } finally {
      failBalance = false;
    }
  });

  it('another user\'s agent is a 404; a paused agent or a mainnet id opens nothing', async () => {
    const a = await agent();
    const b = await agent();
    expect(await status(wallets.list(b.userId, a.agentId))).toBe(404);
    expect(await status(wallets.open(b.userId, a.agentId, 'eip155:84532'))).toBe(404);
    expect(await status(wallets.open(a.userId, a.agentId, 'eip155:8453'))).toBe(400);
    expect(await status(wallets.open(a.userId, a.agentId, 'solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp'))).toBe(400);
    await sql`update app.agents set status = 'paused' where id = ${a.agentId}`;
    expect(await status(wallets.open(a.userId, a.agentId, 'eip155:84532'))).toBe(409);
    expect(await status(wallets.open(a.userId, a.agentId, SOLANA))).toBe(409);
    expect((await wallets.list(a.userId, a.agentId))[1]!.address).toBeNull();
  });
});
