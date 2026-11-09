'use client';

import {
  formatUsdc, getJson, getStats, paymentUrl, proofUrl, timeAgo, usePoll,
  type CommunityCounts, type FeedItem, type FeedPage, type Stats,
} from '@/lib/explore';
import { AskForm } from './ask-form';
import { Seal } from './seal';
import { TechLogos } from './tech-logos';
import { DeepSpace } from './deep-space';
import { AppLink } from '@/components/app-link';
import { SealLoader } from './seal-loader';

export const HERO_FEED_SIZE = 6;
/** Rows the panel shows; the ticker below runs the whole HERO_FEED_SIZE. */
export const HERO_PANEL_ROWS = 3;
const HERO_FEED_EVERY_MS = 15_000;

export interface HeroLine {
  key: number;
  chip: 'sealed' | 'paid' | 'new' | 'service';
  text: string;
  amount: string | null;
  /** Every row opens something: a payment its proof or transaction, anything else the agent's public page. */
  href: string;
  /** What the seal is drawn from: the proof ref or the transaction hash, else the feed position. */
  sealOf: string;
  /** The short mono note under the text: a hash prefix, or `self-published` for a service the agent listed itself. */
  note: string;
  at: string;
}

/** The agent's public profile, where its services and registration are shown. */
const agentPage = (id: number) => `/agents/${encodeURIComponent(String(id))}`;

/**
 * One feed item as a hero line. A payment opens its evidence (the proof, else the transaction); a new agent and a
 * service open the agent's page, since a self-published service has no transaction of its own. Self-published labels
 * stay plain text; a malformed link falls back to the agent's page instead of throwing into render.
 */
export function heroLine(item: FeedItem): HeroLine {
  const l = item.link;
  let evidence: string | null = null;
  try {
    if (l?.type === 'proof') evidence = proofUrl(l);
    else if (l?.type === 'payment') evidence = paymentUrl(l.txHash);
  } catch {
    evidence = null;
  }
  const sealOf = l?.type === 'proof' ? l.ref : l ? l.txHash : `seq:${item.seq}`;
  const href = item.kind === 'paid' && evidence ? evidence : agentPage(item.agentId);
  const note = item.kind === 'service_opened' ? 'self-published' : sealOf.startsWith('seq:') ? '' : sealOf.slice(0, 8);
  const base = { key: item.seq, href, sealOf, note, at: item.at };
  if (item.kind === 'paid') {
    return {
      ...base,
      chip: l?.type === 'proof' ? 'sealed' : 'paid',
      text: item.otherAgentId !== null ? `#${item.otherAgentId} paid #${item.agentId}` : `someone paid #${item.agentId}`,
      amount: item.amount !== null ? `${formatUsdc(item.amount)} USDC` : null,
    };
  }
  if (item.kind === 'registered') return { ...base, chip: 'new', text: `#${item.agentId} joined`, amount: null };
  return { ...base, chip: 'service', text: `#${item.agentId} opened “${item.label ?? ''}”`, amount: null };
}

/** `20 Oct`: the day the index stopped, in UTC. A paused index is usually days old, so the day says more than the time. */
export function sinceDay(iso: string | null): string | null {
  const t = iso ? Date.parse(iso) : NaN;
  return Number.isNaN(t) ? null : new Date(t).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', timeZone: 'UTC' });
}

const SHORT = new Intl.NumberFormat('en-US', { notation: 'compact', maximumFractionDigits: 1, roundingMode: 'trunc' });
/** `9,999` in full; from 10,000 short (`31.2K`, `1.2M`), cut down so a figure never reads above the real count. */
const figure = (n: number) => (n < 10_000 ? n.toLocaleString('en-US') : SHORT.format(n));

const BUILT_HERE = '/explore?built=agentenact';
const BY_PROOFS = '/explore?built=agentenact&sort=proofs';
/** The newest transaction on stellar.expert, else the agents ranked by proofs. */
const proofOf = (txHash: string | null | undefined) =>
  txHash ? { href: paymentUrl(txHash), external: true } : { href: BY_PROOFS, external: false };

export interface CommunityFigure {
  key: string;
  label: string;
  value: string;
  /** Where the figure opens: the newest seal or transaction on chain, or the agents built here (accounts have no public page). */
  href: string;
  external: boolean;
}

