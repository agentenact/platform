/**
 * The words table (spec §5) as patterns. Mirrors apps/api/src/builder/words.ts exactly (tests/words.test.ts fails on any
 * drift), plus the panel-only address patterns. Whole-word, case-insensitive. "wallet" alone is allowed; "smart wallet"
 * and "passkey" are banned; shortened addresses like GABC…WXYZ are fine, only full 56-character ones are banned.
 */
export const API_BANNED: readonly RegExp[] = [
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

/** Panel-only: full account addresses (G... / C..., 56 characters) and long hex strings. */
export const ADDRESS_PATTERNS: readonly RegExp[] = [/\bG[A-Z2-7]{55}\b/, /\bC[A-Z2-7]{55}\b/, /0x[0-9a-f]{8,}/i];

export const BANNED: readonly RegExp[] = [...API_BANNED, ...ADDRESS_PATTERNS];

/** The first banned word in `text`, or null. */
export function bannedWord(text: string): string | null {
  for (const re of BANNED) {
    const m = re.exec(text);
    if (m) return m[0];
  }
  return null;
}
