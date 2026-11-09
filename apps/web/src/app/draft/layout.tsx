import { ViewTransition } from 'react';
import { AppHeader } from '@/components/app-header';
import { SiteFooter } from '@/components/site-footer';
import { PAGE_TRANSITION } from '@/lib/page-transition';
import { getHeaderMe } from '@/server/account';

/** The draft flow renders with the session, header included, exactly as the root layout used to for every page. */
export default async function DraftLayout({ children }: { children: React.ReactNode }) {
  const me = await getHeaderMe();
  return (
    <>
      <AppHeader me={me} />
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
