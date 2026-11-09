import { Page } from '@/components/page';
import { DraftFlow } from '@/components/draft-flow';
import { isUnfinishedAgent, readDraftParams } from '@/lib/draft-state';
import { getMe } from '@/server/me';
import { accessToken } from '@/server/session';

/**
 * Server part of /draft. It reads ?prompt= (from the first screen or the site), ?template= with the /create builder's values, or ?h= (a draft parked before signing in) and
 * whether the visitor is signed in, then hands them to DraftFlow, which does the rest in the browser. With neither parameter
 * the browser decides: this tab may hold a draft from before a reload, and only an empty tab goes back to the first screen.
 */
export default async function DraftPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const { prompt, handoff, template, values, intent } = readDraftParams(await searchParams);
  const signedIn = Boolean(await accessToken().catch(() => undefined));
  const me = signedIn ? await getMe() : null;
  const agents = me?.agents ?? [];
  // At the account's limit an owner adds to one of their agents instead of creating another. An api that does not say its
  // limit is one from before several agents: one agent was the limit.
  const full = agents.length > 0 && agents.length >= (me?.agentLimit ?? 1);
  // Full, with an agent whose creation never finished: that one is resumed, not added to.
  const unfinished = full && agents.some((a) => isUnfinishedAgent(a.status));
  return (
    <Page>
      <DraftFlow prompt={prompt} handoff={handoff} template={template} values={values} intent={intent} signedIn={signedIn} full={full} unfinished={unfinished} hasAgents={agents.length > 0} />
    </Page>
  );
}
