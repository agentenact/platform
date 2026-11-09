interface Scrollable {
  getBoundingClientRect(): { top: number; bottom: number };
  scrollIntoView(options: { block: 'start'; behavior: 'auto' | 'smooth' }): void;
}
interface Viewport {
  innerHeight: number;
  matchMedia(query: string): { matches: boolean };
}

/** The sticky header covers the top 88px (5.5rem, matching scroll-padding-top in globals.css). */
export const HEADER_INSET = 88;

/**
 * Brings a region into view when part of it is off screen: smooth, or at once when the visitor prefers less motion.
 * The sticky header (top) and the mobile action bar (bottom, 0 when hidden) do not count as visible area.
 */
export function scrollIntoViewIfNeeded(el: Scrollable, win: Viewport = window, bottomInset = 0): void {
  const r = el.getBoundingClientRect();
  if (r.top >= HEADER_INSET && r.bottom <= win.innerHeight - bottomInset) return;
  const reduced = win.matchMedia('(prefers-reduced-motion: reduce)').matches;
  el.scrollIntoView({ block: 'start', behavior: reduced ? 'auto' : 'smooth' });
}
