'use client';
import { useEffect, useState } from 'react';
import { liveRunAction } from '@/app/actions/agent';
import { Markdown } from '@/components/markdown';
import { copy } from '@/copy';
import type { LiveRun } from '@/lib/agent-types';
import { plainText } from '@/lib/draft-display';

const P = copy.agent.progress;

export type ReadLive = () => Promise<LiveRun | null>;

/** How often the panel asks while the page is visible, and while it is not. */
export const LIVE_POLL_MS = 1200;
const HIDDEN_POLL_MS = 6000;

/** "0:42", "3:05": minutes and seconds since the run was picked up. */
export function elapsedText(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}

/** The headline for a phase. */
export function phaseText(l: LiveRun): string {
  if (l.phase === 'queued') return P.queued;
  if (l.phase === 'starting') return P.starting;
  if (l.phase === 'finishing') return P.finishing;
  if (l.phase === 'idle') return P.done;
  return l.text.trim() ? P.writing : P.working;
}

/**
 * While a check is due or running: what it is doing, live. A line per thing it did (searched, read a page, emailed you),
 * then the words it is writing as they come, formatted, with older lines fading out at the top. It asks the api about once
 * a second while the page is visible; when the run is over the page is rendered again (the action does that), and this
 * panel goes away with the header's "Checking now". `read` and `initial` are for tests.
 */
export function RunProgress({ agentId, read, initial = null }: { agentId: string; read?: ReadLive; initial?: LiveRun | null }) {
  const [live, setLive] = useState<LiveRun | null>(initial);
  const [now, setNow] = useState<number | null>(null);

  useEffect(() => {
    const go = read ?? (() => liveRunAction(agentId));
    let stopped = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const tick = async () => {
      const out = await go().catch(() => null);
      if (stopped) return;
      if (out) setLive(out);
      if (out?.phase === 'idle') return;
      timer = setTimeout(tick, document.visibilityState === 'visible' ? LIVE_POLL_MS : HIDDEN_POLL_MS);
    };
    void tick();
    return () => {
      stopped = true;
      clearTimeout(timer);
    };
  }, [agentId, read]);

  useEffect(() => {
    setNow(Date.now());
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, []);

  const l = live ?? { phase: 'queued' as const, since: null, lines: [], text: '' };
  const since = l.since ? Date.parse(l.since) : NaN;
  const lines = l.lines.map((x) => plainText(x)).filter((x): x is string => !!x);
  const text = l.text.trim();
  return (
    <section data-run-progress={l.phase} aria-label={P.label} className="mt-4 rounded-[14px] border border-line bg-white p-4 text-sm">
      <div className="flex items-baseline justify-between gap-3">
        <p role="status" className="flex items-center gap-2 font-medium text-fg">
          <span aria-hidden="true" className="soft inline-block size-2 shrink-0 rounded-full bg-accent" />
          {phaseText(l)}
        </p>
        {now !== null && Number.isFinite(since) ? <span className="shrink-0 font-mono text-xs tabular-nums text-fg-3">{P.elapsed(elapsedText(now - since))}</span> : null}
      </div>
      {lines.length > 0 ? (
        <ol className="mt-3 flex flex-col gap-1 text-fg-2">
          {lines.map((x, i) => (
            <li key={`${i}-${x}`} className="fade-in flex gap-2">
              <span aria-hidden="true" className="text-fg-3">
                ✓
              </span>
              <span className="min-w-0 break-words">{x}</span>
            </li>
          ))}
        </ol>
      ) : null}
      {text ? (
        <div aria-hidden="true" className="mt-3 flex max-h-56 flex-col justify-end overflow-hidden border-t border-line pt-3 text-fg-2 [mask-image:linear-gradient(to_bottom,transparent,black_3rem)]">
          <Markdown text={text} />
        </div>
      ) : null}
    </section>
  );
}
