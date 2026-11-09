/**
 * The agent's own wallets, as the panel shows them: one per network it can pay on (signer/hire.ts HIRE_NETWORKS).
 * The Stellar one exists from birth; an EVM or Solana one is made by the vault when the owner opens it (or on the
 * agent's first hire there). Balances are best-effort public reads: a failed read shows no number, never a zero.
 */
import type { Db } from '../db/index.js';
import { httpError } from '../errors.js';
import { EVM_TESTNETS, SOLANA_DEVNET, type EvmTestnet, type SolanaDevnet } from '../keys/contract.js';
import type { AgentKeys } from '../keys/rpc.js';
import type { ChainId } from '../tools/schemas.js';
import type { WalletBalanceRead } from '../tools/wallets.js';

export type WalletNetwork = 'stellar:testnet' | EvmTestnet | SolanaDevnet;

export interface AgentWallet {
  network: WalletNetwork;
  label: string;
  /** null: not opened yet (EVM and Solana). */
  address: string | null;
  /** USDC held, as the chain reports it; null when unknown (no wallet yet, or the read failed). */
  usdc: string | null;
  /** Everything the wallet holds, the native coin first ([] for a wallet the chain has never seen); null when unknown. */
  assets: { symbol: string; amount: string }[] | null;
  explorer: string | null;
  /** Stellar only: who holds the account's reserves (agents/reserve.ts). free: the platform; due: the agent buys them at its first funding; self_paid: the agent. */
  reserve?: 'free' | 'due' | 'self_paid';
}

/** How the panel names and reads each EVM testnet: label, the wallet-read chain, the explorer's address page. */
const EVM_PANEL: Record<EvmTestnet, { label: string; chain: ChainId; explorer: string }> = {
  'eip155:84532': { label: 'Base Sepolia', chain: 'base-sepolia', explorer: 'https://sepolia.basescan.org/address/' },
  'eip155:421614': { label: 'Arbitrum Sepolia', chain: 'arbitrum-sepolia', explorer: 'https://sepolia.arbiscan.io/address/' },
  'eip155:43113': { label: 'Avalanche Fuji', chain: 'avalanche-fuji', explorer: 'https://testnet.snowtrace.io/address/' },
  'eip155:80002': { label: 'Polygon Amoy', chain: 'polygon-amoy', explorer: 'https://amoy.polygonscan.com/address/' },
};

const NETWORKS: { network: WalletNetwork; label: string; chain: ChainId; explorer: (a: string) => string }[] = [
  { network: 'stellar:testnet', label: 'Stellar testnet', chain: 'stellar-testnet', explorer: (a) => `https://stellar.expert/explorer/testnet/account/${a}` },
  ...(Object.keys(EVM_TESTNETS) as EvmTestnet[]).map((n) => ({ network: n, ...EVM_PANEL[n], explorer: (a: string) => `${EVM_PANEL[n].explorer}${a}` })),
  { network: SOLANA_DEVNET.network, label: 'Solana devnet', chain: 'solana-devnet', explorer: (a) => `https://explorer.solana.com/address/${a}?cluster=devnet` },
];
const family = (n: WalletNetwork) => (n === 'stellar:testnet' ? 'stellar' : n === SOLANA_DEVNET.network ? 'solana' : 'evm');

export interface AgentWallets {
  list(userId: string, agentId: string): Promise<AgentWallet[]>;
  /** Makes the agent's wallet on `network` (EVM testnets and Solana devnet) and returns the list. Active agents only. */
  open(userId: string, agentId: string, network: string): Promise<AgentWallet[]>;
}

export function createAgentWallets(d: {
  sql: Db;
  keys: Pick<AgentKeys, 'publicKey' | 'evmAddress' | 'evmWallet' | 'solanaAddress' | 'solanaWallet'>;
  balance?: (a: { chain: ChainId; address: string }) => Promise<WalletBalanceRead>;
}): AgentWallets {
  async function own(userId: string, agentId: string): Promise<{ status: string; reserve_state: AgentWallet['reserve'] }> {
    const rows = (await d.sql`select status, reserve_state from app.agents where id = ${agentId} and user_id = ${userId}`) as { status: string; reserve_state: AgentWallet['reserve'] }[];
    if (!rows[0]) throw httpError(404, 'not_found');
    return rows[0];
  }

  async function held(chain: ChainId, address: string): Promise<{ usdc: string | null; assets: AgentWallet['assets'] }> {
    if (!d.balance) return { usdc: null, assets: null };
    try {
      const b = await d.balance({ chain, address });
      if (!b.exists) return { usdc: '0', assets: [] };
      const assets = b.balances.map((x) => ({ symbol: x.symbol, amount: x.amount }));
      return { usdc: assets.find((x) => x.symbol === 'USDC')?.amount ?? '0', assets };
    } catch {
      return { usdc: null, assets: null };
    }
  }

  async function list(agentId: string, reserve: AgentWallet['reserve']): Promise<AgentWallet[]> {
    const [stellar, evm, solana] = await Promise.all([d.keys.publicKey(agentId), d.keys.evmAddress(agentId), d.keys.solanaAddress(agentId)]);
    const of = { stellar, evm, solana };
    return Promise.all(
      NETWORKS.map(async (n) => {
        const address = of[family(n.network)];
        const h = address ? await held(n.chain, address) : { usdc: null, assets: null };
        return {
          network: n.network,
          label: n.label,
          address,
          ...h,
          explorer: address ? n.explorer(address) : null,
          ...(n.network === 'stellar:testnet' && address && reserve ? { reserve } : {}),
        };
      }),
    );
  }

  return {
    async list(userId, agentId) {
      return list(agentId, (await own(userId, agentId)).reserve_state);
    },
    async open(userId, agentId, network) {
      const a = await own(userId, agentId);
      const solana = network === SOLANA_DEVNET.network;
      if (!solana && !Object.hasOwn(EVM_TESTNETS, network)) throw httpError(400, 'bad_network');
      if (a.status !== 'active') throw httpError(409, 'not_active');
      await (solana ? d.keys.solanaWallet(agentId, network) : d.keys.evmWallet(agentId, network));
      return list(agentId, a.reserve_state);
    },
  };
}
