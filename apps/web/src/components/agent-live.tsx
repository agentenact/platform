'use client';
import { useEffect, useState } from 'react';
import { copy } from '@/copy';
import { ago, clockLeft } from '@/lib/agent-format';
import type { Overview } from '@/lib/agent-types';

const L = copy.agent.live;

export interface LiveLine {
  now: string;
  next: string;
  /** The next check as a wall-clock time, only once the browser knows its own time zone. */
  at: string | null;
  last: string;
  /** The agent is running a check this moment: the dot pulses. */
  busy: boolean;
}

/** "19:40", or "Fri 08:00" when it is not today, in the viewer's own time zone. */
export function wallClock(t: number, now: number, zone?: string): string {
  const opt: Intl.DateTimeFormatOptions = { hour: '2-digit', minute: '2-digit', hour12: false, ...(zone ? { timeZone: zone } : {}) };
  const day = (x: number) => new Intl.DateTimeFormat('en-CA', { dateStyle: 'short', ...(zone ? { timeZone: zone } : {}) }).format(x);
  const clock = new Intl.DateTimeFormat('en-GB', opt).format(t);
  return day(t) === day(now) ? clock : `${new Intl.DateTimeFormat('en-GB', { weekday: 'short', ...(zone ? { timeZone: zone } : {}) }).format(t)} ${clock}`;
}

/**
 * The header's live line as plain words, from the overview and a clock. `local` is false on the server and the first paint,
 * where the viewer's time zone is unknown: the wall-clock time is left out then, never shown in the server's zone.
 */
export function liveLine(o: Overview, now: number, local: boolean, zone?: string): LiveLine {
  const c = o.latestCheck;
  const r = o.lastRun;
  // A clock-driven agent logs no checks: its last run is its last check. Otherwise the newer of the two speaks.
  const last =
    r && (!c || Date.parse(r.at) > Date.parse(c.at)) ? `${ago(r.at, now)}, ${r.ok ? L.ran : L.failed}`
    : !c ? L.noCheck
    : `${ago(c.at, now)}, ${c.held === null ? L.failed : c.held ? L.worth : L.quiet}`;
  if (o.status === 'paused') return { now: L.paused, next: L.nextResume, at: null, last, busy: false };
  if (o.status === 'getting_ready') return { now: L.gettingReady, next: L.nextReady, at: null, last, busy: false };
  if (o.status === 'stopped_today') return { now: L.resting, next: L.nextTomorrow, at: null, last, busy: false };
  if (o.status !== 'watching') return { now: L.stopped, next: L.none, at: null, last, busy: false };
  const t = o.nextCheckAt ? Date.parse(o.nextCheckAt) : NaN;
  // Run now, or a slot that came due. The api leaves the running trigger out of the next time: that is the one after this
  // run, or, when only the running one is left, it is scheduled once this run ends.
  if (o.running) {
    const after = Number.isFinite(t) ? clockLeft(t - now) : null;
    return after === null ? { now: L.checking, next: L.nextAfter, at: null, last, busy: true } : { now: L.checking, next: L.nextIn(after), at: local ? wallClock(t, now, zone) : null, last, busy: true };
  }
  if (!Number.isFinite(t)) return { now: L.waiting, next: L.none, at: null, last, busy: false };
  const left = clockLeft(t - now);
  if (left === null) return { now: L.checking, next: L.nextSoon, at: null, last, busy: true };
  return { now: L.waiting, next: L.nextIn(left), at: local ? wallClock(t, now, zone) : null, last, busy: false };
}

/**
 * Now / Next check / Last check under the header's sentence. Ticks once a second in the browser so the countdown and
 * "Checking now" stay true between the page's 30-second re-reads.
 */
export function AgentLive({ o, now: serverNow }: { o: Overview; now: number }) {
  const [now, setNow] = useState<number | null>(null);
  useEffect(() => {
    setNow(Date.now());
    const i = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(i);
  }, []);
  const l = liveLine(o, now ?? serverNow, now !== null);
  const dot =
    o.status === 'watching' ? (l.busy ? 'bg-accent animate-pulse' : 'dot-green')
    : o.status === 'getting_ready' ? 'bg-fg-3 animate-pulse'
    : o.status === 'stopped_today' ? 'bg-accent'
    : 'bg-fg-3';
  return (
    <dl
      data-agent-live=""
      aria-label={L.label}
      className="m-0 mt-4 grid gap-x-6 gap-y-2 border-t border-[var(--raised-line)] pt-3.5 text-sm sm:grid-cols-[minmax(0,1.3fr)_minmax(0,1fr)_minmax(0,1fr)]"
    >
      <div data-live="now" className="flex min-w-0 items-baseline justify-between gap-3 sm:block">
        <dt className="shrink-0 text-[12.5px] text-fg-3">{L.now}</dt>
        <dd className="m-0 flex min-w-0 items-center justify-end gap-2 text-fg sm:mt-0.5 sm:justify-start">
          <span aria-hidden="true" className={`inline-block h-2 w-2 shrink-0 rounded-full ${dot}`} />
          <span className="min-w-0">{l.now}</span>
        </dd>
      </div>
      <div data-live="next" className="flex min-w-0 items-baseline justify-between gap-3 sm:block">
        <dt className="shrink-0 text-[12.5px] text-fg-3">{L.next}</dt>
        <dd className="m-0 min-w-0 text-right text-fg tabular-nums sm:mt-0.5 sm:text-left">
          {l.at ? <span className="font-medium">{l.at}</span> : null}
          {l.at ? <span className="text-fg-2"> · </span> : null}
          <span className={l.at ? 'text-fg-2' : ''}>{l.next}</span>
        </dd>
      </div>
      <div data-live="last" className="flex min-w-0 items-baseline justify-between gap-3 sm:block">
        <dt className="shrink-0 text-[12.5px] text-fg-3">{L.last}</dt>
        <dd className="m-0 min-w-0 text-right text-fg sm:mt-0.5 sm:text-left">{l.last}</dd>
      </div>
    </dl>
  );
}
