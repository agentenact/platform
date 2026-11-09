import { Page } from '@/components/page';
import { copy } from '@/copy';
import { AGENT_TABS } from '@/lib/agent-href';
import { HARNESS_SETUPS, KEY_PLACEHOLDER } from '@/lib/connect-config';

/**
 * What a click on a page that reads the server shows at once, under the header that stays: that page's own layout, never a
 * spinner. Words that never change (titles, labels, tab names) are the real words; only what the server reads is a bar.
 * Every bar sits in a line set in the real text's size, so each line is as tall as the one that replaces it and nothing
 * jumps when the page arrives.
 */
function Busy({ children }: { children: React.ReactNode }) {
  return (
    <div aria-busy="true" role="status">
      <span className="sr-only">{copy.shell.loading}</span>
      <div aria-hidden>{children}</div>
    </div>
  );
}

/** One line of text still on its way: `text` is the real line's classes (size, leading), `w` the bar's width. */
function Line({ text = '', w, className = '' }: { text?: string; w: string; className?: string }) {
  return (
    <span className={`block ${text} ${className}`}>
      <span className={`soft inline-block h-[0.72em] max-w-full rounded-full bg-line align-middle ${w}`} />
    </span>
  );
}

/** /dashboard: the title, the slot line, New agent, and agent rows (components/my-agents.tsx). */
export function MyAgentsSkeleton() {
  return (
    <Page>
      <Busy>
        <div className="flex flex-wrap items-end justify-between gap-3">
          <div>
            <h1 className="headline text-2xl">{copy.myAgents.title}</h1>
            <p className="mt-1.5 flex items-center gap-2.5 text-sm text-fg-3">
              <span className="flex gap-1">
                {[0, 1, 2].map((i) => (
                  <span key={i} className="soft h-1.5 w-5 rounded-full bg-line" />
                ))}
              </span>
              <Line w="w-32" />
            </p>
          </div>
          <span className="soft h-11 w-[106px] rounded-full bg-line" />
        </div>
        <ul className="mt-4 grid gap-2">
          {['w-44', 'w-32'].map((w) => (
            <li key={w} className="flex min-h-14 items-center gap-3 rounded-2xl border border-line px-4 py-3">
              <span className="soft size-7 shrink-0 rounded-full bg-line" />
              <Line text="min-w-0 flex-1 text-[15px]" w={w} />
              <Line text="shrink-0 text-sm" w="w-14" />
              <span className="text-fg-3">→</span>
            </li>
          ))}
        </ul>
      </Busy>
    </Page>
  );
}

const I = copy.agent.instruments;
const INSTRUMENTS = [I.nextCheck, I.lastReading, I.checksToday, I.alerts, I.earned, I.budget];
const L = copy.agent.live;

/**
 * /dashboard/<id>: the agent's cockpit (components/agent-screen.tsx AgentView). The header panel with its live line, the six
 * instruments with their labels, the tab rail on Activity (every link here opens it), the Today card over a feed of rows,
 * and the side column with the wallets, the harness row and Delete. A phone gets the same order top to bottom, as the page does.
 */
