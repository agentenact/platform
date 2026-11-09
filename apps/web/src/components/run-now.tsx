'use client';
import { useState } from 'react';
import { resumeAndRunAction, runNowAction } from '@/app/actions/agent';
import { wallClock } from '@/components/agent-live';
import { AppLink } from '@/components/app-link';
import { Button } from '@/components/ui/button';
import { copy } from '@/copy';
import { agentHref } from '@/lib/agent-href';
import type { LastRun, RunNowOut } from '@/lib/agent-types';
import { scrollIntoViewIfNeeded } from '@/lib/scroll';

const R = copy.agent.run;

export type RunNow = () => Promise<RunNowOut>;

/** What one press led to: running (the header takes over), or one plain line. `at` formats a time in the viewer's zone. */
export function runNowNote(out: RunNowOut, at: (t: number) => string): { running: boolean; note: string | null; error: boolean } {
  if (out.ok && out.state !== 'cooling_down') return { running: true, note: null, error: false };
  if (out.ok) return { running: false, note: R.cooling(at(Date.parse(out.until))), error: false };
  const code = out.code;
  if (code === 'agent_paused') return { running: false, note: R.paused, error: true };
  if (code === 'not_resumed') return { running: false, note: R.notResumed, error: true };
  if (code === 'daily_limit') return { running: false, note: R.spent, error: true };
  if (code === 'rate_limited') return { running: false, note: R.tooMany, error: true };
  if (code === 'no_checks') return { running: false, note: R.noChecks, error: true };
  return { running: false, note: R.failed, error: true };
}

/**
 * Opens the run's row in the Activity feed when it is on screen (scrolls to it, expands it) and says so; false when it is
 * not there (another tab is open, or the feed has not caught up), and the link then goes to the `?run=` address instead.
 */
export function openRunRow(runId: string, doc: Pick<Document, 'querySelector'> = document): boolean {
  const row = doc.querySelector<HTMLElement>(`[data-run-id="${runId}"]`);
  if (!row || row.offsetParent === null) return false;
  const button = row.querySelector<HTMLButtonElement>('button[aria-expanded]');
  if (button?.getAttribute('aria-expanded') === 'false') button.click();
  scrollIntoViewIfNeeded(row, window, document.querySelector<HTMLElement>('[data-sticky]')?.offsetHeight ?? 0);
  return true;
}

/**
 * Run now. One press asks the api to move the next check to now; the scheduler starts it within half a minute. While it
 * is due or running (`running`, from the overview) the button says so and cannot be pressed again. When the overview says
 * the run this press started has ended, the button comes back with one line under it: done (or not) and a link that opens
 * that run's row in the feed. `run` is for tests; the page uses the server action.
 */
export function RunNowButton({ agentId, running, lastRun = null, paused = false, run }: { agentId: string; running: boolean; lastRun?: LastRun | null; paused?: boolean; run?: RunNow }) {
  const [busy, setBusy] = useState(false);
  const [asked, setAsked] = useState(false);
  const [finished, setFinished] = useState(false);
  const [note, setNote] = useState<{ text: string; error: boolean } | null>(null);
  // The press is answered before the page re-reads; from then on the overview decides. The end of a run this press asked
  // for turns into the result line; an end the page only watched (a scheduled run) changes nothing here.
  const [seen, setSeen] = useState(running);
  if (seen !== running) {
    setSeen(running);
    if (!running && asked) {
      setAsked(false);
      setFinished(true);
    }
  }
  // Paused: the press resumes the agent first (a paused agent runs nothing, down to the vault), then runs it.
  const go = run ?? (() => (paused ? resumeAndRunAction(agentId) : runNowAction(agentId)));
  const on = running || asked;
  const result = finished && !on && lastRun ? lastRun : null;
  return (
    <div className="col-span-2 flex flex-col items-stretch gap-1 sm:col-span-1 sm:items-end">
      <Button
        type="button"
        data-run-now={on ? 'running' : paused ? 'paused' : 'idle'}
        busy={busy || on}
        onClick={() => {
          setBusy(true);
          setNote(null);
          setFinished(false);
          void go()
            .catch((): RunNowOut => ({ ok: false, status: 503 }))
            .then((out) => {
              const r = runNowNote(out, (t) => wallClock(t, Date.now()));
              setAsked(r.running);
              setNote(r.note ? { text: r.note, error: r.error } : null);
              setBusy(false);
            });
        }}
      >
        {on || busy ? null : <PlayGlyph />}
        {busy ? R.starting : on ? R.running : paused ? R.resumeAndRun : R.label}
      </Button>
      {result ? (
        <p role="status" data-run-result={result.ok ? 'done' : 'failed'} className="text-sm sm:text-right">
          <span className={result.ok ? 'text-fg-2' : 'text-danger'}>{result.ok ? R.done : R.notDone}</span>{' '}
          <AppLink
            href={agentHref(agentId, 'activity', { run: result.runId })}
            onClick={(e) => {
              if (openRunRow(result.runId)) e.preventDefault();
            }}
            className="font-medium text-fg underline underline-offset-4 hover:text-accent-ink"
          >
            {result.ok ? R.see : R.seeWhy}
          </AppLink>
        </p>
      ) : note ? (
        <p role={note.error ? 'alert' : 'status'} className={`max-w-[18rem] text-sm sm:text-right ${note.error ? 'text-danger' : 'text-fg-2'}`}>
          {note.text}
        </p>
      ) : null}
    </div>
  );
}

function PlayGlyph() {
  return (
    <svg aria-hidden="true" viewBox="0 0 16 16" className="size-3.5" fill="currentColor">
      <path d="M4.5 2.9v10.2a.6.6 0 0 0 .92.5l7.9-5.1a.6.6 0 0 0 0-1L5.42 2.4a.6.6 0 0 0-.92.5z" />
    </svg>
  );
}
