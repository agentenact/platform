/**
 * The seal: a mark drawn from a string, usually a SHA-256 hex digest. Every shape value comes from a PRNG seeded
 * by the whole string, so one changed character redraws the whole seal. It is a fingerprint for the eye; the proof
 * is still the signature and the settlement. Pure and deterministic: the same string draws the same seal on the
 * server and in the browser.
 */

export interface SealArc {
  d: string;
  width: number;
  opacity: number;
  /** Which of the five rings (0 = outermost) the arc sits on. */
  ring: number;
}

export interface SealGeometry {
  /** The wax outline, a closed path in a 200 × 200 box centred on (100, 100). */
  outline: string;
  /** Five rings of arcs inside it. */
  arcs: SealArc[];
}

const TAU = Math.PI * 2;
const RADII = [68, 57, 46, 35, 24];

/** FNV-1a, 32 bit. */
function fnv1a(s: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

/** mulberry32: a small PRNG, good enough to spread one seed over a few dozen shape values. */
function prng(seed: number): () => number {
  let a = seed;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const fix = (n: number) => n.toFixed(2);
const at = (r: number, a: number) => `${fix(100 + r * Math.cos(a))} ${fix(100 + r * Math.sin(a))}`;

/** `gap` widens the breaks between arcs (1 = the seal as drawn); small marks need wider breaks to read as arcs at all. */
export function sealGeometry(hash: string, gap = 1): SealGeometry {
  const rand = prng(fnv1a(hash.trim().toLowerCase()));

  const p1 = rand() * TAU;
  const p2 = rand() * TAU;
  const p3 = rand() * TAU;
  const k1 = 3 + Math.floor(rand() * 3);
  const k2 = 7 + Math.floor(rand() * 3);
  const steps = 180;
  let outline = '';
  for (let i = 0; i <= steps; i++) {
    const a = (i / steps) * TAU;
    const r = 90 + 3.2 * Math.sin(k1 * a + p1) + 2.2 * Math.sin(k2 * a + p2) + 1.2 * Math.sin(13 * a + p3);
    outline += `${i === 0 ? 'M' : ' L'} ${at(r, a)}`;
  }
  outline += ' Z';

  const arcs: SealArc[] = [];
  RADII.forEach((r, ring) => {
    const n = 2 + Math.floor(rand() * 4);
    const weights = Array.from({ length: n }, () => 1 + rand() * 15);
    const total = weights.reduce((s, w) => s + w, 0);
    const cut = ((r < 30 ? 0.5 : 0.28) / n) * TAU * 0.5 * gap;
    let a = rand() * TAU;
    weights.forEach((w, j) => {
      const span = (w / total) * TAU;
      const a0 = a + cut / 2;
      const a1 = a + span - cut / 2;
      if (a1 > a0) {
        const large = a1 - a0 > Math.PI ? 1 : 0;
        arcs.push({ d: `M ${at(r, a0)} A ${r} ${r} 0 ${large} 1 ${at(r, a1)}`, width: 6.5 - ring * 0.6, opacity: j % 3 === 2 ? 0.55 : 1, ring });
      }
      a += span;
    });
  });

  return { outline, arcs };
}

/** An agent's mark is drawn from its registry id, so the same agent keeps the same seal on every page. */
export const agentSealOf = (id: number) => `agent:${id}`;
