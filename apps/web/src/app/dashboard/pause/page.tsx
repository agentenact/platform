import { Page } from '@/components/page';
import { SignInCard } from '@/components/sign-in';
import { Button } from '@/components/ui/button';
import { pausePage } from '@/server/pause-confirm';
import { accessToken } from '@/server/session';

export const dynamic = 'force-dynamic';

/** Where the alert email's "Pause my agent" lands. Pauses nothing: see server/pause-confirm.ts. */
export default async function PausePage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const sp = await searchParams;
  const signedIn = Boolean(await accessToken().catch(() => undefined));
  const view = pausePage(sp.agent, signedIn);
  return (
    <Page>
      {view.kind === 'bad' ? (
        <section>
          <h1 className="headline text-2xl">This link is not right</h1>
          <p className="mt-2 text-fg-2">Open the pause link from your agent email again.</p>
        </section>
      ) : view.kind === 'signin' ? (
        <section>
          <h1 className="headline text-2xl">Sign in to pause your agent</h1>
          <p className="mb-4 mt-2 text-fg-2">Use the email you made your agent with. The link brings you back here.</p>
          <SignInCard next={view.next} />
        </section>
      ) : (
        <section>
          <h1 className="headline text-2xl">Pause your agent?</h1>
          <p className="mb-4 mt-2 text-fg-2">It stops checking and stops emailing you until you turn it back on from your agent page. Nothing else changes.</p>
          <form method="post" action="/dashboard/pause/confirm">
            <input type="hidden" name="agent" value={view.agent} />
            <Button type="submit" size="lg">Pause my agent</Button>
          </form>
        </section>
      )}
    </Page>
  );
}
