import { describe, expect, it } from 'bun:test';
import { formatUnits7, parseUnits7 } from '../src/chain/units.js';

describe('units7', () => {
  it('parses and formats 7-decimal amounts', () => {
    expect(parseUnits7('0.001')).toBe(10000n);
    expect(parseUnits7('0.0010000')).toBe(10000n);
    expect(parseUnits7('12')).toBe(120000000n);
    expect(formatUnits7(10000n)).toBe('0.001');
    expect(formatUnits7(0n)).toBe('0');
    expect(formatUnits7(120000000n)).toBe('12');
    expect(formatUnits7(1n)).toBe('0.0000001');
    expect(formatUnits7(parseUnits7('922337203685.4775807'))).toBe('922337203685.4775807');
  });

  it('rejects 8 decimals and negatives', () => {
    expect(() => parseUnits7('0.00000001')).toThrow();
    expect(() => parseUnits7('-1')).toThrow();
    expect(() => parseUnits7('')).toThrow();
    expect(() => parseUnits7('1e3')).toThrow();
    expect(() => formatUnits7(-1n)).toThrow();
  });
});
