import { Page } from '@/components/page';
import { DeleteAgent } from '@/components/delete-agent';
import { redirect } from 'next/navigation';
import { Suspense } from 'react';
import { ActivityFeed } from '@/components/activity-feed';
import { loadRun as defaultLoadRun } from '@/server/run-data';
import type { RunOut } from '@/lib/run-details';
import { AgentHeader, Instruments } from '@/components/agent-header';
import { streamedPanels, type PanelLoaders } from '@/components/agent-panels';
import { AgentTabs, CockpitPanels } from '@/components/agent-tabs';
import { Chat } from '@/components/chat';
import { HarnessDialog } from '@/components/harness-dialog';
import { agentHref, tabOf, type AgentTab } from '@/lib/agent-href';
import { AgentCreateFlow } from '@/components/agent-open';
import { KeepLastGood } from '@/components/keep-last-good';
import { LiveRefresh } from '@/components/live-refresh';
import { SellCard } from '@/components/sell-card';
import { WalletsCard } from '@/components/wallets-card';
import { OnChain } from '@/components/on-chain';
import { WalletsSkeleton } from '@/components/page-skeleton';
import type { LoadHistory } from '@/server/wallet-history-data';
import type { LoadWallets } from '@/server/wallets-data';
import { SkillsCard } from '@/components/skills-card';
import { FirstCheck } from '@/components/first-check';
import { TodayCard } from '@/components/today-card';
import { copy } from '@/copy';
import { ERROR_RETRY_SECONDS, GETTING_READY_REFRESH_S, momentOf, refreshSeconds } from '@/lib/agent-moment';
import type { DraftData } from '@/lib/draft-types';
import { readDraftParams } from '@/lib/draft-state';
import type { AgentLoad, LoadAgent } from '@/server/agent-data';
import type { LoadSuggestion } from '@/server/sell-data';
import { AppLink } from '@/components/app-link';
import type { LoadSkillsHint } from '@/server/skills-data';

/** Plain state for an api that cannot answer: no status code, no body, one way forward. */
/** A failed first load (a slow or busy api) retries by itself: the next good read replaces this with the page. */
export function AgentError() {
  return (
    <Page>
      <LiveRefresh seconds={ERROR_RETRY_SECONDS} />
      <p role="alert" data-agent-error="" className="text-lg">
        {copy.agent.loadError}
      </p>
      <AppLink href="/dashboard" className="btn mt-4">
        {copy.agent.reload}
      </AppLink>
    </Page>
  );
}

/** The creation flow joined by an agent that exists: it only follows the agent to "ready", the draft is not used. */
const stubDraft = (name: string): DraftData => ({ name, sentence: [], params: [], bindings: [], spec: { persona: '', system_prompt: '', skills: [] } });
const RealCreateFlow = ({ id, name }: { id: string; name: string }) => (
  <section data-card="" className="card fade-in">
    <AgentCreateFlow draft={stubDraft(name)} resume={id} />
  </section>
);

const RUN_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/** The other tabs' bodies (see streamedPanels): rendered with the page, shown by the tab rail. */
export type OtherPanels = Record<Exclude<AgentTab, 'activity'>, React.ReactNode>;

/** "Run them from your harness": the step-by-step MCP setup, as on /create, from a quiet row in the side column. */
function HarnessRow() {
  return (
    <section data-harness="" className="rounded-[var(--radius-object)] border border-[var(--raised-line)] px-4 py-3.5">
      <HarnessDialog
        fullSetupHref="/create?view=code#mcp-own"
        trigger={
          <button type="button" className="flex w-full cursor-pointer items-center justify-between gap-3 rounded-md text-left text-[14.5px] font-semibold text-fg hover:text-accent-ink">
            {copy.agent.harness}
            <span aria-hidden="true" className="text-fg-3">↗</span>
          </button>
        }
      />
      <p className="mt-1 text-[12.5px] leading-[1.5] text-fg-3">{copy.agent.harnessNote}</p>
    </section>
  );
}

