export type ExclusionReason = 'asset' | 'owner' | 'self' | 'sponsor';

/**
 * Why a transfer to an agent's wallet does not count, or null when it does. Checked in this order, asset first.
 * Addresses compare exactly (strkeys are case-sensitive). Everything else, human buyers included, counts.
 *
 * Decided once, at poll time, from the owner and sponsors as they were then. It is stored (`counted`, `excluded_reason`)
 * and never re-evaluated: a later owner change or sponsor-list change does not reclassify rows already written.
 */
export function exclusionReason(
  t: { from: string; to: string; asset: string },
  agent: { owner: string; wallet: string },
  cfg: { usdc: string; sponsors: string[] },
): ExclusionReason | null {
  if (t.asset !== cfg.usdc) return 'asset';
  // Owner top-ups are excluded only when the owner is a different account from the wallet. For an unbound owner-mode
  // agent (wallet === owner) the owner's personal incoming USDC is counted too; Kerem accepted that trade-off (2026-10-12).
  if (agent.owner !== agent.wallet && t.from === agent.owner) return 'owner';
  if (t.from === agent.wallet) return 'self';
  if (cfg.sponsors.includes(t.from)) return 'sponsor';
  return null;
}
