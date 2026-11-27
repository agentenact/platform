import type { CSSProperties, ReactNode } from 'react';

/**
 * One line icon per ready agent, keyed by template id (24-unit grid, drawn with the current text colour).
 * An id with no icon of its own gets the spark. Shapes follow Lucide (ISC).
 */
const ICONS: Record<string, ReactNode> = {
  'soon-arbitrage': (
    <>
      <path d="M8 3 4 7l4 4" />
      <path d="M4 7h16" />
      <path d="m16 21 4-4-4-4" />
      <path d="M20 17H4" />
    </>
  ),
  'soon-yield': (
    <>
      <path d="M7 20h10" />
      <path d="M10 20c5.5-2.5.8-6.4 3-10" />
      <path d="M9.5 9.4c1.1.8 1.8 2.2 2.3 3.7-2 .4-3.5.4-4.8-.3-1.2-.6-2.3-1.9-3-4.2 2.8-.5 4.4 0 5.5.8z" />
      <path d="M14.1 6a7 7 0 0 0-1.1 4c1.9-.1 3.3-.6 4.3-1.4 1-1 1.6-2.3 1.7-4.6-2.7.1-4 1-4.9 2z" />
    </>
  ),
  'soon-lp-rebalancer': (
    <>
      <path d="m16 16 3-8 3 8c-.87.65-1.92 1-3 1s-2.13-.35-3-1Z" />
      <path d="m2 16 3-8 3 8c-.87.65-1.92 1-3 1s-2.13-.35-3-1Z" />
      <path d="M7 21h10" />
      <path d="M12 3v18" />
      <path d="M3 7h2c2 0 5-1 7-2 2 1 5 2 7 2h2" />
    </>
  ),
  'soon-volume': (
    <>
      <path d="M3 3v18h18" />
      <path d="M8 17v-3" />
      <path d="M13 17V9" />
      <path d="M18 17V5" />
    </>
  ),
  'soon-trade': (
    <>
      <path d="M9 5v4" />
      <rect width="4" height="6" x="7" y="9" rx="1" />
      <path d="M9 15v2" />
      <path d="M17 3v2" />
      <rect width="4" height="8" x="15" y="5" rx="1" />
      <path d="M17 13v3" />
      <path d="M3 3v18h18" />
    </>
  ),
  'soon-market-maker': (
    <>
      <path d="m21 16-4 4-4-4" />
      <path d="M17 20V4" />
      <path d="m3 8 4-4 4 4" />
      <path d="M7 4v16" />
    </>
  ),
  'xlm-drop': (
    <>
      <path d="M22 17 13.5 8.5l-5 5L2 7" />
      <path d="M16 17h6v-6" />
    </>
  ),
  'coin-crash': (
    <>
      <path d="M3 3v18h18" />
      <path d="m7 7 4 6 3-3 5 7" />
    </>
  ),
  'coin-jump': (
    <>
      <path d="M22 7 13.5 15.5l-5-5L2 17" />
      <path d="M16 7h6v6" />
    </>
  ),
  'price-target': (
    <>
      <circle cx="12" cy="12" r="10" />
      <circle cx="12" cy="12" r="6" />
      <circle cx="12" cy="12" r="2" />
    </>
  ),
  'usdc-peg': (
    <>
      <path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10Z" />
      <path d="m9 12 2 2 4-4" />
    </>
  ),
  'wallet-watch': (
    <>
      <path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7S2 12 2 12Z" />
      <circle cx="12" cy="12" r="3" />
    </>
  ),
  'big-usdc': (
    <>
      <circle cx="8" cy="8" r="6" />
      <path d="M18.09 10.37A6 6 0 1 1 10.34 18" />
      <path d="M7 6h1v4" />
      <path d="m16.71 13.88.7.71-2.82 2.82" />
    </>
  ),
  'payment-received': (
    <>
      <path d="M22 12h-6l-2 3h-4l-2-3H2" />
      <path d="M5.45 5.11 2 12v6a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2v-6l-3.45-6.89A2 2 0 0 0 16.76 4H7.24a2 2 0 0 0-1.79 1.11Z" />
    </>
  ),
  'low-balance': (
    <>
      <rect x="2" y="7" width="16" height="10" rx="2" />
      <path d="M22 11v2" />
      <path d="M6 11v2" />
    </>
  ),
  'money-out': (
    <>
      <path d="M7 17 17 7" />
      <path d="M7 7h10v10" />
    </>
  ),
  'low-usdc': (
    <>
      <circle cx="12" cy="12" r="10" />
      <path d="M16 8h-6a2 2 0 1 0 0 4h4a2 2 0 1 1 0 4H8" />
      <path d="M12 18V6" />
    </>
  ),
  'big-usdt': (
    <>
      <path d="m8 3-4 4 4 4" />
      <path d="M4 7h16" />
      <path d="m16 21 4-4-4-4" />
      <path d="M20 17H4" />
    </>
  ),
  'daily-balance': (
    <>
      <path d="M19 7V4a1 1 0 0 0-1-1H5a2 2 0 0 0 0 4h15a1 1 0 0 1 1 1v4h-3a2 2 0 0 0 0 4h3a1 1 0 0 0 1-1v-2a1 1 0 0 0-1-1" />
      <path d="M3 5v14a2 2 0 0 0 2 2h15a1 1 0 0 0 1-1v-4" />
    </>
  ),
  'daily-digest': (
    <>
      <path d="M4 22h16a2 2 0 0 0 2-2V4a2 2 0 0 0-2-2H8a2 2 0 0 0-2 2v16a2 2 0 0 1-2 2Zm0 0a2 2 0 0 1-2-2v-9c0-1.1.9-2 2-2h2" />
      <path d="M18 14h-8" />
      <path d="M15 18h-5" />
      <path d="M10 6h8v4h-8Z" />
    </>
  ),
  'morning-prices': (
    <>
      <path d="M12 2v8" />
      <path d="m4.93 10.93 1.41 1.41" />
      <path d="M2 18h2" />
      <path d="M20 18h2" />
      <path d="m19.07 10.93-1.41 1.41" />
      <path d="M22 22H2" />
      <path d="m8 6 4-4 4 4" />
      <path d="M16 18a4 4 0 0 0-8 0" />
    </>
  ),
  'weekly-recap': (
    <>
      <rect x="3" y="4" width="18" height="18" rx="2" />
      <path d="M16 2v4" />
      <path d="M8 2v4" />
      <path d="M3 10h18" />
    </>
  ),
  'btc-range': (
    <>
      <path d="M3 7h18" strokeDasharray="2 3" />
      <path d="M3 17h18" strokeDasharray="2 3" />
      <path d="m4 12 3-2 3 3 3-2 3 1 4-8" />
    </>
  ),
  'big-move': <path d="M22 12h-2.48a2 2 0 0 0-1.93 1.46l-2.35 8.36a.25.25 0 0 1-.48 0L9.24 2.18a.25.25 0 0 0-.48 0l-2.35 8.36A2 2 0 0 1 4.49 12H2" />,
  'market-morning': (
    <>
      <path d="M10 2v2" />
      <path d="M14 2v2" />
      <path d="M16 8a1 1 0 0 1 1 1v8a4 4 0 0 1-4 4H7a4 4 0 0 1-4-4V9a1 1 0 0 1 1-1h14a4 4 0 1 1 0 8h-1" />
      <path d="M6 2v2" />
    </>
  ),
  'stablecoin-received': (
    <>
      <path d="M12 2v13" />
      <path d="m7 10 5 5 5-5" />
      <path d="M5 21h14" />
    </>
  ),
  'btc-received': (
    <>
      <circle cx="12" cy="12" r="10" />
      <path d="m8 12 3 3 5-6" />
    </>
  ),
  'quiet-wallet': (
    <>
      <circle cx="12" cy="12" r="10" />
      <path d="M12 6v6l4 2" />
    </>
  ),
  'stablecoin-peg': (
    <>
      <path d="M12 2v20" />
      <path d="M17 5H9.5a3.5 3.5 0 0 0 0 7h5a3.5 3.5 0 0 1 0 7H6" />
    </>
  ),
  'agent-economy': (
    <>
      <path d="M12 8V4H8" />
      <rect width="16" height="12" x="4" y="8" rx="2" />
      <path d="M2 14h2" />
      <path d="M20 14h2" />
      <path d="M15 13v2" />
      <path d="M9 13v2" />
    </>
  ),
};

