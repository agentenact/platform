/**
 * The vault's contract: the operations it offers and its refusals (what it will not sign, and why). Types and
 * plain helpers only, so the api can use them without loading the vault or the key store.
 */
import type { EnactmentRecord, UnsignedEnactmentRecord } from 'agentenact';

export type VaultRefusalCode =
  | 'no_key'
  | 'not_provisioning'
  | 'not_active'
  | 'wrong_network'
  | 'bad_payload'
  | 'wrong_wallet'
  | 'wrong_owner'
  | 'over_call_cap'
  | 'over_day_cap'
  | 'record_exists'
  | 'not_deleted';

/**
 * The EVM networks the vault signs for: testnets only, each with its pinned USDC (6 decimals) and record chain. One EVM key
 * serves them all (same address). Hire tries them in this order after Stellar. Which facilitator settles is the seller's
 * choice: x402.org covers Base Sepolia, PayAI's public one also the other three (both checked 2026-11-01).
 */
export const EVM_TESTNETS = {
  'eip155:84532': { chain: 'base', usdc: '0x036cbd53842c5426634e7929541ec2318f3dcf7e' },
  'eip155:421614': { chain: 'arbitrum', usdc: '0x75faf114eafb1bdbe2f0316df893fd58ce46aa4d' },
  'eip155:43113': { chain: 'avalanche', usdc: '0x5425890298aed601595a70ab815c96711a31bc65' },
  'eip155:80002': { chain: 'polygon', usdc: '0x41e94eb019c0762f9bfcf9fb1e58725bfb0e7582' },
} as const;
export type EvmTestnet = keyof typeof EVM_TESTNETS;
/**
 * Solana devnet, the only Solana network the vault signs for: Circle's devnet USDC (6 decimals, classic Token program).
 * Its fee is paid by the seller's facilitator (x402.org and PayAI both list it, checked 2026-11-01); the agent pays only USDC.
 */
export const SOLANA_DEVNET = {
  network: 'solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1',
  usdc: '4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU',
} as const;
export type SolanaDevnet = typeof SOLANA_DEVNET.network;
export const isSolanaAddress = (s: unknown): s is string => typeof s === 'string' && /^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(s);
export interface VaultRefusal extends Error {
  code: 'vault_refused';
  reason: VaultRefusalCode;
}

export const vaultRefusal = (reason: VaultRefusalCode): VaultRefusal =>
  Object.assign(new Error(`vault: refused: ${reason}`), { code: 'vault_refused' as const, reason });
export const isVaultRefusal = (e: unknown): e is VaultRefusal => !!e && typeof e === 'object' && (e as { code?: unknown }).code === 'vault_refused';

export interface Vault {
  generate(agentId: string): Promise<{ publicKey: string }>;
  destroy(agentId: string): Promise<void>;
  publicKey(agentId: string): Promise<string | null>;
  webhookSecret(agentId: string): Promise<string>;
  /** Signature (base64) over the birth tx hash. */
  signBirthTx(agentId: string, envelopeXdr: string, networkPassphrase: string): Promise<string>;
  /** Signature (base64) over the bind auth-entry preimage hash. */
  signBindEntry(agentId: string, preimage: string): Promise<string>;
  signRecord(agentId: string, unsigned: UnsignedEnactmentRecord): Promise<EnactmentRecord>;
  /** Signature (base64) over a USDC transfer auth-entry preimage hash. */
  signPayment(agentId: string, preimage: string): Promise<string>;
  /** The agent's EVM address (lowercase) if it has one; never creates it. */
  evmAddress(agentId: string): Promise<string | null>;
  /** The agent's EVM wallet (lowercase) on an EVM testnet; created on the first call for an active agent. */
  evmWallet(agentId: string, network: string): Promise<string>;
  /** Signature (0x hex) over an EIP-3009 USDC authorization from the agent's EVM key, within the cross-chain caps. */
  signEvmPayment(agentId: string, network: string, typedData: unknown): Promise<string>;
  /** The agent's Solana address (base58) if it has one; never creates it. */
  solanaAddress(agentId: string): Promise<string | null>;
  /** The agent's Solana devnet wallet (base58); created on the first call for an active agent. */
  solanaWallet(agentId: string, network: string): Promise<string>;
  /**
   * Signature (base58) over an x402 exact transfer message (base64) from the agent's Solana key to `payTo`, decoded and
   * checked by the vault (agentenact/signer decodeSolanaTransfer), within the cross-chain caps.
   */
  signSolanaPayment(agentId: string, network: string, message: string, payTo: string): Promise<string>;
  /** An Enactment Record for a settlement on an EVM testnet, signed EIP-191 by the agent's EVM key. */
  signEvmRecord(agentId: string, network: string, unsigned: UnsignedEnactmentRecord): Promise<EnactmentRecord>;
  /**
   * Signature (base64) over the agent's own check-seal tx (seals/tx.ts shape: a no-op bump_sequence carrying the seal's
   * hash as its memo), for an active or paused agent, at most SEALS_PER_AGENT_DAY a day.
   */
  signSeal(agentId: string, txXdr: string, networkPassphrase: string): Promise<string>;
  /**
   * Signature (base64) over a deleted agent's own close tx (agents/close-tx.ts: a sweep to its owner, or the trustline
   * removal and account merge to its owner or the sponsor). Only once the owner deleted the agent (status revoked).
   */
  signClose(agentId: string, txXdr: string, networkPassphrase: string): Promise<string>;
  /**
   * Signature (base64) over the agent's part of a reserve tx (agents/reserve-tx.ts), sourced by the platform sponsor: a
   * handover for a live agent whose reserves are due (its repay exactly reserve_repay_stroops), a topup for a live
   * self-paying one (both within HANDOVERS_PER_AGENT_DAY), a responsor for a deleted one.
   */
  signReserve(agentId: string, txXdr: string, networkPassphrase: string): Promise<string>;
  /** The platform sponsor's account. */
  sponsorPublicKey(): Promise<string>;
  /** The sponsor-sourced tx, signed (envelope XDR): only the shapes of chain/sponsor.ts, within the day fee cap. */
  signSponsorTx(txXdr: string, networkPassphrase: string): Promise<string>;
}
