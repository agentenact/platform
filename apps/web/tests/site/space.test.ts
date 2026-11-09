import { describe, expect, it } from 'bun:test';
import { nextMeteor, seeded, SKY, spaceMotion, starPaths, type MeteorLane, type SpaceHost } from '../../src/lib/space';

describe('the sky', () => {
  it('is the same on every load: a seeded generator draws the same stars', () => {
    const a = seeded(7);
    const b = seeded(7);
    const xs = Array.from({ length: 50 }, () => a());
    expect(xs).toEqual(Array.from({ length: 50 }, () => b()));
    expect(xs.every((x) => x >= 0 && x < 1)).toBe(true);
    expect(seeded(8)()).not.toBe(xs[0]);
    // the module's sky comes from fixed seeds, so the server and the browser render the same first star
    expect(SKY[0]!.stars[0]).toEqual({ x: 716.2, y: 529.9, r: 0.7, o: 0.51, tint: 'white' });
    expect(starPaths(SKY[0]!.stars)).toEqual(starPaths(SKY[0]!.stars.map((s) => ({ ...s }))));
  });

  it('keeps every star inside its tile, with near stars larger and brighter than far ones', () => {
    for (const l of SKY) {
      for (const s of l.stars) {
        expect(s.x).toBeGreaterThanOrEqual(0);
        expect(s.x).toBeLessThanOrEqual(l.tile.w);
        expect(s.y).toBeGreaterThanOrEqual(0);
        expect(s.y).toBeLessThanOrEqual(l.tile.h);
      }
    }
    const avg = (d: number, k: 'r' | 'o') => {
      const st = SKY.filter((l) => l.depth === d).flatMap((l) => l.stars);
      return st.reduce((n, s) => n + s[k], 0) / st.length;
    };
    for (const k of ['r', 'o'] as const) {
      expect(avg(0, k)).toBeLessThan(avg(1, k));
      expect(avg(1, k)).toBeLessThan(avg(2, k));
      expect(avg(2, k)).toBeLessThan(avg(3, k));
    }
  });

  it('is mostly warm white with some faint blue and warm stars', () => {
    const all = SKY.flatMap((l) => l.stars);
    const share = (t: string) => all.filter((s) => s.tint === t).length / all.length;
    expect(share('white')).toBeGreaterThan(0.55);
    expect(share('blue')).toBeGreaterThan(0.1);
    expect(share('warm')).toBeGreaterThan(0.05);
  });

  it('draws hundreds of stars as a few dozen elements', () => {
    const stars = SKY.reduce((n, l) => n + l.stars.length, 0);
    const paths = SKY.filter((l) => !l.glow).reduce((n, l) => n + starPaths(l.stars).length, 0);
    expect(stars).toBeGreaterThan(500);
    expect(paths).toBeLessThan(80);
    const bytes = SKY.reduce((n, l) => n + starPaths(l.stars).reduce((m, p) => m + p.d.length, 0), 0);
    expect(bytes).toBeLessThan(8_000);
  });

  it('drops a far layer on phones and keeps a few layers in all', () => {
    expect(SKY.some((l) => l.wideOnly)).toBe(true);
    expect(SKY.length).toBeLessThanOrEqual(8);
  });
});

describe('meteors', () => {
  it('come every 20–40 s, high on the sky and right of the headline', () => {
    const rnd = seeded(3);
    for (let i = 0; i < 200; i++) {
      const m = nextMeteor(rnd);
      expect(m.waitMs).toBeGreaterThanOrEqual(20_000);
      expect(m.waitMs).toBeLessThanOrEqual(40_000);
      expect(m.lane.top).toBeLessThanOrEqual(17);
      expect(m.lane.left).toBeGreaterThanOrEqual(44);
    }
  });
});

/** A fake browser: frames and timers run only when the test says so. */
function fakeHost(o: Partial<SpaceHost> = {}) {
  const timers = new Map<number, { cb: () => void; ms: number }>();
  let id = 0;
  const subs = { visible: [] as ((v: boolean) => void)[], inView: [] as ((v: boolean) => void)[] };
  const host: SpaceHost = {
    reducedMotion: false,
    setTimer: (cb, ms) => (timers.set(++id, { cb, ms }), id),
    clearTimer: (i) => void timers.delete(i),
    onVisible: (cb) => (subs.visible.push(cb), cb(true), () => (subs.visible = subs.visible.filter((x) => x !== cb))),
    onInView: (cb) => (subs.inView.push(cb), () => (subs.inView = subs.inView.filter((x) => x !== cb))),
    random: seeded(1),
    ...o,
  };
  const fireTimers = () => {
    for (const [k, t] of [...timers]) {
      timers.delete(k);
      t.cb();
    }
  };
  return { host, timers, subs, fireTimers };
}

function fakeTargets() {
  const log = { paused: [] as boolean[], meteors: [] as MeteorLane[] };
  return {
    log,
    targets: {
      setPaused: (p: boolean) => void log.paused.push(p),
      launchMeteor: (l: MeteorLane) => void log.meteors.push(l),
    },
  };
}

describe('spaceMotion', () => {
  it('starts nothing at all under reduced motion: no timers, no listeners', () => {
    const f = fakeHost({ reducedMotion: true });
    const t = fakeTargets();
    spaceMotion(f.host, t.targets);
    expect(f.timers.size).toBe(0);
    expect(f.subs.visible.length + f.subs.inView.length).toBe(0);
    expect(t.log.paused).toEqual([]);
  });

  it('pauses offscreen: CSS paused, meteor timer cleared; resumes in view', () => {
    const f = fakeHost();
    const t = fakeTargets();
    spaceMotion(f.host, t.targets);
    expect(t.log.paused).toEqual([false]);
    expect(f.timers.size).toBe(1);
    f.subs.inView[0]!(false);
    expect(t.log.paused).toEqual([false, true]);
    expect(f.timers.size).toBe(0);
    f.subs.inView[0]!(true);
    expect(t.log.paused).toEqual([false, true, false]);
    expect(f.timers.size).toBe(1);
  });

  it('pauses in a hidden tab the same way', () => {
    const f = fakeHost();
    const t = fakeTargets();
    spaceMotion(f.host, t.targets);
    f.subs.visible[0]!(false);
    expect(t.log.paused.at(-1)).toBe(true);
    expect(f.timers.size).toBe(0);
    f.fireTimers();
    expect(t.log.meteors).toEqual([]);
    f.subs.visible[0]!(true);
    expect(t.log.paused.at(-1)).toBe(false);
  });

  it('launches one meteor per timer and schedules the next; stop() clears everything', () => {
    const f = fakeHost();
    const t = fakeTargets();
    const m = spaceMotion(f.host, t.targets);
    const [first] = [...f.timers.values()];
    expect(first!.ms).toBeGreaterThanOrEqual(20_000);
    f.fireTimers();
    f.fireTimers();
    expect(t.log.meteors.length).toBe(2);
    expect(f.timers.size).toBe(1);
    m.stop();
    expect(f.timers.size).toBe(0);
    expect(f.subs.visible.length + f.subs.inView.length).toBe(0);
  });
});
