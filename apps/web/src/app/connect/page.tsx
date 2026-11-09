import { ConnectPanel } from '@/components/connect-panel';
import { DesktopSetup } from '@/components/desktop-setup';
import { Page } from '@/components/page';
import { SignInCard } from '@/components/sign-in';
import { copy } from '@/copy';
import { KEY_PLACEHOLDER } from '@/lib/connect-config';
import { apiCall } from '@/server/api';
import { accessToken } from '@/server/session';
import { createTokenActions } from '@/server/token-actions';

export const dynamic = 'force-dynamic';

const c = copy.connect;

/** Keys for the owner MCP server: an AI tool (Grok Bot, the Claude/ChatGPT/Codex apps, Claude Code, Hermes, Grok Build, any MCP client) reads, talks to and pauses the owner's agent. */
export default async function ConnectPage() {
  const signedIn = Boolean(await accessToken().catch(() => undefined));
  const listed = signedIn ? await createTokenActions({ api: apiCall, token: accessToken }).list() : null;
  return (
    <Page>
      <h1 className="headline text-2xl">{c.title}</h1>
      <p className="mb-6 mt-2 text-fg-2">{c.lead}</p>
      {!signedIn ? (
        <section>
          <h2 className="text-lg font-semibold">{c.signInTitle}</h2>
          <p className="mb-4 mt-1 text-fg-2">{c.signInNote}</p>
          <SignInCard next="/connect" />
          <h2 className="mt-10 text-lg font-semibold">{c.desktopTitle}</h2>
          <p className="mb-4 mt-1 text-sm text-fg-2">{c.previewNote}</p>
          <DesktopSetup apiKey={KEY_PLACEHOLDER} />
        </section>
      ) : listed?.ok ? (
        <ConnectPanel keys={listed.tokens} />
      ) : (
        <p role="alert" className="text-lg">
          {c.failed}
        </p>
      )}
    </Page>
  );
}
