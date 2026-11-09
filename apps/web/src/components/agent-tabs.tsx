'use client';
import { useSearchParams } from 'next/navigation';
import { copy } from '@/copy';
import { AGENT_TABS, agentHref, tabOf, type AgentTab } from '@/lib/agent-href';

/** The tab on screen: the address's, read in the browser, else the one the server rendered (`fallback`). */
export function useAgentTab(fallback: AgentTab): AgentTab {
  const sp = useSearchParams();
  return sp ? tabOf(sp.get('tab')) : fallback;
}

/**
 * A plain click on a link to another tab of this page: shows that tab and writes the address, with no server round trip.
 * Anything else (a modified click, a new browser tab) is left to the browser.
 */
export function onTabClick(e: React.MouseEvent<HTMLAnchorElement>, href: string) {
  if (e.defaultPrevented || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
  e.preventDefault();
  if (window.location.pathname + window.location.search !== href) window.history.pushState(null, '', href);
}

/**
 * The tab rail. Every tab's panel is already on the page (see CockpitPanels), so a tap only swaps which one shows and writes
 * the address with history.pushState, which Next's router follows (useSearchParams updates, Back works): no server round trip.
 * A modified click (new tab, new window) is left to the browser. Pills that scroll sideways on a phone, a column in the rail.
 */
export function AgentTabs({ agentId, active: fallback }: { agentId: string; active: AgentTab }) {
  const active = useAgentTab(fallback);
  return (
    <nav aria-label="Agent" className="-mx-3 overflow-x-auto px-3 [scrollbar-width:none] sm:-mx-5 sm:px-5 lg:mx-0 lg:overflow-visible lg:px-0 [&::-webkit-scrollbar]:hidden">
      <div className="flex w-max gap-1.5 lg:w-full lg:flex-col lg:gap-0.5">
        {AGENT_TABS.map((t) => {
          const href = agentHref(agentId, t);
          return (
            <a
              key={t}
              href={href}
              data-tab={t}
              aria-current={t === active ? 'page' : undefined}
              onClick={(e) => onTabClick(e, href)}
              className={`inline-flex h-11 items-center rounded-full px-4 text-[14.5px] font-semibold whitespace-nowrap lg:h-9 lg:w-full lg:rounded-lg lg:px-3 motion-safe:transition-colors motion-safe:duration-100 ${t === active ? 'bg-fg text-bg' : 'text-fg-2 hover:bg-line hover:text-fg'}`}
            >
              {copy.agent.tabs[t]}
            </a>
          );
        })}
      </div>
    </nav>
  );
}

/**
 * Every tab's panel, mounted once and kept: the inactive ones are `hidden`, so a switch is instant and each keeps its state
 * (a chat in progress, a skill being read). The panels themselves stream in from the server with the page.
 */
export function CockpitPanels({ fallback, panels }: { fallback: AgentTab; panels: Record<AgentTab, React.ReactNode> }) {
  const active = useAgentTab(fallback);
  return (
    <>
      {AGENT_TABS.map((t) => (
        <section key={t} data-panel={t} hidden={t !== active} aria-label={copy.agent.tabs[t]} className="min-w-0">
          {panels[t]}
        </section>
      ))}
    </>
  );
}