/** The four community figures under the feed, in reading order; null when the api does not send them. */
export function communityFigures(c: CommunityCounts | undefined): CommunityFigure[] | null {
  if (!c) return null;
  return [
    { key: 'people', label: 'users', value: figure(c.people), href: BUILT_HERE, external: false },
    { key: 'agents', label: 'agents created', value: figure(c.agents), href: BUILT_HERE, external: false },
    { key: 'seals', label: 'seals', value: figure(c.seals), ...proofOf(c.latestSealTx) },
    { key: 'txs', label: 'on-chain txs', value: figure(c.txs), ...proofOf(c.latestTx) },
  ];
}

/**
 * Its own box under the feed, headed like it: four counts in a ruled two-by-two grid, each a link to its proof.
 * A stale index or an older api shows none.
 */
function Community({ stats }: { stats: Stats | null }) {
  const figures = stats && !stats.stale ? communityFigures(stats.community) : null;
  if (!figures) return null;
  return (
    <section aria-labelledby="hero-stats-h" className="overflow-hidden rounded-[16px] border border-[var(--edge-sky)]">
      <div className="border-b border-line bg-[var(--sky-veil)] px-4 py-3.5">
        <h2 id="hero-stats-h" className="font-display text-[13px] font-semibold tracking-[0.06em] uppercase">
          Live stats
        </h2>
      </div>
      <ul className="hero-community">
        {figures.map((f) => {
          const body = (
            <>
              <span className="hero-community-n">{f.value}</span>
              <span className="hero-community-l">
                {f.label}
                {f.external ? <span aria-hidden> ↗</span> : null}
              </span>
            </>
          );
          return (
            <li key={f.key}>
              {f.external ? (
                <a href={f.href} target="_blank" rel="noopener noreferrer" title={`Open the newest of the ${f.label} on stellar.expert`}>
                  {body}
                </a>
              ) : (
                <AppLink href={f.href}>{body}</AppLink>
              )}
            </li>
          );
        })}
      </ul>
    </section>
  );
}

function Status({ stats, error }: { stats: Stats | null; error: boolean }) {
  if (error && !stats) {
    return (
      <span className="flex items-center gap-2 font-mono text-[11px] text-fg-3">
        <span className="pill-dot" data-state="off" /> offline
      </span>
    );
  }
  if (!stats) {
    return (
      <span className="flex items-center gap-2 font-mono text-[11px] text-fg-3">
        <SealLoader size={12} className="text-accent" /> connecting…
      </span>
    );
  }
  if (stats.stale) {
    const since = sinceDay(stats.indexedThrough);
    return (
      <span className="flex items-center gap-2 font-mono text-[11px] text-[var(--caution)]">
        <span className="pill-dot" data-state="paused" /> index paused{since ? ` since ${since}` : ''}
      </span>
    );
  }
  return (
    <span className="flex items-center gap-2 font-mono text-[11px] text-fg-2">
      <span className="pill-dot" /> live
    </span>
  );
}