export function CockpitSkeleton() {
  return (
    <Page width="cockpit">
      <Busy>
        <div className="flex flex-col gap-3">
          <header className="panel panel-sand p-5">
            <div className="flex flex-wrap items-start justify-between gap-x-4 gap-y-3">
              <div className="min-w-0">
                <p className="text-sm text-fg-2">{copy.agent.label}</p>
                {/* Most names take two lines on a phone and one on a wider screen. */}
                <div className="headline mt-1 text-3xl lg:text-[28px] lg:leading-[1.05]">
                  <Line w="w-64" />
                  <Line w="w-40" className="sm:hidden" />
                </div>
              </div>
              <div className="flex items-center gap-2">
                <span className="inline-flex h-9 w-28 items-center gap-2 rounded-full bg-white px-3.5">
                  <span className="soft h-2.5 w-2.5 shrink-0 rounded-full bg-line" />
                  <span className="soft h-2.5 flex-1 rounded-full bg-line" />
                </span>
                <span className="soft h-11 w-[86px] rounded-full border border-line" />
              </div>
            </div>
            <div className="mt-4 max-w-[72ch] text-[15px]">
              {/* One line on a wide screen, three on a phone: what most sentences take. */}
              <Line w="w-full lg:w-3/4" />
              <Line w="w-full" className="lg:hidden" />
              <Line w="w-1/2" className="lg:hidden" />
            </div>
            {/* The live line (components/agent-live.tsx): label over value from sm up, side by side on a phone. */}
            <div className="mt-4 grid gap-x-6 gap-y-2 border-t border-[var(--raised-line)] pt-3.5 text-sm sm:grid-cols-[minmax(0,1.3fr)_minmax(0,1fr)_minmax(0,1fr)]">
              {[L.now, L.next, L.last].map((label, i) => (
                <div key={label} className="flex min-w-0 items-baseline justify-between gap-3 sm:block">
                  <span className="block shrink-0 text-[12.5px] text-fg-3">{label}</span>
                  <Line text="sm:mt-0.5" w={['w-44', 'w-24', 'w-32'][i] ?? 'w-24'} />
                </div>
              ))}
            </div>
          </header>
          <div className="grid grid-cols-2 gap-px overflow-hidden rounded-[var(--radius-object)] border border-[var(--raised-line)] bg-[var(--raised-line)] sm:grid-cols-3 xl:grid-cols-6">
            {INSTRUMENTS.map((label) => (
              <div key={label} className="flex min-w-0 flex-col gap-1.5 bg-raised px-4 py-3.5">
                <span className="text-[12.5px] leading-tight text-fg-2">{label}</span>
                <span className="block">
                  <span className="soft block h-[19px] w-16 rounded-md bg-line" />
                  <Line text="mt-1.5 text-[12px]" w="w-20" />
                </span>
              </div>
            ))}
          </div>
          <div className="grid gap-3 lg:grid-cols-[176px_minmax(0,1fr)_300px] lg:items-start">
            <div className="-mx-3 overflow-hidden px-3 sm:-mx-5 sm:px-5 lg:mx-0 lg:px-0">
              <div className="flex w-max gap-1.5 lg:w-full lg:flex-col lg:gap-0.5">
                {AGENT_TABS.map((t, i) => (
                  <span key={t} className={`inline-flex h-11 items-center rounded-full px-4 text-[14.5px] font-semibold whitespace-nowrap lg:h-9 lg:w-full lg:rounded-lg lg:px-3 ${i === 0 ? 'bg-fg text-bg' : 'text-fg-2'}`}>
                    {copy.agent.tabs[t]}
                  </span>
                ))}
              </div>
            </div>
            <div className="min-w-0">
              <div className="mb-2.5 flex items-baseline justify-between gap-4 px-1">
                <h2 className="text-lg font-semibold text-fg">{copy.activity.title}</h2>
                <p className="text-sm text-fg-3">{copy.activity.span}</p>
              </div>
              {/* The Today card most agents show above the feed (components/today-card.tsx), its morning-note row answered. */}
              <div className="mb-3">
                <section className="card">
                  <div className="flex items-baseline justify-between gap-4">
                    <Line text="eyebrow" w="w-12" />
                    <Line text="text-sm" w="w-24" />
                  </div>
                  {/* Its headline and line wrap once more on a phone. */}
                  <div className="headline mt-1 text-xl">
                    <Line w="w-3/5" />
                    <Line w="w-2/5" className="sm:hidden" />
                  </div>
                  <div className="mt-2 text-sm">
                    <Line w="w-2/5" />
                    <Line w="w-1/4" className="sm:hidden" />
                  </div>
                  <div className="mt-4 border-t border-line pt-4">
                    <div className="flex min-h-11 items-center">
                      <Line text="text-sm" w="w-48" />
                    </div>
                  </div>
                </section>
              </div>
              <div className="card !p-0">
                <ul className="divide-y divide-line">
                  {['w-3/5', 'w-4/5', 'w-1/2', 'w-2/3'].map((w) => (
                    <li key={w} className="px-4 py-3 text-sm sm:px-6">
                      <Line text="text-xs" w="w-16" />
                      <Line w={w} />
                    </li>
                  ))}
                </ul>
              </div>
            </div>
            <aside className="flex min-w-0 flex-col gap-3">
              <WalletsSkeleton />
              <section className="rounded-[var(--radius-object)] border border-[var(--raised-line)] px-4 py-3.5">
                <p className="flex items-center justify-between gap-3 text-[14.5px] font-semibold text-fg">
                  {copy.agent.harness}
                  <span className="text-fg-3">↗</span>
                </p>
                <p className="mt-1 text-[12.5px] leading-[1.5] text-fg-3">{copy.agent.harnessNote}</p>
              </section>
              <span className="self-start px-1 py-2 text-sm text-fg-3 underline decoration-line underline-offset-4">{copy.agent.remove.open}</span>
            </aside>
          </div>
        </div>
      </Busy>
    </Page>
  );
}

