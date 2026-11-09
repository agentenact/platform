import { panelLoaders } from '@/components/agent-panels';
import { AgentScreen } from '@/components/agent-screen';
import { loadAgent } from '@/server/agent-data';
import { loadSuggestion } from '@/server/sell-data';
import { loadSkillsHint } from '@/server/skills-data';
import { loadHistory } from '@/server/wallet-history-data';
import { loadWallets } from '@/server/wallets-data';

export const dynamic = 'force-dynamic';

/** One agent's page with every tab on it; `?tab=` says which shows (see AgentTabs). */
export default async function AgentPage({ params, searchParams }: { params: Promise<{ id: string }>; searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const { id } = await params;
  return <AgentScreen load={loadAgent} id={id} loadSuggestion={loadSuggestion} loadSkillsHint={loadSkillsHint} loadWallets={loadWallets} loadHistory={loadHistory} panelLoaders={panelLoaders} searchParams={await searchParams} />;
}
