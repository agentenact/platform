/** "78423bdf0afa22…3b4da47e17aebadd" — head/tail, monospace-friendly. */
export function shorten(value: string, head = 10, tail = 8): string {
  if (value.length <= head + tail + 1) return value;
  return `${value.slice(0, head)}…${value.slice(-tail)}`;
}

/** Tampering flips the last hex char, so a forged record differs from the real one by one character. */
export function forge(sha256: string): string {
  const last = sha256.slice(-1);
  return sha256.slice(0, -1) + (last === 'a' ? 'b' : 'a');
}