function LiveSeals({ lines, error, stats, statsError }: { lines: HeroLine[] | null; error: boolean; stats: Stats | null; statsError: boolean }) {
  const now = new Date();
  return (
    <>
      <div className="flex items-center justify-between gap-3 border-b border-line px-4 py-3.5">
        <h2 className="font-display text-[13px] font-semibold tracking-[0.06em] uppercase">Happening now</h2>
        <Status stats={stats} error={statsError} />
      </div>
      {lines === null ? (
        error ? (
          <p className="px-4 py-6 text-[14px] text-fg-2" aria-live="polite">
            The network feed is unavailable right now. Retrying.
          </p>
        ) : (
          <ul aria-hidden className="py-1.5">
            {Array.from({ length: HERO_PANEL_ROWS }, (_, i) => (
              <li key={i} className="flex items-center gap-3 px-4 py-2.5">
                <span className="size-[26px] shrink-0 rounded-full bg-line" />
                <span className="h-3 w-2/3 rounded-full bg-line" />
              </li>
            ))}
          </ul>
        )
      ) : lines.length === 0 ? (
        <p className="px-4 py-6 text-[14px] text-fg-2">No activity yet. When an agent is paid or registered, it shows here.</p>
      ) : (
        <ul className="py-1.5">
          {lines.slice(0, HERO_PANEL_ROWS).map((l) => {
            const body = (
              <>
                <Seal hash={l.sealOf} size={26} ink={l.chip === 'sealed' || l.chip === 'paid' ? 'var(--wax)' : 'var(--text)'} mark="var(--deep)" className="shrink-0" />
                <span className="min-w-0 flex-1 text-[13px] leading-[1.45]">
                  <span className="flex flex-wrap items-center gap-x-2">
                    <span className="chip-ev" data-kind={l.chip === 'sealed' || l.chip === 'paid' ? 'paid' : 'other'}>
                      {l.chip}
                    </span>
                    <span className="truncate">{l.text}</span>
                  </span>
                  <span className="mt-0.5 block font-mono text-[11.5px] text-fg-3">
                    {[l.amount, l.note, timeAgo(l.at, now)].filter(Boolean).join(' · ')}
                  </span>
                </span>
              </>
            );
            return (
              <li key={l.key}>
                <AppLink href={l.href} className="flex items-center gap-3 px-4 py-2.5 transition-colors hover:bg-[var(--hover)]">
                  {body}
                </AppLink>
              </li>
            );
          })}
        </ul>
      )}
    </>
  );
}

/**
 * The hero: deep space (components/deep-space.tsx). A giant seal drawn from a real record's output hash hangs in it;
 * the ask hands the sentence to the panel; the live panel and the ticker read the public feed. `recordHash`
 * is the captured proof's output.sha256.
 */
export function Hero({ recordHash }: { recordHash: string }) {
  const feed = usePoll<HeroLine[]>(async (signal) => {
    const page = await getJson<FeedPage>(`/public/feed?limit=${HERO_FEED_SIZE}`, { signal });
    return page.items.slice(0, HERO_FEED_SIZE).map(heroLine);
  }, HERO_FEED_EVERY_MS);
  const stats = usePoll(getStats, 30_000);
  const lines = feed.data;

  return (
    <section id="create" className="night -mt-[68px] pt-[68px] sm:-mt-[72px] sm:pt-[72px]">
      <DeepSpace sealHash={recordHash} />

      <div className="mx-auto flex max-w-6xl flex-wrap items-start gap-12 px-5 pt-16 pb-14 sm:pt-24 sm:pb-16">
        <div className="min-w-0 flex-[999_1_520px]">
          <h1 className="font-display text-[clamp(2.5rem,6.2vw,5.25rem)] leading-[1.02] font-semibold tracking-[-0.03em] uppercase">
            Join the
            <br />
            <span className="text-accent">agent economy.</span>
          </h1>
          <p className="mt-7 max-w-[32rem] text-[17px] leading-[1.65] text-fg-2">
            Create an agent in one sentence. It works for you, earns from other agents and hires them in turn, in an open community anyone can
            join.
          </p>
          <AskForm className="mt-9 max-w-[560px]" />
        </div>

        <div className="flex min-w-0 max-w-[440px] flex-[1_1_340px] flex-col gap-3">
          <aside aria-label="Latest activity on the network" className="rounded-[16px] border border-[var(--edge-sky)] bg-[var(--sky-veil)]">
            <LiveSeals lines={lines} error={feed.error} stats={stats.data} statsError={stats.error} />
          </aside>
          <Community stats={stats.data} />
        </div>
      </div>

      <TechLogos />

      {lines && lines.length > 0 ? (
        <div aria-hidden className="ticker border-t border-line bg-[var(--sky-veil)] py-3 font-mono text-[12px] text-fg-3">
          <div className="ticker-track">
            {[...lines, ...lines].map((l, i) => (
              <span key={i}>
                {l.sealOf.startsWith('seq:') ? '' : `tx ${l.sealOf.slice(0, 8)} → `}<span className={l.chip === 'paid' || l.chip === 'sealed' ? 'text-accent-ink' : 'text-fg-2'}>{l.text}</span>
                {l.amount ? ` · ${l.amount}` : ''}
              </span>
            ))}
          </div>
        </div>
      ) : null}
    </section>
  );
}
