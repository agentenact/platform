/** Stellar amounts carry 7 decimals. These helpers convert between decimal strings and integer units. */

export function parseUnits7(decimal: string): bigint {
  const m = /^(\d+)(?:\.(\d{1,7}))?$/.exec(decimal.trim());
  if (!m) throw new Error('invalid amount: expected a non-negative decimal with at most 7 fractional digits');
  return BigInt(m[1]!) * 10_000_000n + BigInt((m[2] ?? '').padEnd(7, '0'));
}

export function formatUnits7(units: bigint): string {
  if (units < 0n) throw new Error('invalid amount: negative');
  const whole = units / 10_000_000n;
  const frac = (units % 10_000_000n).toString().padStart(7, '0').replace(/0+$/, '');
  return frac ? `${whole}.${frac}` : `${whole}`;
}
