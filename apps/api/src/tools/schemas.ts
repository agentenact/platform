/**
 * Input schemas of every v1 tool (zod 4). Shared by the toolbox (the model's tool inputs) and by specs
 * (a condition trigger's fetch args are checked when the spec is saved). Pure: imports nothing of ours.
 */
import { z } from 'zod';

/** Symbols the Reflector CEX/DEX feeds quote (assets(): testnet read live 2026-10-05, pubnet 2026-10-12; identical). */
export const REFLECTOR_SYMBOLS = ['BTC', 'ETH', 'USDT', 'XRP', 'SOL', 'USDC', 'ADA', 'AVAX', 'DOT', 'MATIC', 'LINK', 'DAI', 'ATOM', 'XLM', 'UNI', 'EURC'] as const;

export const WebSearchArgs = z.object({ query: z.string().min(1).max(400), count: z.number().int().min(1).max(10).optional() }).strict();
export const WebReadArgs = z.object({ url: z.string().min(1).max(2000) }).strict();
/** Which Stellar network a read tool queries. Mainnet is read-only (see networks.ts). */
export const NetworkArg = z.enum(['testnet', 'mainnet']).default('testnet');
export const StellarPriceArgs = z.object({ symbol: z.enum(REFLECTOR_SYMBOLS), network: NetworkArg }).strict();
export const StellarPriceChangeArgs = z.object({ symbol: z.enum(REFLECTOR_SYMBOLS), window_s: z.number().int().min(300).max(86_400), network: NetworkArg }).strict();
export const StellarReadArgs = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('account'), id: z.string().regex(/^G[A-Z2-7]{55}$/), network: NetworkArg }).strict(),
  z.object({ kind: z.literal('transaction'), hash: z.string().regex(/^[0-9a-f]{64}$/), network: NetworkArg }).strict(),
]);
/**
 * Recent payments of one account (P4 Task 4). Poll with `since_s` equal to the condition's `every_s` so each
 * payment is seen by one check, and keep `cooldown_s` at least `since_s`.
 */
export const StellarPaymentsArgs = z
  .object({
    account: z.string().regex(/^G[A-Z2-7]{55}$/),
    network: NetworkArg,
    asset: z.string().regex(/^(XLM|[A-Za-z0-9]{1,12}:G[A-Z2-7]{55})$/).optional(),
    min_amount: z.string().regex(/^\d{1,15}(\.\d{1,7})?$/).optional(),
    direction: z.enum(['in', 'out', 'both']).default('both'),
    since_s: z.number().int().min(300).max(86_400).default(3600),
    limit: z.number().int().min(1).max(20).default(10),
  })
  .strict();
/** Chains `wallet_payments` / `wallet_balance` read (tools/wallets.ts holds their sources). Read-only on every one. */
export const CHAIN_IDS = ['stellar', 'ethereum', 'base', 'arbitrum', 'optimism', 'polygon', 'celo', 'solana', 'bitcoin', 'stellar-testnet', 'ethereum-sepolia', 'base-sepolia', 'arbitrum-sepolia', 'avalanche-fuji', 'polygon-amoy', 'solana-devnet', 'bitcoin-testnet4'] as const;
export type ChainId = (typeof CHAIN_IDS)[number];
/**
 * Any address some chain accepts: what a spec may store. Whether it belongs to the chosen chain is checked when the tool
 * runs (`address_not_on_chain`) and before a draft is handed off, never here: the chain and the wallet are edited one at a time.
 */
export const ANY_ADDRESS = /^(0x[0-9a-fA-F]{40}|G[A-Z2-7]{55}|[1-9A-HJ-NP-Za-km-z]{25,44}|(bc1|tb1)[02-9ac-hj-np-z]{11,87})$/;
/** Recent payments of one wallet on one chain. Pair the window with the check cadence like stellar_payments. */
export const WalletPaymentsArgs = z
  .object({
    chain: z.enum(CHAIN_IDS),
    address: z.string().regex(ANY_ADDRESS),
    asset: z.enum(['native', 'USDC', 'USDT']).optional(),
    min_amount: z.string().regex(/^\d{1,15}(\.\d{1,8})?$/).optional(),
    direction: z.enum(['in', 'out', 'both']).default('both'),
    since_s: z.number().int().min(300).max(86_400).default(3600),
    limit: z.number().int().min(1).max(20).default(10),
  })
  .strict();
export const WalletBalanceArgs = z.object({ chain: z.enum(CHAIN_IDS), address: z.string().regex(ANY_ADDRESS) }).strict();
export const MarketPriceArgs = z
  .object({ ids: z.array(z.string().regex(/^[a-z0-9-]{1,64}$/)).min(1).max(10) })
  .strict()
  .refine((a) => new Set(a.ids).size === a.ids.length, 'ids must be unique');
export const ComputeArgs = z.object({ code: z.string().min(1).max(4000), input: z.unknown().optional() }).strict();
export const SendEmailArgs = z.object({ subject: z.string().min(1).max(120).regex(/^[^\x00-\x1f\x7f]+$/), text: z.string().min(1).max(10_000) }).strict();
export const SendWebhookArgs = z.object({ text: z.string().min(1).max(10_000), data: z.record(z.string(), z.unknown()).optional() }).strict();
export const RememberArgs = z.object({ key: z.string().regex(/^[a-z0-9][a-z0-9_.-]{0,63}$/), value: z.string().max(2000) }).strict();
export const LoadSkillArgs = z.object({ name: z.string().regex(/^[a-z0-9][a-z0-9-]{0,63}$/) }).strict();

/** The free read tools a condition trigger may fetch with (spec §4), keyed by tool name. */
export const CONDITION_ARGS = {
  stellar_price: StellarPriceArgs,
  stellar_price_change: StellarPriceChangeArgs,
  stellar_read: StellarReadArgs,
  stellar_payments: StellarPaymentsArgs,
  wallet_payments: WalletPaymentsArgs,
  wallet_balance: WalletBalanceArgs,
  market_price: MarketPriceArgs,
} as const;

const LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]']);
/**
 * A URL an agent may pay: https, since plain http lets anyone on the path rewrite the 402 payment
 * requirements. Plain http is allowed only on loopback, for local tests; safeFetch refuses loopback in production.
 */
export const hireUrl = z
  .url({ protocol: /^https?$/ })
  .max(500)
  .refine((u) => {
    const { protocol, hostname } = new URL(u);
    return protocol === 'https:' || LOOPBACK_HOSTS.has(hostname);
  }, 'must be https (plain http only on loopback)');

// hireUrl (defined above, P3a Task 2): https, plain http only on loopback.
export const FindAgentsArgs = z.object({ query: z.string().max(64).optional(), limit: z.number().int().min(1).max(25).optional(), cursor: z.string().max(128).optional() }).strict();
export const GetAgentArgs = z.object({ agent_id: z.string().regex(/^\d{1,10}$/) }).strict();
export const VerifyRecordArgs = z.object({ record: z.union([z.string().max(16_384), z.record(z.string(), z.unknown())]), output: z.string().max(200_000).optional(), input: z.string().max(200_000).optional() }).strict();
export const HireAgentArgs = z.object({ url: hireUrl, input: z.unknown().optional() }).strict();
