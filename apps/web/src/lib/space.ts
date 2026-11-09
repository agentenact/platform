/**
 * The hero's deep space, as data and one small controller. Zero deps, no DOM: the component (components/deep-space.tsx)
 * draws what this returns and hands the controller a host (the browser) and targets (its elements).
 *
 * Why CSS layers and not a canvas: a canvas star field redraws on the main thread every frame (measured 2026-11-02,
 * 350 stars, headless Chromium: 167 ms/s at 1440 px, 420 ms/s at 2× DPR, ~1 s/s under 4× CPU throttle), while a few
 * pre-drawn SVG layers moved by CSS transforms stay on the compositor and cost the main thread close to nothing.
 * So every star is drawn once, here, into a handful of depth layers; depth comes from how far each layer moves.
 */

/** mulberry32: a tiny seeded generator, so the server and the browser draw the same sky. */
export function seeded(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export type Tint = 'white' | 'blue' | 'warm';
export const TINTS: Record<Tint, string> = { white: '#f3efe8', blue: '#bccdff', warm: '#ffd7b0' };

export interface Star {
  x: number;
  y: number;
  r: number;
  o: number;
  tint: Tint;
}

/**
 * 0 is the farthest layer. Each depth moves more than the one behind it, which is all the depth there is. Depth 0
 * holds still: it is painted once with the page instead of being composited every frame (a moving far field cost
 * more than every other layer together in software compositing, and ±6 px of it was invisible anyway).
 */
export type Depth = 0 | 1 | 2 | 3;

export interface SkyLayer {
  id: string;
  depth: Depth;
  /** The pattern tile in CSS px; it repeats, so density stays the same at any hero size. */
  tile: { w: number; h: number };
  stars: Star[];
  /** Bright stars carry a soft halo. */
  glow: boolean;
  /** Opacity breath of the whole layer, or null for a steady layer. */
  twinkle: { dur: string; delay: string } | null;
  /** Left out on narrow screens: fewer stars and fewer layers to composite on a phone. */
  wideOnly: boolean;
}

interface LayerSpec {
  id: string;
  depth: Depth;
  seed: number;
  tile: [number, number];
  count: number;
  r: [number, number];
  o: [number, number];
  glow?: boolean;
  twinkle?: [number, number];
  wideOnly?: boolean;
}

const SPECS: LayerSpec[] = [
  { id: 'far-a', depth: 0, seed: 11, tile: [1400, 1000], count: 240, r: [0.5, 0.8], o: [0.3, 0.65] },
  { id: 'far-b', depth: 0, seed: 12, tile: [1300, 1100], count: 190, r: [0.5, 0.8], o: [0.25, 0.6], wideOnly: true },
  { id: 'mid', depth: 1, seed: 21, tile: [1600, 1100], count: 90, r: [0.75, 1.1], o: [0.45, 0.85], twinkle: [7.3, -2.1] },
  { id: 'near', depth: 2, seed: 31, tile: [1800, 1200], count: 44, r: [1.05, 1.45], o: [0.6, 0.95] },
  { id: 'bright', depth: 3, seed: 41, tile: [1900, 1300], count: 7, r: [1.2, 1.6], o: [0.8, 1], glow: true, twinkle: [11.7, -6.5] },
];

const round = (n: number) => Math.round(n * 10) / 10;

function drawStars(s: LayerSpec): Star[] {
  const rnd = seeded(s.seed);
  const [w, h] = s.tile;
  return Array.from({ length: s.count }, () => {
    const x = round(rnd() * w);
    const y = round(rnd() * h);
    const r = round(s.r[0] + rnd() * (s.r[1] - s.r[0]));
    const o = Math.round((s.o[0] + rnd() * (s.o[1] - s.o[0])) * 100) / 100;
    const t = rnd();
    const tint: Tint = t < 0.2 ? 'blue' : t < 0.32 ? 'warm' : 'white';
    return { x, y, r, o, tint };
  });
}

/** The fixed sky: the same layers and stars on the server and in the browser, so nothing shifts on hydration. */
export const SKY: SkyLayer[] = SPECS.map((s) => ({
  id: s.id,
  depth: s.depth,
  tile: { w: s.tile[0], h: s.tile[1] },
  stars: drawStars(s),
  glow: !!s.glow,
  twinkle: s.twinkle ? { dur: `${s.twinkle[0]}s`, delay: `${s.twinkle[1]}s` } : null,
  wideOnly: !!s.wideOnly,
}));

/**
 * Stars in one layer grouped into a few paths, one per tint, brightness step and size. Each star is a zero-length
 * segment with a round cap, which draws a dot of the stroke's width: hundreds of stars become a few dozen short
 * elements, so the HTML and hydration stay light.
 */
export function starPaths(stars: Star[]): { stroke: string; opacity: number; width: number; d: string }[] {
  const groups = new Map<string, { stroke: string; opacity: number; width: number; d: string[] }>();
  for (const s of stars) {
    const step = Math.min(5, Math.max(1, Math.round(s.o * 5))) / 5;
    const width = Math.round(s.r * 4) / 2; // diameter, in half-px steps
    const key = `${s.tint}:${step}:${width}`;
    let g = groups.get(key);
    if (!g) groups.set(key, (g = { stroke: TINTS[s.tint], opacity: step, width, d: [] }));
    g.d.push(`M${Math.round(s.x)} ${Math.round(s.y)}h0`);
  }
  return [...groups.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([, g]) => ({ ...g, d: g.d.join('') }));
}

/** Where a meteor crosses: a start point in % of the hero and a heading in degrees (down and to one side). */
export interface MeteorLane {
  left: number;
  top: number;
  angle: number;
}

/**
 * The next meteor's lane and how long to wait for it: 20–40 s, high in the sky and right of the headline, short and
 * shallow, so it crosses the corner of the eye and never the words.
 */
export function nextMeteor(rnd: () => number): { waitMs: number; lane: MeteorLane } {
  const waitMs = Math.round(20_000 + rnd() * 20_000);
  const rightward = rnd() < 0.5;
  const left = Math.round(rightward ? 44 + rnd() * 26 : 66 + rnd() * 26);
  const top = Math.round(3 + rnd() * 14);
  const angle = Math.round(rightward ? 14 + rnd() * 18 : 148 + rnd() * 18);
  return { waitMs, lane: { left, top, angle } };
}

/** What the controller needs from the browser. Each `on*` returns its unsubscribe. */
export interface SpaceHost {
  reducedMotion: boolean;
  setTimer(cb: () => void, ms: number): number;
  clearTimer(id: number): void;
  /** Fires now with the current state, then on every change. */
  onVisible(cb: (visible: boolean) => void): () => void;
  /** Fires when the hero enters or leaves the viewport. */
  onInView(cb: (inView: boolean) => void): () => void;
  random: () => number;
}

/** What the controller moves. */
export interface SpaceTargets {
  setPaused(paused: boolean): void;
  launchMeteor(lane: MeteorLane): void;
}

/**
 * Runs the sky's only script-driven motion, the rare meteor (one timer). Everything else is CSS on the compositor and
 * moves on its own, whatever the pointer does. Reduced motion starts nothing at all; an offscreen hero or a hidden tab
 * pauses the CSS and clears the meteor timer.
 */
export function spaceMotion(host: SpaceHost, targets: SpaceTargets): { stop(): void } {
  if (host.reducedMotion) return { stop() {} };

  let visible = true;
  let inView = true;
  let running = false;
  let timer: number | null = null;

  const schedule = () => {
    if (timer !== null) return;
    const next = nextMeteor(host.random);
    timer = host.setTimer(() => {
      timer = null;
      if (!running) return;
      targets.launchMeteor(next.lane);
      schedule();
    }, next.waitMs);
  };

  const update = () => {
    const should = visible && inView;
    if (should === running) return;
    running = should;
    targets.setPaused(!running);
    if (running) {
      schedule();
    } else {
      if (timer !== null) host.clearTimer(timer);
      timer = null;
    }
  };

  running = false;
  const offs = [
    host.onVisible((v) => {
      visible = v;
      update();
    }),
    host.onInView((v) => {
      inView = v;
      update();
    }),
  ];
  update();

  return {
    stop() {
      for (const off of offs) off();
      if (timer !== null) host.clearTimer(timer);
      timer = null;
      running = false;
    },
  };
}