/** The page body for a loaded agent. */
export function AgentView({
  load,
  now,
  tab = 'activity',
  panels,
  createFlow = RealCreateFlow,
  sell = null,
  skills = null,
  wallets = null,
  onChain = null,
  opened,
}: {
  load: Extract<AgentLoad, { kind: 'ready' }>;
  /** The run named by `?run=`, read on the server (see AgentScreen). */
  opened?: { runId: string; out: RunOut };
  now: number;
  /** The tab the address named when the server rendered; the rail takes over in the browser. */
  tab?: AgentTab;
  /** The other tabs' bodies; without them those tabs are empty (tests of the Activity body). */
  panels?: Partial<OtherPanels>;
  createFlow?: (p: { id: string; name: string }) => React.ReactNode;
  /** The selling card, when there is one (see SellSlot). */
  sell?: React.ReactNode;
  /** The card pointing to skills from skills.sh, when there is one (see SkillsSlot). */
  skills?: React.ReactNode;
  /** The agent's wallets per network (see WalletsSlot). */
  wallets?: React.ReactNode;
  /** What the agent did on chain from those wallets, under the feed (see OnChainSlot). */
  onChain?: React.ReactNode;
}) {
  const { id, overview: o, feed, sentence, draft } = load;
  if (o.status === 'setting_up')
    return <Page>{createFlow({ id, name: o.name })}</Page>;
  const moment = momentOf(o, now);
  const waiting = moment === 'waiting' || moment === 'failed';
  const activity = (
    <>
      <div className="mb-2.5 flex items-baseline justify-between gap-4 px-1">
        <h2 className="text-lg font-semibold text-fg">{copy.activity.title}</h2>
        <p className="text-sm text-fg-3">{copy.activity.span}</p>
      </div>
      {waiting || moment === 'first' ? <FirstCheck o={o} now={now} moment={moment} draft={draft ?? null} /> : null}
      {moment === 'today' ? (
        <div className="mb-3">
          <TodayCard agentId={id} o={o} feed={feed} draft={draft ?? null} now={now} />
        </div>
      ) : null}
      {/* While the first check is awaited the card above is the page: an empty feed would say "Nothing yet" beside it. */}
      {waiting ? null : (
        <ActivityFeed
          agentId={id}
          items={feed}
          now={now}
          firstRunAt={o.status === 'watching' && !o.watchesCondition && !o.running ? o.nextCheckAt : null}
          scheduled={!o.watchesCondition}
          {...(opened ? { opened } : {})}
        />
      )}
      {waiting || feed.length === 0 ? null : <p className="mt-2.5 px-1 text-xs text-fg-3">{copy.activity.txNote}</p>}
      {onChain}
    </>
  );
  // The cockpit: the header and the instrument row across the top; under them the tab rail, the open tab, and a side column
  // of the agent's own things (wallets, the harness, offers). A phone reads it top to bottom in the same order.
  return (
    <Page width="cockpit">
      <div className="flex flex-col gap-3">
        <AgentHeader agentId={id} o={o} now={now} {...(sentence ? { sentence } : {})} {...(draft ? { draft } : {})} />
        <Instruments o={o} now={now} />
        <div className="grid gap-3 lg:grid-cols-[176px_minmax(0,1fr)_300px] lg:items-start">
          <div className="min-w-0 lg:sticky lg:top-24">
            <AgentTabs agentId={id} active={tab} />
          </div>
          <div className="min-w-0">
            <CockpitPanels
              fallback={tab}
              panels={{
                activity,
                chat: <Chat agentId={id} paused={o.status === 'paused' || o.status === 'getting_ready'} gettingReady={o.status === 'getting_ready'} />,
                whatItDoes: panels?.whatItDoes ?? null,
                skills: panels?.skills ?? null,
                earnings: panels?.earnings ?? null,
              }}
            />
          </div>
          <aside aria-label={copy.agent.sideLabel} className="flex min-w-0 flex-col gap-3">
            {wallets}
            <HarnessRow />
            {sell}
            {skills}
            <DeleteAgent agentId={id} name={o.name} />
          </aside>
        </div>
      </div>
      {/* Getting ready ends on its own (the reserve worker resumes it within minutes): re-read often, so it opens by itself. */}
      <LiveRefresh seconds={o.status === 'getting_ready' ? GETTING_READY_REFRESH_S : refreshSeconds(moment)} />
    </Page>
  );
}

/**
 * The selling card, read on the server. Only a non-null suggestion draws anything: no eligibility, a daily-limit answer or a
 * failed read all show nothing. Streamed inside Suspense, so the first read (which can take a few seconds) never holds the page.
 */
export async function SellSlot({ agentId, load }: { agentId: string; load: LoadSuggestion }) {
  const suggestion = await load(agentId);
  return suggestion ? <SellCard agentId={agentId} suggestion={suggestion} /> : null;
}

/**
 * The skills card, read on the server: only while the agent holds no skill from skills.sh. Any failure shows nothing.
 * Streamed inside Suspense like the selling card.
 */
/** The wallets card, read on the server. A failed read or an empty list shows nothing. Streamed inside Suspense, behind WalletsSkeleton. */
export async function WalletsSlot({ agentId, load }: { agentId: string; load: LoadWallets }) {
  const wallets = await load(agentId);
  return wallets && wallets.length > 0 ? <WalletsCard agentId={agentId} wallets={wallets} /> : null;
}

