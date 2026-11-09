import { redirect } from 'next/navigation';
import { AgentError } from '@/components/agent-screen';
import { MyAgentsView } from '@/components/my-agents';
import { Page } from '@/components/page';
import { readDraftParams } from '@/lib/draft-state';
import { loadAgents } from '@/server/agent-data';
import { dashboardTarget } from '@/server/dashboard-route';

export const dynamic = 'force-dynamic';

/**
 * My agents: always the list, even with one agent, because the list is where the free slots and New agent are. An old
 * link that names a run or carries an idea (`?run=`, `?prompt=`) still opens the only agent straight away; signed out or
 * no agent goes back to the first screen.
 */
export default async function MyAgentsPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const sp = await searchParams;
  const res = await loadAgents();
  if (res.kind === 'error') return <AgentError />;
  const agents = res.kind === 'ready' ? res.agents : null;
  const target = dashboardTarget(agents, sp);
  if (target !== null || !agents) redirect(target ?? '/');
  const { prompt } = readDraftParams(sp);
  return (
    <Page>
      <MyAgentsView agents={agents} limit={res.kind === 'ready' ? res.limit : null} prompt={prompt} />
    </Page>
  );
}
