/**
 * Whether a wallet param fits the network param beside it, so the /create builder can say so before a trial fails. Formats
 * only: the api's tools/wallets.ts `addressFits` is the real check (it also decodes a Solana key), run on trial and handoff.
 */
import type { DraftData } from './draft-types';

const FORMATS: Record<string, RegExp> = {
  stellar: /^G[A-Z2-7]{55}$/,
  evm: /^0x[0-9a-fA-F]{40}$/,
  solana: /^[1-9A-HJ-NP-Za-km-z]{32,44}$/,
  bitcoin: /^(bc1[02-9ac-hj-np-z]{11,87}|[13][1-9A-HJ-NP-Za-km-z]{25,34})$/,
};
const FAMILY: Record<string, keyof typeof FORMATS> = {
  stellar: 'stellar',
  ethereum: 'evm',
  base: 'evm',
  arbitrum: 'evm',
  optimism: 'evm',
  polygon: 'evm',
  celo: 'evm',
  solana: 'solana',
  bitcoin: 'bitcoin',
};

/** The network's label when the draft's wallet is not an address of it; null when it fits or the draft has no such pair. */
export function walletMismatch(d: DraftData): string | null {
  const chain = d.params.find((p) => p.id === 'chain' && p.kind === 'choice');
  const wallet = d.params.find((p) => p.id === 'account' && p.kind === 'text');
  if (!chain || !wallet || chain.kind !== 'choice') return null;
  const family = FAMILY[String(chain.value)];
  if (!family || FORMATS[family]!.test(String(wallet.value))) return null;
  return chain.options.find((o) => o.value === chain.value)?.label ?? String(chain.value);
}