const SPARK = <path d="M12 3v4M12 17v4M3 12h4M17 12h4M6 6l2.5 2.5M15.5 15.5 18 18M6 18l2.5-2.5M15.5 8.5 18 6" />;

export function TemplateIcon({ id, size = 22, className }: { id: string; size?: number; className?: string }) {
  return (
    <svg
      viewBox="0 0 24 24"
      width={size}
      height={size}
      fill="none"
      stroke="currentColor"
      strokeWidth={1.75}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
      className={className}
    >
      {ICONS[id] ?? SPARK}
    </svg>
  );
}

/*
 * Illustrated tiles: every ready agent gets its own hue and a small scene drawn on a 48-unit grid.
 * One recipe holds the set together: a deep tile in the hue, one mid-tone shape, line work in a light
 * tint of the hue and one bright dot that marks the moment the agent acts on. Only the hue changes.
 */
type Scene = { hue: number; art: ReactNode };

const MID = { fill: 'var(--ta-mid)' } as const;
const INK = { fill: 'none', stroke: 'var(--ta-ink)', strokeWidth: 2.25, strokeLinecap: 'round', strokeLinejoin: 'round' } as const;
const INK_FILL = { fill: 'var(--ta-ink)' } as const;
const DOT = { fill: 'var(--ta-dot)' } as const;
const SOFT = { fill: 'var(--ta-mid)', opacity: 0.7 } as const;

