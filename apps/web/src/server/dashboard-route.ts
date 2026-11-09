import { redirect } from 'next/navigation';
import { agentHref, type AgentTab } from '@/lib/agent-href';
import { loadAgents } from './agent-data';

type Search = Record<string, string | string[] | undefined>;

/** The query string of `sp` (single values only), with its `?`, or ''. */
export function queryOf(sp: Search): string {
  const q = new URLSearchParams();
  for (const [k, v] of Object.entries(sp)) if (typeof v === 'string') q.set(k, v);
  const s = q.toString();
  return s ? `?${s}` : '';
}

/**
 * Where an address from before several agents per account goes (`/dashboard/chat`, a `/dashboard?run=` email link, an
 * "Add this to your agent" link): an owner with exactly one agent lands on that tab of it, query kept; an owner with several
 * gets the list (with the query, so a `?prompt=` still reaches the agent they pick); signed out or no agent, the first screen.
 * Plain /dashboard is not one of these: it always shows the list.
 */
export function legacyTarget(agents: { id: string }[] | null, tab: AgentTab, sp: Search): string {
  if (!agents || agents.length === 0) return '/';
  if (agents.length === 1) return agentHref(agents[0]!.id, tab, sp);
  return `/dashboard${queryOf(sp)}`;
}

/**
 * What plain /dashboard does: null shows the list (always, even with one agent: the free slots and New agent live there);
 * otherwise where to go. No agent goes to the first screen; an old link naming a run or carrying an idea opens the only agent.
 */
export function dashboardTarget(agents: { id: string }[] | null, sp: Search): string | null {
  if (!agents || agents.length === 0) return '/';
  if (agents.length === 1 && (sp.run !== undefined || sp.prompt !== undefined)) return legacyTarget(agents, 'activity', sp);
  return null;
}

export async function legacyTab(tab: AgentTab, sp: Search): Promise<never> {
  const res = await loadAgents();
  if (res.kind === 'error') redirect('/dashboard');
  redirect(legacyTarget(res.kind === 'ready' ? res.agents : null, tab, sp));
}
