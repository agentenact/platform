'use client';

import { useEffect, useRef, type CSSProperties } from 'react';
import { Seal } from './seal';
import { SKY, seeded, spaceMotion, starPaths, type Depth, type SkyLayer, type SpaceHost } from '@/lib/space';

const MOVING: Depth[] = [1, 2, 3];

/** One layer of stars: a pattern tile (fixed px, so stars stay round and evenly dense) filling an oversized svg. */
function Layer({ layer }: { layer: SkyLayer }) {
  const id = `sky-${layer.id}`;
  const style = layer.twinkle ? ({ '--tw-dur': layer.twinkle.dur, '--tw-delay': layer.twinkle.delay } as CSSProperties) : undefined;
  return (
    <svg className="sky-layer" data-twinkle={layer.twinkle ? '' : undefined} data-wide-only={layer.wideOnly ? '' : undefined} style={style} focusable="false">
      <defs>
        {layer.glow ? (
          <radialGradient id="sky-halo">
            <stop offset="0" stopColor="#f3efe8" stopOpacity="0.5" />
            <stop offset="0.25" stopColor="#c9d4ff" stopOpacity="0.12" />
            <stop offset="1" stopColor="#c9d4ff" stopOpacity="0" />
          </radialGradient>
        ) : null}
        <pattern id={id} width={layer.tile.w} height={layer.tile.h} patternUnits="userSpaceOnUse">
          {layer.glow
            ? layer.stars.map((s, i) => (
                <g key={i}>
                  <circle cx={s.x} cy={s.y} r={s.r * 9} fill="url(#sky-halo)" opacity={s.o * 0.55} />
                  <circle cx={s.x} cy={s.y} r={s.r} fill={s.tint === 'blue' ? '#dfe7ff' : '#fbf7f0'} opacity={s.o} />
                </g>
              ))
            : starPaths(layer.stars).map((p) => (
                <path key={`${p.stroke}${p.opacity}${p.width}`} d={p.d} stroke={p.stroke} strokeWidth={p.width} strokeLinecap="round" opacity={p.opacity} />
              ))}
        </pattern>
      </defs>
      <rect width="100%" height="100%" fill={`url(#${id})`} />
    </svg>
  );
}

function SkyDepth({ depth }: { depth: Depth }) {
  return (
    <div className="sky-drift" data-depth={depth}>
      {SKY.filter((l) => l.depth === depth).map((l) => (
        <Layer key={l.id} layer={l} />
      ))}
    </div>
  );
}

function browserHost(section: HTMLElement): SpaceHost {
  return {
    reducedMotion: window.matchMedia('(prefers-reduced-motion: reduce)').matches,
    setTimer: (cb, ms) => window.setTimeout(cb, ms),
    clearTimer: (id) => window.clearTimeout(id),
    onVisible(cb) {
      const on = () => cb(document.visibilityState !== 'hidden');
      on();
      document.addEventListener('visibilitychange', on);
      return () => document.removeEventListener('visibilitychange', on);
    },
    onInView(cb) {
      const io = new IntersectionObserver((entries) => cb(entries[entries.length - 1]!.isIntersecting));
      io.observe(section);
      return () => io.disconnect();
    },
    random: seeded(Date.now() & 0xffff),
  };
}

/**
 * Deep space behind the hero: two faint colour fields that breathe, four depths of stars drifting with one slow
 * camera sway (near layers travel farther), the seal hanging in it like a lit planet, and now and then one faint
 * meteor. It all moves on its own and never follows the pointer. Everything renders on the server and moves in CSS;
 * the script only adds the meteor, and pauses the lot while the hero is off screen or the tab is hidden (lib/space.ts).
 */
export function DeepSpace({ sealHash }: { sealHash: string }) {
  const root = useRef<HTMLDivElement>(null);
  const lane = useRef<HTMLSpanElement>(null);

  useEffect(() => {
    const section = root.current?.closest<HTMLElement>('.night');
    if (!section) return;
    const meteor = lane.current?.firstElementChild as HTMLElement | null | undefined;
    const clear = () => meteor?.removeAttribute('data-run');
    meteor?.addEventListener('animationend', clear);
    const motion = spaceMotion(browserHost(section), {
      setPaused(paused) {
        if (paused) section.setAttribute('data-paused', '');
        else section.removeAttribute('data-paused');
      },
      launchMeteor(l) {
        const box = lane.current;
        if (!box || !meteor) return;
        box.style.left = `${l.left}%`;
        box.style.top = `${l.top}%`;
        box.style.transform = `rotate(${l.angle}deg)`;
        meteor.setAttribute('data-run', '');
      },
    });
    return () => {
      motion.stop();
      meteor?.removeEventListener('animationend', clear);
      section.removeAttribute('data-paused');
    };
  }, []);

  return (
    <>
      <div ref={root} aria-hidden className="space">
        {/* Still things first: painted once into the page. Moving layers after them, composited on top. */}
        <div className="nebula nebula-b" />
        <SkyDepth depth={0} />
        <div className="nebula nebula-a" />
        {MOVING.map((d) => (
          <SkyDepth key={d} depth={d} />
        ))}
        <span ref={lane} className="meteor-lane">
          <span className="meteor" />
        </span>
      </div>
      <div aria-hidden className="night-seal">
        <div className="seal-body">
          <Seal hash={sealHash} ink="#150c0a" mark="rgb(255 90 54 / 0.5)" />
          <div className="seal-shade" />
        </div>
      </div>
      <div aria-hidden className="night-fade" />
    </>
  );
}