const SCENES: Record<string, Scene> = {
  'low-balance': {
    hue: 8,
    art: (
      <>
        <rect x="9" y="16" width="26" height="16" rx="4" style={INK} />
        <rect x="12.5" y="19.5" width="6" height="9" rx="1.5" style={MID} />
        <path d="M39 21.5v5" style={INK} />
        <circle cx="35" cy="12" r="2.75" style={DOT} />
      </>
    ),
  },
  'money-out': {
    hue: 22,
    art: (
      <>
        <rect x="9" y="19" width="20" height="20" rx="5" style={MID} />
        <path d="M21 27 38 10" style={INK} />
        <path d="M27 10h11v11" style={INK} />
        <circle cx="38" cy="10" r="2.75" style={DOT} />
      </>
    ),
  },
  'agent-economy': {
    hue: 36,
    art: (
      <>
        <path d="M24 24 13 14M24 24l11-10M24 24v13" style={INK} />
        <circle cx="13" cy="14" r="4.5" style={MID} />
        <circle cx="35" cy="14" r="4.5" style={MID} />
        <circle cx="24" cy="37" r="4.5" style={MID} />
        <circle cx="24" cy="24" r="3.5" style={DOT} />
      </>
    ),
  },
  'btc-range': {
    hue: 52,
    art: (
      <>
        <rect x="8" y="16" width="32" height="16" style={SOFT} />
        <path d="M8 16h32M8 32h32" style={INK} strokeDasharray="1 4.5" />
        <path d="m10 26 5-4 5 5 5-6 5 3 6-13" style={INK} />
        <circle cx="36" cy="11" r="2.75" style={DOT} />
      </>
    ),
  },
  'btc-received': {
    hue: 64,
    art: (
      <>
        <circle cx="23" cy="25" r="13" style={MID} />
        <path d="m17 25 4.5 4.5L30 21" style={INK} />
        <circle cx="36" cy="12" r="2.75" style={DOT} />
      </>
    ),
  },
  'daily-digest': {
    hue: 76,
    art: (
      <>
        <path d="M14 10h22a3 3 0 0 1 3 3v22a4 4 0 0 1-4 4H13" style={MID} />
        <path d="M13 39a4 4 0 0 1-4-4V20h5v15a4 4 0 0 1-1 4Z" style={MID} opacity={0.6} />
        <rect x="19" y="15" width="14" height="7" rx="1.5" style={DOT} />
        <path d="M19 28h14M19 33h9" style={INK} />
      </>
    ),
  },
  'morning-prices': {
    hue: 88,
    art: (
      <>
        <path d="M14 34a10 10 0 0 1 20 0Z" style={MID} />
        <path d="M8 34h32M24 13v5M12 21l3 3M36 21l-3 3" style={INK} />
        <circle cx="24" cy="34" r="2.75" style={DOT} />
      </>
    ),
  },
  'market-morning': {
    hue: 102,
    art: (
      <>
        <path d="M11 22h20v8a8 8 0 0 1-8 8h-4a8 8 0 0 1-8-8Z" style={MID} />
        <path d="M31 25h2a4 4 0 0 1 0 8h-2" style={INK} />
        <path d="M17 9c-2 2.5 2 4 0 7M24 9c-2 2.5 2 4 0 7" style={INK} />
        <circle cx="21" cy="29" r="2.75" style={DOT} />
      </>
    ),
  },
  'daily-balance': {
    hue: 116,
    art: (
      <>
        <rect x="10" y="9" width="28" height="30" rx="5" style={MID} />
        <path d="M16 19h10M16 25h16M16 31h7" style={INK} />
        <circle cx="32" cy="19" r="2.75" style={DOT} />
      </>
    ),
  },
  'coin-jump': {
    hue: 132,
    art: (
      <>
        <rect x="9" y="29" width="7" height="10" rx="2" style={MID} />
        <rect x="20" y="23" width="7" height="16" rx="2" style={MID} />
        <rect x="31" y="17" width="7" height="22" rx="2" style={MID} />
        <path d="m10 20 12-6 4 3 12-8" style={INK} />
        <circle cx="38" cy="9" r="2.75" style={DOT} />
      </>
    ),
  },
  'payment-received': {
    hue: 148,
    art: (
      <>
        <path d="M8 27h9l3 4h8l3-4h9v7a5 5 0 0 1-5 5H13a5 5 0 0 1-5-5Z" style={MID} />
        <path d="M24 9v14M18 17l6 6 6-6" style={INK} />
        <circle cx="24" cy="31" r="2.75" style={DOT} />
      </>
    ),
  },
  'coin-crash': {
    hue: 162,
    art: (
      <>
        <path d="M9 25.5 23.5 11H36a2 2 0 0 1 2 2v12.5L23.5 40a2 2 0 0 1-2.8 0L9 28.3a2 2 0 0 1 0-2.8Z" style={MID} />
        <circle cx="31.5" cy="17.5" r="2.75" style={DOT} />
        <path d="M17 24.5v6.5h6.5M17 31l9-9" style={INK} />
      </>
    ),
  },
  'big-usdt': {
    hue: 176,
    art: (
      <>
        <rect x="8" y="18" width="32" height="12" rx="6" style={MID} />
        <path d="M14 12h22m-4-4 4 4-4 4M34 36H12m4 4-4-4 4-4" style={INK} />
        <circle cx="24" cy="24" r="2.75" style={DOT} />
      </>
    ),
  },
  'stablecoin-received': {
    hue: 190,
    art: (
      <>
        <ellipse cx="24" cy="34" rx="14" ry="5" style={MID} />
        <path d="M24 8v17M18 19l6 6 6-6" style={INK} />
        <circle cx="24" cy="34" r="2.75" style={DOT} />
      </>
    ),
  },
  'wallet-watch': {
    hue: 205,
    art: (
      <>
        <rect x="7" y="19" width="27" height="20" rx="5" style={MID} />
        <path d="M7 25h27" style={INK} opacity={0.7} />
        <circle cx="27.5" cy="32" r="2.75" style={DOT} />
        <path d="M32 7.5a9 9 0 0 1 8.5 8.5M32 13a3.5 3.5 0 0 1 3 3" style={INK} />
      </>
    ),
  },
  'low-usdc': {
    hue: 220,
    art: (
      <>
        <path d="M12.38 27h23.24a12 12 0 0 1-23.24 0Z" style={MID} />
        <circle cx="24" cy="24" r="12" style={INK} />
        <circle cx="24" cy="17" r="2.75" style={DOT} />
      </>
    ),
  },
  'big-usdc': {
    hue: 236,
    art: (
      <>
        <ellipse cx="22" cy="33" rx="12" ry="4.5" style={MID} opacity={0.55} />
        <ellipse cx="22" cy="27" rx="12" ry="4.5" style={MID} opacity={0.8} />
        <ellipse cx="22" cy="21" rx="12" ry="4.5" style={MID} />
        <path d="M37 18V8m-3.5 3.5L37 8l3.5 3.5" style={INK} />
        <circle cx="22" cy="21" r="2" style={DOT} />
      </>
    ),
  },
  'usdc-peg': {
    hue: 250,
    art: (
      <>
        <path d="M7 24h7M34 24h7" style={INK} />
        <circle cx="24" cy="24" r="10" style={MID} />
        <path d="M19.5 24h9" style={INK} />
        <circle cx="24" cy="12" r="2.75" style={DOT} />
      </>
    ),
  },
  'stablecoin-peg': {
    hue: 264,
    art: (
      <>
        <circle cx="13" cy="24" r="7" style={MID} />
        <circle cx="35" cy="24" r="7" style={MID} />
        <path d="M20.5 21h7M20.5 27h7" style={INK} />
        <circle cx="24" cy="12" r="2.5" style={DOT} />
      </>
    ),
  },
  'xlm-drop': {
    hue: 280,
    art: (
      <>
        <path d="M8 14 16 20l6-3 9 15 9-7v14H8Z" style={SOFT} />
        <path d="m8 14 8 6 6-3 9 15 9-7" style={INK} />
        <circle cx="31" cy="32" r="3" style={DOT} />
      </>
    ),
  },
  'quiet-wallet': {
    hue: 296,
    art: (
      <>
        <circle cx="24" cy="25" r="13" style={MID} />
        <path d="M24 18v7l5 3" style={INK} />
        <circle cx="24" cy="8.5" r="2.5" style={DOT} />
      </>
    ),
  },
  'weekly-recap': {
    hue: 312,
    art: (
      <>
        <rect x="9" y="12" width="30" height="27" rx="5" style={MID} />
        <path d="M17 8v7M31 8v7M9 19h30" style={INK} />
        <path d="M15 26h0M21 26h0M27 26h0M33 26h0M15 32h0M21 32h0" style={INK} strokeWidth={3.5} />
        <circle cx="27" cy="32" r="2.5" style={DOT} />
      </>
    ),
  },
  'big-move': {
    hue: 328,
    art: (
      <>
        <path d="M8 28h6l4-6 5 17 6-30 4 19h7v11H8Z" style={SOFT} />
        <path d="M8 28h6l4-6 5 17 6-30 4 19h7" style={INK} />
        <circle cx="29" cy="9" r="2.75" style={DOT} />
      </>
    ),
  },
  'price-target': {
    hue: 344,
    art: (
      <>
        <circle cx="24" cy="24" r="14" style={MID} />
        <circle cx="24" cy="24" r="7.5" style={INK} />
        <path d="M24 6v6M24 36v6M6 24h6M36 24h6" style={INK} />
        <circle cx="24" cy="24" r="2.75" style={DOT} />
      </>
    ),
  },
};

