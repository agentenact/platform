import { describe, expect, it } from 'bun:test';
import { sealGeometry } from '../../src/lib/seal';

const HASH = '4135af45e93f3646c1657873f49721b73a1f4e2398aa8c976123018901aacf4e';
const FORGED = HASH.slice(0, -1) + 'f';

describe('seal', () => {
  it('draws the same seal for the same hash', () => {
    expect(sealGeometry(HASH)).toEqual(sealGeometry(HASH));
  });

  it('ignores case and surrounding space', () => {
    expect(sealGeometry(` ${HASH.toUpperCase()} `)).toEqual(sealGeometry(HASH));
  });

  it('redraws the whole seal when one character changes', () => {
    const a = sealGeometry(HASH);
    const b = sealGeometry(FORGED);
    expect(b.outline).not.toBe(a.outline);
    expect(b.arcs.map((x) => x.d)).not.toEqual(a.arcs.map((x) => x.d));
  });

  it('stays inside its 200 × 200 box with five rings of two to five arcs', () => {
    for (const h of [HASH, FORGED, '', 'agent:31']) {
      const g = sealGeometry(h);
      const nums = `${g.outline} ${g.arcs.map((x) => x.d).join(' ')}`.match(/-?\d+(\.\d+)?/g)!.map(Number);
      expect(nums.every((n) => n >= 0 && n <= 200)).toBe(true);
      expect(g.arcs.length).toBeGreaterThanOrEqual(10);
      expect(g.arcs.length).toBeLessThanOrEqual(25);
    }
  });
});
