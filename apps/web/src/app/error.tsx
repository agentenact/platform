'use client';
import { AppHeader } from '@/components/app-header';
import { SiteChrome } from '@/components/site-chrome';
import { Page } from '@/components/page';
import { SiteFooter } from '@/components/site-footer';
import { copy } from '@/copy';
import { AppLink } from '@/components/app-link';

/** Never shows the error: its message can carry internals. */
export default function ErrorPage() {
  const c = copy.shell;
  // Rendered under the root layout, which has no header: bring the site's own (not in a section with its own shell).
  return (
    <>
      <SiteChrome>
        <AppHeader />
      </SiteChrome>
      <Page>
        <h1 className="headline text-4xl sm:text-5xl">{c.errorTitle}</h1>
        <p role="alert" className="mt-4 text-fg-2">
          {c.errorNote}
        </p>
        <AppLink href="/" className="btn mt-6">
          {c.startOver}
        </AppLink>
      </Page>
      <SiteChrome>
        <SiteFooter />
      </SiteChrome>
    </>
  );
}