/** The hue of a ready agent's illustrated tile, or undefined for one without a scene (the coming-soon agents keep the line icon). */
export const templateHue = (id: string): number | undefined => SCENES[id]?.hue;

/**
 * The illustrated tile for a ready agent: the tile itself is part of the drawing, so callers render it bare.
 * An id with no scene falls back to the line icon on a wax tile.
 */
export function TemplateArt({ id, size = 44, className }: { id: string; size?: number; className?: string }) {
  const scene = SCENES[id];
  if (!scene) {
    return (
      <span
        style={{ width: size, height: size, borderRadius: size * 0.27 }}
        className={`grid shrink-0 place-items-center bg-[var(--wax-tint)] text-accent-ink ${className ?? ''}`}
      >
        <TemplateIcon id={id} size={Math.round(size / 2)} />
      </span>
    );
  }
  const h = scene.hue;
  // yellows and greens go olive at the shared lightness, so their mid tone sits a step lighter
  const warm = h >= 50 && h <= 125;
  const vars = {
    '--ta-bg': `oklch(0.26 0.045 ${h})`,
    '--ta-edge': `oklch(0.42 0.07 ${h} / 0.55)`,
    '--ta-mid': `oklch(${warm ? 0.62 : 0.52} 0.115 ${h})`,
    '--ta-ink': `oklch(0.87 0.11 ${h})`,
    '--ta-dot': `oklch(0.97 0.045 ${h})`,
  } as CSSProperties;
  return (
    <svg viewBox="0 0 48 48" width={size} height={size} aria-hidden="true" focusable="false" data-template-art={id} className={`shrink-0 ${className ?? ''}`} style={vars}>
      <rect x="0.5" y="0.5" width="47" height="47" rx="12.5" style={{ fill: 'var(--ta-bg)', stroke: 'var(--ta-edge)' }} />
      {scene.art}
    </svg>
  );
}
