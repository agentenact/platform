import { describe, expect, it } from 'bun:test';
import { unitsToUsdc, usdcToUnits } from '../src/signer/usdc.js';

describe('usdc units', () => {
  it('converts both ways at 7 decimals', () => {
    expect([usdcToUnits('0.05'), usdcToUnits('0.0100000'), usdcToUnits('1'), usdcToUnits('0.0000001')]).toEqual([500_000n, 100_000n, 10_000_000n, 1n]);
    expect([unitsToUsdc(10_000n), unitsToUsdc('500000'), unitsToUsdc(0n)]).toEqual(['0.0010000', '0.0500000', '0.0000000']);
    expect(() => usdcToUnits('0.00000001')).toThrow();
    expect(() => usdcToUnits('-1')).toThrow();
  });
  it('unitsToUsdc accepts only non-negative integers', () => {
    for (const bad of ['-5', ' 7', '0x10', '1.5', '', '1e3', -5n] as const) expect(() => unitsToUsdc(bad)).toThrow();
    expect(unitsToUsdc('0010000')).toBe('0.0010000');
  });
});