/**
 * The wallets card while it streams in (components/wallets-card.tsx): shown by the cockpit skeleton and kept as the card's
 * own Suspense fallback on the page, so the side column holds its place until the card arrives.
 */
export function WalletsSkeleton() {
  return (
    <section aria-hidden className="mt-4 rounded-2xl border border-line px-4 py-3">
      <h2 className="text-sm font-semibold text-fg">{copy.wallets.title}</h2>
      <div className="mt-2 flex flex-col gap-2 text-sm">
        <div className="flex flex-col gap-1">
          <Line w="w-28" />
          <Line text="text-xs" w="w-24" />
          <Line text="text-xs" w="w-40" />
        </div>
        <div className="flex flex-col gap-1">
          <Line w="w-24" />
          <span className="flex items-center gap-2">
            <Line w="w-24" />
            <span className="soft h-11 w-[78px] rounded-full border border-line" />
          </span>
        </div>
      </div>
      <div className="mt-2 text-xs">
        <Line w="w-full" />
        <Line w="w-1/2" />
      </div>
    </section>
  );
}

const C = copy.connect;

/**
 * /connect (signed in, from the account menu): the title and lead, the key form, the setup blocks, which never change
 * before a key is made, and the key list (app/connect/page.tsx, components/connect-panel.tsx).
 */
export function ConnectSkeleton() {
  return (
    <Page>
      <Busy>
        <h1 className="headline text-2xl">{C.title}</h1>
        <p className="mb-6 mt-2 text-fg-2">{C.lead}</p>
        <div className="space-y-6">
          <section className="card space-y-3">
            <p className="block text-sm font-medium">{C.nameLabel}</p>
            <div className="flex flex-col gap-3 sm:flex-row">
              <span className="soft h-12 w-full rounded-xl border border-line" />
              <span className="soft h-12 w-full shrink-0 rounded-full bg-line sm:w-[131px]" />
            </div>
          </section>
          <section className="space-y-3">
            <h2 className="text-lg font-semibold">{C.setupTitle}</h2>
            {HARNESS_SETUPS.map((h) => (
              <div key={h.id} className="card space-y-2">
                <div className="flex min-h-11 items-center justify-between gap-3">
                  <p className="font-medium">
                    {h.label} <span className="text-sm font-normal text-fg-3">{h.where}</span>
                  </p>
                  {/* Where Copy sits, so the label wraps as it will. */}
                  <span className="h-11 w-[78px] shrink-0" />
                </div>
                <pre className="overflow-x-hidden rounded-xl bg-bg p-3 font-mono text-[12.5px] leading-relaxed text-fg-2">{h.lines(KEY_PLACEHOLDER)}</pre>
              </div>
            ))}
          </section>
          <section className="space-y-3">
            <h2 className="text-lg font-semibold">{C.keysTitle}</h2>
            <div className="rounded-2xl border border-line px-4 py-3">
              <Line text="font-medium" w="w-32" />
              <Line text="text-sm" w="w-4/5" />
            </div>
          </section>
        </div>
      </Busy>
    </Page>
  );
}
