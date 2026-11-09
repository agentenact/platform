import { sealGeometry } from '../lib/seal';

/**
 * A seal drawn from `hash` (lib/seal.ts). `ink` fills the wax, `mark` draws the rings on it.
 * Decorative unless a `label` is given.
 */
export function Seal({
  hash,
  size,
  ink = 'var(--accent)',
  mark = 'var(--fg)',
  label,
  className,
}: {
  hash: string;
  size?: number;
  ink?: string;
  mark?: string;
  label?: string;
  className?: string;
}) {
  const g = sealGeometry(hash);
  return (
    <svg
      viewBox="0 0 200 200"
      width={size}
      height={size}
      className={className}
      role={label ? 'img' : undefined}
      aria-label={label}
      aria-hidden={label ? undefined : true}
      focusable="false"
    >
      <path d={g.outline} fill={ink} />
      <circle cx="100" cy="100" r="80" fill="none" stroke={mark} strokeOpacity="0.55" strokeWidth="1" />
      {g.arcs.map((a, i) => (
        <path key={i} d={a.d} fill="none" stroke={mark} strokeWidth={a.width} strokeLinecap="round" strokeOpacity={a.opacity} />
      ))}
      <circle cx="100" cy="100" r="11" fill={mark} />
      <circle cx="100" cy="100" r="4.5" fill={ink} />
    </svg>
  );
}

/** The brand mark: the seal of the first x402 payment settled on Stellar by this code (testnet, 2026-09-22). */
export const BRAND_HASH = '61f7c958a9efa06bc4c671fb59e6a173ae268a7f454afd56608062ce48fc2bff';
