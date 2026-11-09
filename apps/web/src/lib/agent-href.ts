/** Addresses of one agent's page and its tabs. Plain module: the server (redirects) and the browser (the tab rail) both use it. */
export type AgentTab = 'activity' | 'chat' | 'whatItDoes' | 'skills' | 'earnings';

/** The tab's `?tab=` value; Activity has none. */
const QUERY: Record<AgentTab, string | null> = { activity: null, chat: 'chat', whatItDoes: 'edit', skills: 'skills', earnings: 'earnings' };
export const AGENT_TABS: readonly AgentTab[] = ['activity', 'chat', 'whatItDoes', 'skills', 'earnings'];

/** The tab a `?tab=` value names; anything else (none, unknown, repeated) is Activity. */
export function tabOf(q: string | string[] | null | undefined): AgentTab {
  return AGENT_TABS.find((t) => QUERY[t] !== null && QUERY[t] === q) ?? 'activity';
}

/**
 * A tab of one agent's page: /dashboard/<id>, /dashboard/<id>?tab=chat, … `extra` adds query values (a `?prompt=` for the
 * editor, a `?run=`), already encoded here. The tab is a query value, never a path, so switching it keeps the page mounted.
 */
export function agentHref(agentId: string, tab: AgentTab = 'activity', extra: Record<string, string | string[] | undefined> = {}): string {
  const q = new URLSearchParams();
  const t = QUERY[tab];
  if (t) q.set('tab', t);
  for (const [k, v] of Object.entries(extra)) if (k !== 'tab' && typeof v === 'string') q.set(k, v);
  const s = q.toString();
  return `/dashboard/${agentId}${s ? `?${s}` : ''}`;
}
