'use client';

import { useRef, useState, type ReactNode } from 'react';
import {
  formatUsdc, getJson, paymentUrl, proofUrl, shortHash, timeAgo, usePoll,
  type FeedItem, type FeedPage,
} from '../lib/explore';
import { AppLink } from '@/components/app-link';
import { Loading } from '@/components/seal-loader';

export const FEED_CAP = 100;
export const FEED_EVERY_MS = 5_000;

/** Merge by `seq` (newer copy wins), newest first by `at`, at most `cap` lines. */
export function mergeFeed(prev: FeedItem[], incoming: FeedItem[], cap = FEED_CAP): FeedItem[] {
  const bySeq = new Map<number, FeedItem>();
  for (const i of prev) bySeq.set(i.seq, i);
  for (const i of incoming) bySeq.set(i.seq, i);
  return [...bySeq.values()].sort((a, b) => Date.parse(b.at) - Date.parse(a.at) || b.seq - a.seq).slice(0, cap);
}

/** A hash-prefix link for a feed line, or null. A malformed ref never throws into render. */
function linkFor(item: FeedItem): { href: string; text: string; label: string } | null {
  const l = item.link;
  if (!l) return null;
  try {
    if (l.type === 'proof') return { href: proofUrl(l), text: `proof · ${shortHash(l.ref)} ↗`, label: `proof ${shortHash(l.ref)}` };
    const word = l.type === 'payment' ? 'payment' : 'registration';
    return { href: paymentUrl(l.txHash), text: `${word} · ${shortHash(l.txHash)} ↗`, label: `${word} transaction ${shortHash(l.txHash)}` };
  } catch {
    return null;
  }
}

const tag = 'ex-tag';

function AgentLink({ id }: { id: number }) {
  return (
    <AppLink prefetch={false} className="ex-idl" href={`/agents/${id}`}>
      #{id}
    </AppLink>
  );
}

function Line({ item, now }: { item: FeedItem; now: Date }) {
  const link = linkFor(item);
  const when = timeAgo(item.at, now);
  const amount = item.amount !== null ? <span className="ex-amt">{formatUsdc(item.amount)} USDC</span> : null;
  let text: ReactNode;
  if (item.kind === 'paid') {
    text =
      item.otherAgentId !== null ? (
        <>
          Agent <AgentLink id={item.otherAgentId} /> paid <AgentLink id={item.agentId} /> {amount}
        </>
      ) : (
        <>
          Someone paid agent <AgentLink id={item.agentId} /> {amount}
        </>
      );
  } else if (item.kind === 'registered') {
    text = (
      <>
        New agent <AgentLink id={item.agentId} /> registered
      </>
    );
  } else {
    // Self-published text: a plain text node, never markup.
    text = (
      <>
        Agent <AgentLink id={item.agentId} /> opened a service: “{item.label ?? ''}”
      </>
    );
  }

  return (
    <li className={`ex-ln ${item.kind === 'paid' ? 'ex-pay' : 'ex-reg'}`}>
      <time className="ex-t" dateTime={item.at} title={item.at}>
        {when}
      </time>
      <div className="ex-m">
        <span className="ex-tx">
          {text}
          {item.kind === 'registered' && item.builder !== 'external' ? <span className={`${tag} ex-tag-ae ml-2`}>Built on AgentEnact</span> : null}
          {item.kind === 'service_opened' ? <span className={`${tag} ml-2`}>self-published</span> : null}
        </span>
        {link ? (
          <AppLink prefetch={false} className="ex-hash" href={link.href} aria-label={link.label}>
            {link.text}
          </AppLink>
        ) : item.kind === 'registered' ? (
          <span className="ex-fn">registry record</span>
        ) : null}
      </div>
    </li>
  );
}

export function FeedList({ items, now }: { items: FeedItem[]; now: Date }) {
  if (items.length === 0) {
    return <p className="ex-quiet" aria-live="polite">No activity yet. When an agent is paid or registered, it shows here.</p>;
  }
  return (
    <ul className="ex-log">
      {items.map((i) => (
        <Line key={i.seq} item={i} now={now} />
      ))}
    </ul>
  );
}

export const FEED_PAGE = 8;

/** The list is not a live region (relative times change every poll); only the status messages are announced. */
export function FeedBody({ data, error, shown, now }: { data: FeedItem[] | null; error: boolean; shown: number; now: Date }) {
  if (data === null) {
    return (
      error ? (
        <p className="ex-quiet" aria-live="polite">
          The feed is unavailable right now. Retrying.
        </p>
      ) : (
        <Loading layout="block" label="Loading the feed…" />
      )
    );
  }
  return (
    <>
      <FeedList items={data.slice(0, shown)} now={now} />
      {error ? (
        <p className="ex-quiet ex-small" aria-live="polite">
          Reconnecting. Showing the last lines received.
        </p>
      ) : null}
    </>
  );
}

/** First page of 50, then `?after=<seq>` every 5 s. Merging happens inside the poll, so there is no effect and no overlap. */
export function LiveFeed() {
  const items = useRef<FeedItem[]>([]);
  const after = useRef<number | null>(null);

  const { data, error } = usePoll<FeedItem[]>(async (signal) => {
    const path = after.current === null ? '/public/feed?limit=50' : `/public/feed?after=${after.current}`;
    const page = await getJson<FeedPage>(path, { signal });
    if (page.items.length > 0) after.current = Math.max(after.current ?? 0, ...page.items.map((i) => i.seq));
    else after.current = Math.max(after.current ?? 0, page.latestSeq);
    items.current = mergeFeed(items.current, page.items);
    return items.current;
  }, FEED_EVERY_MS);

  const [shown, setShown] = useState(FEED_PAGE);
  const list = data ?? [];
  const visible = list.slice(0, shown);

  return (
    <>
      <div className="ex-sh">
        <h2>Recent activity</h2>
        <p>{data === null ? 'loading' : 'payments and new agents · live'}</p>
      </div>
      <FeedBody data={data} error={error} shown={shown} now={new Date()} />
      {list.length > shown ? (
        <button type="button" onClick={() => setShown((n) => n + FEED_PAGE)} className="btn btn-quiet btn-sm ex-more">
          Show more lines
        </button>
      ) : null}
    </>
  );
}
