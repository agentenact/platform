'use client';

import type { ReactNode } from 'react';
import { getStats, usePoll, utcTime, type Stats } from '../lib/explore';
import { Numbers, Overview, OverviewSkeleton } from './explore-numbers';
import { LiveFeed } from './feed';
import { AgentSearch } from './agent-list';

/** Minutes the index is behind, or null when it cannot be told. */
function minutesBehind(s: Stats): number | null {
  const a = Date.parse(s.asOf);
  const b = s.indexedThrough ? Date.parse(s.indexedThrough) : NaN;
  if (Number.isNaN(a) || Number.isNaN(b)) return null;
  return Math.max(1, Math.round((a - b) / 60_000));
}

/** Where the numbers come from: network, registry, how fresh, and whether updates are flowing. */
export function SourceBlock({ stats, failed = false }: { stats: Stats | null; failed?: boolean }) {
  const through = stats ? utcTime(stats.indexedThrough ?? stats.asOf) : null;
  const behind = stats?.stale ? minutesBehind(stats) : null;
  const status = !stats ? '—' : failed ? 'Not updating' : stats.stale ? (behind ? `Paused, ${behind} min behind` : 'Paused') : 'Current';
  return (
    <dl className="ex-src">
      <div>
        <dt>Network</dt>
        <dd>Stellar testnet</dd>
      </div>
      <div>
        <dt>Registry</dt>
        <dd>stellar-8004 · CDE3K4CO…FIWZH</dd>
      </div>
      <div>
        <dt>Indexed through</dt>
        <dd>{through ?? '—'}</dd>
      </div>
      <div>
        <dt>Status</dt>
        <dd className={stats && (failed || stats.stale) ? 'ex-st ex-warn' : 'ex-st'}>{status}</dd>
      </div>
    </dl>
  );
}

/** A failed stats poll in plain words: old figures are kept and dated; a failed first load gets a retry. Nothing when all is well. */
export function ExploreNotice({ stats, failed, onRetry }: { stats: Stats | null; failed: boolean; onRetry: () => void }) {
  if (!failed) return null;
  if (stats) {
    const through = utcTime(stats.indexedThrough ?? stats.asOf, false);
    return (
      <p role="status" className="ex-notice">
        <b>Can{'’'}t refresh right now.</b> These figures are as of {through ?? 'the last update'} and may be out of date. We keep trying.
      </p>
    );
  }
  return (
    <div role="status" className="ex-notice">
      <p>
        <b>The numbers can{'’'}t be loaded right now.</b> Check your connection and try again.
      </p>
      <button type="button" onClick={onRetry} className="btn btn-quiet btn-sm mt-3">
        Retry
      </button>
    </div>
  );
}

/** One line beside the title: live, paused or not updating, and the time the index runs through. */
export function LiveBadge({ stats, failed = false }: { stats: Stats | null; failed?: boolean }) {
  if (!stats) return <p className="ex-live ex-live-off">Stellar testnet</p>;
  const through = utcTime(stats.indexedThrough ?? stats.asOf, false);
  const word = failed ? 'Not updating' : stats.stale ? 'Paused' : 'Live';
  return (
    <p className={failed ? 'ex-live ex-warn' : stats.stale ? 'ex-live ex-warn ex-wait' : 'ex-live'}>
      <span className="ex-dot" aria-hidden="true" />
      {word} · Stellar testnet{through ? ` · through ${through}` : ''}
    </p>
  );
}

/**
 * `head` is the server-rendered title block. Agents come first, recent activity beside them, and the
 * counting rules, sources and CSV rows sit in a closed section at the end for whoever wants to check.
 */
export function ExploreBody({ head }: { head: ReactNode }) {
  const { data: stats, error, retry } = usePoll(getStats, 30_000);
  const through = stats ? utcTime(stats.indexedThrough ?? stats.asOf, false) : null;
  return (
    <>
      <div className="ex-head">
        {head}
        <LiveBadge stats={stats} failed={error} />
      </div>
      <ExploreNotice stats={stats} failed={error} onRetry={retry} />
      {stats?.stale && !error ? (
        <p role="status" className="ex-notice ex-wait">
          <b>Updates are paused.</b> These figures are as of {through ?? 'the last update'} and may be behind the chain. The downloads hold the same rows.
        </p>
      ) : null}
      <h2 className="sr-only">The network in numbers</h2>
      {stats ? <Overview stats={stats} stale={stats.stale || error} /> : error ? null : <OverviewSkeleton />}
      <div className="ex-cols">
        <section aria-label="Agents" className="min-w-0">
          <AgentSearch total={stats?.agents} />
        </section>
        <section aria-label="Recent activity" className="ex-side min-w-0">
          <LiveFeed />
        </section>
      </div>
      <details className="ex-method">
        <summary>
          <span className="ex-mt">How these numbers are counted</span>
          <span className="ex-ms">Definitions, sources and the rows behind every figure (CSV)</span>
        </summary>
        <div className="ex-mb">
          <SourceBlock stats={stats} failed={error} />
          {stats ? <Numbers stats={stats} variant="full" stale={stats.stale || error} /> : null}
        </div>
      </details>
    </>
  );
}
