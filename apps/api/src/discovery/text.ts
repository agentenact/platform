/** A `like` pattern for user text: trimmed, lowercased, `\ % _` escaped, wrapped in %…%. Null for empty or over-long input. */
export function likePattern(q: string): string | null {
  const t = q.trim().toLowerCase();
  if (t.length === 0 || t.length > 64) return null;
  return `%${t.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
}
