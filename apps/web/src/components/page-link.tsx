'use client';
import Link from 'next/link';
import { useSyncExternalStore, type ComponentProps } from 'react';
import { PAGE_NAV } from '@/lib/page-transition';

const TYPES = [PAGE_NAV];
const QUERY = '(prefers-reduced-motion: reduce)';

const subscribe = (on: () => void) => {
  const m = window.matchMedia(QUERY);
  m.addEventListener('change', on);
  return () => m.removeEventListener('change', on);
};

/**
 * `next/link` tagged for the page crossfade. With reduced motion it is not tagged at all, so no view transition is
 * started (and none of its snapshot work is done): the page swaps at once.
 */
export function PageLink(props: ComponentProps<typeof Link>) {
  const reduce = useSyncExternalStore(subscribe, () => window.matchMedia(QUERY).matches, () => false);
  return <Link {...props} {...(reduce ? {} : { transitionTypes: TYPES })} />;
}
