'use client';
import { useId, useRef, useState, useSyncExternalStore } from 'react';
import { loadRunAction } from '@/app/actions/agent';
import { wallClock } from '@/components/agent-live';
import { RunPanel, type RunState } from '@/components/run-details';
import { copy } from '@/copy';
import { ago, dayWord, formatUsdc, safeUrl } from '@/lib/agent-format';
import { explorerTx, shortHash, type ChainTx, type DaySeals, type FeedItem } from '@/lib/agent-types';
import { plainText } from '@/lib/draft-display';
import { oneLineMarkdown } from '@/lib/markdown';
import { fetchOnce, type RunOut } from '@/lib/run-details';

export type FetchRun = (runId: string) => Promise<RunOut>;

/**
 * Newest first, as the api sends it. One white card, rows separated by hairlines. Quiet days are one line; alerts danger red; proven
 * sales green with a proof link. Each row is a single element, and the ones that come from a run carry its id (`data-run-id`);
 * alert, sale and problem rows open to show what that run did. `fetchRun` is for tests; the page uses the server action.
 */
export function ActivityFeed({
  items,
  now,
  agentId,
  fetchRun,
  opened,
  firstRunAt,
  scheduled = false,
}: {
  /** The agent works on a clock: a finished run is its job done, drawn plainly, not as a red alert. */
  scheduled?: boolean;
  /** A scheduled agent's first run, when the feed is empty: the empty line names its time instead of "within a minute". */
  firstRunAt?: string | null;
  items: FeedItem[];
  now: number;
  agentId: string;
  fetchRun?: FetchRun;
  /** A run read on the server for a `?run=` link (the alert email's "See what I saw"): its row starts open with these details. */
  opened?: { runId: string; out: RunOut };
}) {
  const cache = useRef(new Map<string, Promise<RunOut>>(opened ? [[opened.runId, Promise.resolve(opened.out)]] : []));
  if (items.length === 0) return <EmptyFeed firstRunAt={firstRunAt ?? null} now={now} />;
  const ask: FetchRun = fetchRun ?? ((runId) => loadRunAction(agentId, runId));
  return (
    <div data-feed="" className="card !p-0">
      <ul className="divide-y divide-line">
        {items.map((it, i) => (
          <li
            key={`${it.type}-${it.at}-${i}`}
            data-item={it.type}
            {...('runId' in it && it.runId ? { 'data-run-id': it.runId } : {})}
            className="min-w-0 px-4 py-3 text-sm sm:px-6"
          >
            {it.type !== 'quiet' && it.runId ? (
              <OpenRow it={it} now={now} scheduled={scheduled} runId={it.runId} cache={cache.current} ask={ask} {...(opened?.runId === it.runId ? { initial: opened.out } : {})} />
            ) : (
              <>
                <TopLine it={it} now={now} />
                <Body it={it} now={now} scheduled={scheduled} />
                {it.type === 'quiet' && it.seals ? <Sealed agentId={agentId} day={it.day} seals={it.seals} /> : null}
              </>
            )}
          </li>
        ))}
      </ul>
    </div>
  );
}

/**
 * The row's first line: when, and on the right what it links to (a sale's proof, the transactions). The text under it gets
 * the row's whole width.
 */
function TopLine({ it, now, children }: { it: FeedItem; now: number; children?: React.ReactNode }) {
  return (
    <div className="flex flex-wrap items-baseline justify-between gap-x-4">
      <span className="block text-xs text-fg-3">{ago(it.at, now)}</span>
      <span className="flex flex-wrap items-baseline justify-end gap-x-4">
        {children}
        <TxCell it={it} />
      </span>
    </div>
  );
}

