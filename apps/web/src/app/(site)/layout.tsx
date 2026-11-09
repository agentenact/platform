import { ViewTransition } from 'react';
import { AppHeader } from '@/components/app-header';
import { SiteFooter } from '@/components/site-footer';
import { PAGE_TRANSITION } from '@/lib/page-transition';

/**
 * The public pages: /, /explore, /market, /verify, /create and /agents/[id]. Nothing here reads the request, so they render
 * statically; the header's account part finds the visitor in the browser (components/header-account.tsx).
 */
export default function SiteLayout({ children }: { children: React.ReactNode }) {
  return (
    <>
      <AppHeader />
      {/* At least a screen tall, so the footer never rides up under the header while a page is on its way (globals.css). */}
      <div className="page-area">
        {/* Crossfades the page on navigation (globals.css, Route transitions); the header outside it stays put. */}
        <ViewTransition default="none" enter={PAGE_TRANSITION} exit={PAGE_TRANSITION} update={PAGE_TRANSITION}>
          {children}
        </ViewTransition>
      </div>
      <SiteFooter />
    </>
  );
}
