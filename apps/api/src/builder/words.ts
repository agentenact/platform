/**
 * The words table (spec §5): technical terms a plain-language text must not contain. Whole-word, case-insensitive.
 * "wallet" alone is allowed (Kerem, 2026-10-12: DeFi users say "watch this wallet"), only "smart wallet" and "passkey"
 * are banned. "testnet" is deliberately absent (it stays visible wherever money or creation is mentioned), and the phrase
 * "free budget" is allowed because it is the table's own wording.
 */
/** The table's main words as a model reads them, for prompts that ask for plain words (BANNED is what is enforced). */
export const PLAIN_WORDS = 'passkey, smart wallet, spec, trigger, cron, condition, token, budget, service, hash, tx, prompt, settlement, agentId';

export const BANNED: readonly RegExp[] = [
  /\bpasskeys?\b/i,
  /\bsmart[ -]wallets?\b/i,
  /\bagentspecs?\b/i,
  /\bspecs?\b/i,
  /\benactments?\b/i,
  /\btx\b/i,
  /\bhash(es)?\b/i,
  /\bsettlements?\b/i,
  /\btokens?\b/i,
  /(?<!\bfree )\bbudgets?\b/i,
  /\btriggers?\b/i,
  /\bcron\b/i,
  /\bconditions?\b/i,
  /\bservices?\b/i,
  /\bagent[ _-]?ids?\b/i,
  /\bprompts?\b/i,
  /\bx402\b/i,
  /\bsoroban\b/i,
  /\bhorizon\b/i,
  /\bxdr\b/i,
];

/** The first banned word in `text`, or null. */
export function bannedWord(text: string): string | null {
  for (const re of BANNED) {
    const m = re.exec(text);
    if (m) return m[0];
  }
  return null;
}