/** The row as a button over its summary, and the region it opens. The run is asked for on the first open only. */
function OpenRow({
  it,
  now,
  scheduled = false,
  runId,
  cache,
  ask,
  initial,
}: {
  it: Exclude<FeedItem, { type: 'quiet' }>;
  now: number;
  scheduled?: boolean;
  runId: string;
  cache: Map<string, Promise<RunOut>>;
  ask: FetchRun;
  initial?: RunOut;
}) {
  const [open, setOpen] = useState(initial !== undefined);
  const [state, setState] = useState<RunState | null>(initial === undefined ? null : initial.ok ? { kind: 'ready', run: initial.run } : { kind: 'error' });
  const regionId = useId();
  const load = () => {
    setState({ kind: 'loading' });
    void fetchOnce(cache, runId, ask).then((out) => setState(out.ok ? { kind: 'ready', run: out.run } : { kind: 'error' }));
  };
  const toggle = () => {
    const next = !open;
    setOpen(next);
    if (next && state === null) load();
  };
  const href = it.type === 'sale' ? safeUrl(it.proofUrl) : null;
  return (
    <>
      <TopLine it={it} now={now}>
        {href ? (
          <a href={href} target="_blank" rel="noopener noreferrer" className="font-medium text-proven underline underline-offset-2">
            {copy.activity.proof}
          </a>
        ) : null}
      </TopLine>
      <button type="button" aria-expanded={open} aria-controls={regionId} onClick={toggle} className="-mb-1 block min-h-11 w-full min-w-0 pb-1 text-left">
        <Body it={it} now={now} scheduled={scheduled} noLink />
        <span className="sr-only">{open ? copy.runDetails.close : copy.runDetails.open}</span>
      </button>
      <div id={regionId} hidden={!open}>
        {open && state ? <RunPanel state={state} problem={it.type === 'problem'} onRetry={load} {...(it.type === 'sale' && it.proofUrl ? { proofUrl: it.proofUrl } : {})} /> : null}
      </div>
    </>
  );
}

/** The transactions a row names: a sale's settlement, what a run paid to hire and its sealed decision, or a day's newest sealed check. */
function txsOf(it: FeedItem): ChainTx[] {
  if (it.type === 'sale') return it.tx ? [it.tx] : [];
  if (it.type === 'alert' || it.type === 'problem') return [...(it.payments ?? []), ...(it.decision?.tx ? [it.decision.tx] : [])];
  return it.seals?.last ? [it.seals.last] : [];
}

/** The row's transaction column: the hash, short, linked to the chain's explorer. A row with none (a check only reads) shows nothing. */
function TxCell({ it }: { it: FeedItem }) {
  const txs = txsOf(it);
  if (txs.length === 0) return null;
  return (
    <span className="flex shrink-0 flex-wrap items-baseline justify-end gap-x-3 gap-y-1">
      {txs.map((t) => {
        const href = explorerTx(t);
        const label = copy.activity.viewTx(shortHash(t.hash));
        return href ? (
          <a key={t.hash} data-tx={t.hash} href={href} target="_blank" rel="noopener noreferrer" title={t.hash} className="font-mono text-[12px] text-fg-2 underline decoration-[var(--raised-line)] underline-offset-4 hover:text-fg">
            {label}
          </a>
        ) : (
          <span key={t.hash} data-tx={t.hash} title={t.hash} className="font-mono text-[12px] text-fg-2">
            {shortHash(t.hash)}
          </span>
        );
      })}
    </span>
  );
}

/** "266 of 266 checks sealed on chain · proofs ↓": the download is the day's documents, so the owner can check each one. */
function Sealed({ agentId, day, seals }: { agentId: string; day: string; seals: DaySeals }) {
  const c = copy.activity;
  const rest = seals.sent + seals.failed < seals.total;
  return (
    <span data-sealed="" className="mt-1 flex flex-wrap items-baseline gap-x-2 text-xs text-fg-3">
      <span>
        {c.sealed(seals.sent, seals.total)}
        {seals.failed > 0 ? `, ${c.sealFailed(seals.failed)}` : rest ? `, ${c.sealing}` : ''}
      </span>
      <a href={`/dashboard/${agentId}/seals/${day}`} download={`checks-${day}.json`} title={c.proofsTitle} className="underline decoration-[var(--raised-line)] underline-offset-4 hover:text-fg">
        {c.proofs}
      </a>
    </span>
  );
}

function Paid({ it }: { it: FeedItem }) {
  if ((it.type !== 'alert' && it.type !== 'problem') || !it.payments) return null;
  const total = it.payments.reduce((n, p) => n + Number(p.usdc), 0);
  return <span className="mt-1 block text-xs text-fg-2">{copy.activity.paid(formatUsdc(total.toFixed(7)))}</span>;
}

