/**
 * Line glyphs for the diagrams. Every path has pathLength=1 so `.draw[data-on]`
 * can draw it in with stroke-dashoffset. 24×24, stroke = currentColor.
 */
type GlyphProps = { className?: string };

function Svg({ className, children }: GlyphProps & { children: React.ReactNode }) {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.4} strokeLinecap="round" strokeLinejoin="round" className={className} aria-hidden>
      {children}
    </svg>
  );
}

/** A record: page with a folded corner and two lines of content. */
export function RecordGlyph({ className }: GlyphProps) {
  return (
    <Svg className={className}>
      <path pathLength={1} d="M6 3h8l4 4v14H6z" />
      <path pathLength={1} d="M14 3v4h4" />
      <path pathLength={1} d="M9 12h6M9 16h4" />
    </Svg>
  );
}

/** The agent's wallet: a key. */
export function KeyGlyph({ className }: GlyphProps) {
  return (
    <Svg className={className}>
      <circle pathLength={1} cx="8" cy="12" r="4" />
      <path pathLength={1} d="M12 12h9M18 12v3M21 12v2" />
    </Svg>
  );
}

/** The owner: a person. */
export function OwnerGlyph({ className }: GlyphProps) {
  return (
    <Svg className={className}>
      <circle pathLength={1} cx="12" cy="8" r="4" />
      <path pathLength={1} d="M4 21c1.5-4 4.5-6 8-6s6.5 2 8 6" />
    </Svg>
  );
}
