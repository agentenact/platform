import type { CSSProperties, ReactNode } from 'react';
import { copy } from '@/copy';
import { sealGeometry } from '@/lib/seal';
import { BRAND_HASH } from './seal';

/**
 * Which of the seal's five rings a mark of this size can still draw cleanly, and how thick. At 16 px the full seal is a
 * smudge, so a small mark keeps two rings drawn heavy with wide breaks (or the turn would not show); a large one keeps all five at the hero's own weights.
 */
function detail(size: number): { rings: number[]; width: number | null; gap: number; core: number; edge: boolean } {
  if (size < 28) return { rings: [0, 3], width: 20, gap: 3.2, core: 13, edge: false };
  if (size < 64) return { rings: [0, 2, 4], width: 11, gap: 1.8, core: 11, edge: false };
  return { rings: [0, 1, 2, 3, 4], width: null, gap: 1, core: 11, edge: true };
}

/**
 * The loading mark: the hero's seal forming. The core lands, then the arcs are drawn ring by ring from the centre out,
 * the finished print holds, fades, and forms again. Below 28 px (buttons, lines of text) there are too few pixels for
 * that, so the two rings turn once in opposite directions and settle back into register. With less motion the print stays whole and its rings only
 * breathe in turn. Drawn in `currentColor`, so it takes the colour of the text or button around it.
 * Always decorative: the words beside it (or `Loading`) say what is happening.
 */
export function SealLoader({ size = 16, seed = BRAND_HASH, className = '' }: { size?: number; seed?: string; className?: string }) {
  const d = detail(size);
  const g = sealGeometry(seed, d.gap);
  const motion = size < 28 ? 'turn' : 'form';
  return (
    <svg viewBox="0 0 200 200" width={size} height={size} className={`seal-loader ${className}`} aria-hidden="true" focusable="false" data-motion={motion}>
      {d.edge ? <path d={g.outline} fill="none" stroke="currentColor" strokeOpacity="0.22" strokeWidth="1" vectorEffect="non-scaling-stroke" /> : null}
      {d.rings.map((ring, i) => (
        // --i counts rings from the centre, so the print forms outwards; --j staggers the arcs of one ring.
        <g key={ring} className="sl-ring" data-ccw={motion === 'turn' && i % 2 === 1 ? '' : undefined} style={{ '--i': d.rings.length - 1 - i } as CSSProperties}>
          {g.arcs
            .filter((a) => a.ring === ring)
            .map((a, j) => (
              <path
                key={j}
                className="sl-arc"
                style={{ '--j': j } as CSSProperties}
                d={a.d}
                pathLength={1}
                fill="none"
                stroke="currentColor"
                strokeWidth={d.width ?? a.width}
                strokeLinecap="round"
                strokeOpacity={a.opacity}
              />
            ))}
        </g>
      ))}
      <circle className="sl-core" cx="100" cy="100" r={d.core} fill="currentColor" />
    </svg>
  );
}

/**
 * A loading state with words: the mark in wax and a line saying what is loading, announced politely.
 * `inline` sits in a line of text, `block` stands in for a section, `page` holds a whole screen until it arrives.
 */
export function Loading({
  label = copy.shell.loading,
  layout = 'inline',
  className = '',
  children,
}: {
  label?: ReactNode;
  layout?: 'inline' | 'block' | 'page';
  className?: string;
  children?: ReactNode;
}) {
  if (layout === 'page')
    return (
      <div role="status" aria-live="polite" className={`flex min-h-[60vh] flex-col items-center justify-center gap-5 py-16 text-center ${className}`} data-loading="page">
        <SealLoader size={88} className="text-accent" />
        <p className="text-[15px] text-fg-2">{label}</p>
        {children}
      </div>
    );
  if (layout === 'block')
    return (
      <div role="status" aria-live="polite" className={`flex items-center gap-3.5 py-6 text-[15px] text-fg-2 ${className}`} data-loading="block">
        <SealLoader size={32} className="text-accent" />
        <span>{label}</span>
        {children}
      </div>
    );
  return (
    <span role="status" aria-live="polite" className={`inline-flex items-center gap-2 ${className}`} data-loading="inline">
      <SealLoader size={16} className="text-accent" />
      <span>{label}</span>
      {children}
    </span>
  );
}
