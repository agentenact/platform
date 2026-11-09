import { redirect } from 'next/navigation';
import { agentHref } from '@/lib/agent-href';

export const dynamic = 'force-dynamic';

/** The tab's address from before tabs became one page: the same tab, query kept (see AgentTabs). */
export default async function LegacyEditTab({ params, searchParams }: { params: Promise<{ id: string }>; searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  redirect(agentHref((await params).id, 'whatItDoes', await searchParams));
}
