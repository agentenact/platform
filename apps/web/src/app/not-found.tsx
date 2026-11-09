import { AppHeader } from '@/components/app-header';
import { SiteChrome } from '@/components/site-chrome';
import { Page } from '@/components/page';
import { SiteFooter } from '@/components/site-footer';
import { copy } from '@/copy';
import { AppLink } from '@/components/app-link';

export default function NotFound() {
  const c = copy.shell;
  // Rendered under the root layout, which has no header: bring the site's own (not in a section with its own shell).
  return (
    <>
      <SiteChrome>
        <AppHeader />
      </SiteChrome>
      <Page>
        <h1 className="headline text-4xl sm:text-5xl">{c.notFoundTitle}</h1>
        <p className="mt-4 text-fg-2">{c.notFoundNote}</p>
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
