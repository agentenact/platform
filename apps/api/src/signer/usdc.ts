/** Stellar USDC amounts: whole-unit decimal strings <-> base units (7 decimals). The payment guard itself lives in the library's hire(). */
export const USDC_DECIMALS = 7;

export function usdcToUnits(decimal: string): bigint {
  const m = /^(\d{1,12})(?:\.(\d{1,7}))?$/.exec(decimal);
  if (!m) throw new Error(`signer: bad USDC amount ${decimal}`);
  return BigInt(m[1]! + (m[2] ?? '').padEnd(USDC_DECIMALS, '0'));
}

export function unitsToUsdc(units: bigint | string): string {
  if (typeof units === 'string' ? !/^\d+$/.test(units) : typeof units !== 'bigint' || units < 0n) throw new Error('signer: bad USDC units');
  const s = BigInt(units).toString().padStart(USDC_DECIMALS + 1, '0');
  return `${s.slice(0, -USDC_DECIMALS)}.${s.slice(-USDC_DECIMALS)}`;
}