/** What the agent did on chain, read on the server. A failed read shows nothing. Streamed inside Suspense: chains can be slow. */
export async function OnChainSlot({ agentId, load, now }: { agentId: string; load: LoadHistory; now: number }) {
  const chains = await load(agentId);
  return chains ? <OnChain chains={chains} now={now} /> : null;
}

export async function SkillsSlot({ agentId, load }: { agentId: string; load: LoadSkillsHint }) {
  return (await load(agentId)) ? <SkillsCard agentId={agentId} /> : null;
}

/**
 * Server part of /dashboard/<id>: every tab at once (`?tab=` only says which shows first). No session or no agent goes back to
 * the first screen. A `?prompt=` from the draft screen ("Add this to your agent") opens What it does with the idea in the box;
 * nothing is sent to the builder from here.
 */
export async function AgentScreen({
  load,
  id,
  searchParams = {},
  now = Date.now(),
  createFlow,
  loadSuggestion,
  loadSkillsHint,
  loadWallets,
  loadHistory,
  loadRun = defaultLoadRun,
  panelLoaders,
}: {
  load: LoadAgent;
  /** Reads the other tabs' bodies; without them those tabs are empty (tests). */
  panelLoaders?: PanelLoaders;
  /** The agent id from the address. */
  id: string;
  /** Reads one run's details for a `?run=` link; injected in tests. */
  loadRun?: (agentId: string, runId: string) => Promise<RunOut>;
  searchParams?: Record<string, string | string[] | undefined>;
  now?: number;
  createFlow?: (p: { id: string; name: string }) => React.ReactNode;
  /** Reads the selling suggestion; without it the page has no card. */
  loadSuggestion?: LoadSuggestion;
  /** Reads whether to point the owner to skills; without it the page has no skills card. */
  loadSkillsHint?: LoadSkillsHint;
  /** Reads the agent's wallets; without it the page has no wallets card. */
  loadWallets?: LoadWallets;
  /** Reads what the agent did on chain; without it the page has no such list. */
  loadHistory?: LoadHistory;
}) {
  const res = await load(id);
  if (res.kind === 'signed_out') redirect('/');
  if (res.kind === 'no_agent') redirect('/dashboard');
  // A failed read keeps the last good page on screen when this is a live refresh (see KeepLastGood).
  if (res.kind === 'error') return <KeepLastGood ok={false} error={<AgentError />} />;
  const { prompt } = readDraftParams(searchParams);
  const tab = tabOf(searchParams.tab);
  // An idea from the draft screen opens the editor with it in the box; nothing runs from here.
  if (prompt && res.overview.status !== 'setting_up' && tab !== 'whatItDoes') redirect(agentHref(res.id, 'whatItDoes', { prompt }));
  // "See what I saw" in the alert email: open that run. Only one well-formed id is read; anything else is ignored.
  const runParam = typeof searchParams.run === 'string' && RUN_ID.test(searchParams.run) ? searchParams.run : null;
  const opened = runParam ? { runId: runParam, out: await loadRun(res.id, runParam).catch((): RunOut => ({ ok: false })) } : undefined;
  const sell = loadSuggestion ? (
    <Suspense fallback={null}>
      <SellSlot agentId={res.id} load={loadSuggestion} />
    </Suspense>
  ) : null;
  const skills =
    loadSkillsHint && res.overview.status !== 'setting_up' ? (
      <Suspense fallback={null}>
        <SkillsSlot agentId={res.id} load={loadSkillsHint} />
      </Suspense>
    ) : null;
  const wallets =
    loadWallets && res.overview.status !== 'setting_up' ? (
      <Suspense fallback={<WalletsSkeleton />}>
        <WalletsSlot agentId={res.id} load={loadWallets} />
      </Suspense>
    ) : null;
  const onChain =
    loadHistory && res.overview.status !== 'setting_up' ? (
      <Suspense fallback={null}>
        <OnChainSlot agentId={res.id} load={loadHistory} now={now} />
      </Suspense>
    ) : null;
  const extra = {
    ...(opened ? { opened } : {}),
    ...(createFlow ? { createFlow } : {}),
    ...(panelLoaders && res.overview.status !== 'setting_up' ? { panels: streamedPanels({ id: res.id, o: res.overview, now, prompt: prompt ?? '', load: panelLoaders }) } : {}),
  };
  const view = <AgentView load={res} now={now} tab={tab} sell={sell} skills={skills} wallets={wallets} onChain={onChain} {...extra} />;
  return (
    <KeepLastGood ok error={<AgentError />}>
      {view}
    </KeepLastGood>
  );
}