/** Whether the run's decision, with what it paid, is sealed on chain. The landed one links from the transaction column. */
function Decided({ it }: { it: FeedItem }) {
  if ((it.type !== 'alert' && it.type !== 'problem') || !it.decision) return null;
  const c = copy.activity;
  const text = it.decision.status === 'sent' ? c.decisionSealed : it.decision.status === 'pending' ? c.decisionSealing : c.decisionFailed;
  return (
    <span data-decision={it.decision.status} title={c.decisionTitle} className="mt-1 block text-xs text-fg-3">
      {text}
    </span>
  );
}

function Body({ it, now, noLink, scheduled = false }: { it: FeedItem; now: number; noLink?: boolean; scheduled?: boolean }) {
  if (it.type === 'quiet') return <Quiet it={it} now={now} />;
  if (it.type === 'problem')
    return (
      <>
        <span className="block text-fg-2">{copy.activity.problem}</span>
        <Paid it={it} />
        <Decided it={it} />
      </>
    );
  if (it.type === 'alert' && scheduled)
    return (
      <>
        <span data-ran="" className="line-clamp-3 break-words font-medium text-fg">
          <span className="mr-2 rounded-full bg-line px-2 py-0.5 text-xs text-fg-2">{copy.activity.ran}</span>
          {plainText(oneLineMarkdown(it.text)) ?? copy.activity.ranPlain}
        </span>
        <Paid it={it} />
        <Decided it={it} />
      </>
    );
  if (it.type === 'alert')
    return (
      <>
        <span className="line-clamp-3 break-words font-medium text-danger">
          <span className="mr-2 rounded-full bg-danger/15 px-2 py-0.5 text-xs">{copy.activity.alert}</span>
          {plainText(oneLineMarkdown(it.text)) ?? copy.activity.alertPlain}
        </span>
        <Paid it={it} />
        <Decided it={it} />
      </>
    );
  const href = noLink ? null : safeUrl(it.proofUrl);
  return (
    <span className="flex flex-wrap items-baseline justify-between gap-x-4 font-medium text-proven">
      <span className="min-w-0 break-words">{copy.earnings.sale(formatUsdc(it.usdc))}</span>
      {href ? (
        <a href={href} target="_blank" rel="noopener noreferrer" className="underline underline-offset-2">
          {copy.activity.proof}
        </a>
      ) : null}
    </span>
  );
}

/** A first run more than this far off is not "within a minute". */
const SOON_MS = 2 * 60_000;

/**
 * The empty feed. An agent that watches a condition checks within a minute of being made; one that runs on a clock waits for
 * its slot, so its line names that time (in the viewer's zone, once the browser knows it) and points at Run now.
 */
function EmptyFeed({ firstRunAt, now }: { firstRunAt: string | null; now: number }) {
  const t = firstRunAt ? Date.parse(firstRunAt) : NaN;
  const later = Number.isFinite(t) && t - now > SOON_MS;
  const at = useSyncExternalStore(noop, () => (later ? wallClock(t, Date.now()) : null), () => null);
  return (
    <p data-feed="" data-empty={later ? 'scheduled' : 'soon'} className="card text-sm text-fg-2">
      {later ? copy.activity.emptyAt(at) : copy.activity.empty}
    </p>
  );
}

const pad = (n: number) => String(n).padStart(2, '0');
const noop = () => () => {};

/** HH:MM in the viewer's own time. The server (and the first paint) says UTC; the browser then swaps in its own clock, so nothing mismatches. */
function useClock(iso: string): string {
  const t = Date.parse(iso);
  const fmt = (utc: boolean) => {
    const d = new Date(t);
    return utc ? `${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}` : `${pad(d.getHours())}:${pad(d.getMinutes())}`;
  };
  return useSyncExternalStore(noop, () => fmt(false), () => fmt(true));
}

/** A day of quiet checks: with the api's range it says when it began and what the price did; without, the plain count. */
function Quiet({ it, now }: { it: Extract<FeedItem, { type: 'quiet' }>; now: number }) {
  const time = useClock(it.since ?? it.at);
  const range = it.range && it.since && Number.isFinite(Date.parse(it.since)) ? plainText(it.range) : null;
  const when = dayWord(it.day, now);
  const line = range ? (when === 'today' ? copy.activity.quietSince(time, it.count, range) : copy.activity.quietOn(when, time, it.count, range)) : copy.activity.quiet(it.count, when);
  return <span className="block text-fg-2">{line}</span>;
}
