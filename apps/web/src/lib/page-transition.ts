/**
 * The page crossfade runs only for a navigation through one of the app's links (components/app-link.tsx tags it with this
 * transition type). A refresh (the dashboard re-reads itself every 30 s), a back/forward or any other transition swaps the
 * content without animating it.
 */
export const PAGE_NAV = 'page-nav';

/** The <ViewTransition> class per transition type: `page` for a link navigation, nothing otherwise. */
export const PAGE_TRANSITION = { [PAGE_NAV]: 'page', default: 'none' } as const;
