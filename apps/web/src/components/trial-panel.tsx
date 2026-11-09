'use client';
import { useEffect, useRef, type ReactNode } from 'react';
import { SignInCard } from '@/components/sign-in';
import { Button } from '@/components/ui/button';
import { copy } from '@/copy';
import { plainText } from '@/lib/draft-display';
import type { DraftData, TrialData } from '@/lib/draft-types';
import type { TrialState } from '@/lib/draft-state';
import { readingCells } from '@/lib/reading-cells';
import { stepWords } from '@/lib/run-words';
import { scrollIntoViewIfNeeded } from '@/lib/scroll';
import { SealLoader } from '@/components/seal-loader';

const T = copy.draft.trial;

/** The api's words when the plain-language filter hid them: shown only inside Advanced, under the plain line. */
function Original({ text }: { text: string }) {
  return (
    <details data-advanced="" className="mt-2 rounded-lg border border-line p-2 text-sm">
      <summary className="cursor-pointer text-fg-3">{copy.advanced.title}</summary>
      <p className="mt-1 text-xs text-fg-3">{copy.advanced.trialOriginal}</p>
      <p className="whitespace-pre-wrap break-words">{text}</p>
    </details>
  );
}

/** One line of what the agent would have done. The api's free text is shown only if it is plain; otherwise the line stands alone. */
function WouldHaveLine({ kind, summary }: { kind: TrialData['wouldHave'][number]['kind']; summary: string }) {
  const shown = plainText(summary);
  return (
    <li className="py-1.5 text-[15px]">
      <span className="font-medium">{T[kind]}</span>
      {shown ? <span className="break-words text-fg-2">{`: ${shown}`}</span> : summary.trim() !== '' ? <Original text={summary} /> : null}
    </li>
  );
}

/** What the held condition means, in one line, then (when the check left a reading) the plain line and the small grid. */
function Verdict({ condition, draft }: { condition: TrialData['condition']; draft?: DraftData | null | undefined }) {
  if (!condition) return <p className="mt-2 text-lg font-semibold tracking-[-0.01em]">{T.ran}</p>;
  const main = condition.held === false ? T.quiet : condition.held === true ? T.attention : T.unknown;
  const line = condition.line ? plainText(condition.line) : null;
  const cells = readingCells(condition.reading, draft);
  return (
    <>
      <p className="mt-2 flex items-start gap-2.5 text-lg font-semibold tracking-[-0.01em]">
        {condition.held === false ? <span data-dot="green" aria-hidden="true" className="dot-green mt-[0.5em] size-2.5 shrink-0 rounded-full" /> : null}
        <span className="min-w-0">
          {main}
          {line ? <small data-reading-line="" className="mt-1 block break-words text-sm font-normal text-fg-2">{line}</small> : null}
        </span>
      </p>
      {cells.length > 0 ? (
        <div data-readings="" className="mt-3 grid grid-cols-3 gap-2">
          {cells.map((c) => (
            <div key={c.label} className="min-w-0 rounded-xl border border-line px-3 py-2">
              <small className="block text-xs text-fg-3">{c.label}</small>
              <strong className="block break-words text-[15px] font-semibold">{c.value}</strong>
            </div>
          ))}
        </div>
      ) : null}
    </>
  );
}

/** The agent's message as the email it would send. A message the plain-words filter hid is replaced by a plain line. */
function Mail({ text, ifItHappens }: { text: string; ifItHappens: boolean }) {
  const sent = plainText(text);
  return (
    <div data-mail="" className="mt-4 overflow-hidden rounded-xl border border-line">
      <div className="flex flex-wrap items-center justify-between gap-x-3 gap-y-1 border-b border-line px-3.5 py-2.5">
        <span className="text-[13px] font-semibold">{ifItHappens ? T.mailIf : T.mailNow}</span>
        <span className="eyebrow text-fg-3">{T.preview}</span>
      </div>
      <div className="px-3.5 py-3 text-[15px]">
        <p className="whitespace-pre-wrap break-words">{text.trim() === '' ? T.empty : (sent ?? T.hidden)}</p>
        {text.trim() !== '' && sent === null ? <Original text={text} /> : null}
      </div>
    </div>
  );
}

export function TrialResult({ result, draft }: { result: TrialData; draft?: DraftData | null | undefined }) {
  const done = result.status === 'done';
  return (
    <>
      <p className="eyebrow">{T.title}</p>
      {done ? (
        <>
          <Verdict condition={result.condition} draft={draft} />
          <Mail text={result.text} ifItHappens={result.condition !== null} />
        </>
      ) : (
        // The run did not finish (an error, or the trial budget ran out): never "Nothing to send", which would read as a quiet success.
        <p role="status" data-trial-unfinished="" className="mt-2 text-lg font-semibold tracking-[-0.01em]">
          {T.failed}
        </p>
      )}
      {done ? (
      <>
      <div className="mt-5 border-t border-line pt-4">
        <p className="eyebrow">{T.howTitle}</p>
        <ol className="mt-2 list-decimal pl-5 marker:text-fg-3">
          {result.steps.map((s, i) => (
            <li key={`s${i}`} className="py-1.5 text-[15px]">
              {stepWords(s.tools, { trial: true })}
            </li>
          ))}
          {result.wouldHave.map((w, i) => (
            <WouldHaveLine key={`w${i}`} kind={w.kind} summary={w.summary} />
          ))}
          <li className="py-1.5 text-[15px] text-fg-2">{T.nothingSent}</li>
        </ol>
      </div>
      <p className="mt-3 text-sm text-fg-2">{copy.draft.tryNote}</p>
      </>
      ) : null}
    </>
  );
}

function Region({ status, children }: { status: string; children: ReactNode }) {
  return (
    <div data-trial={status} className="mt-6 border-t border-line pt-5">
      {children}
    </div>
  );
}

/** The trial's own area under the buttons: progress, the result, the sign-in card past the limit, or a plain failure. */
export function TrialPanel({ trial, draft, onRetry }: { trial: TrialState; draft?: DraftData | null; onRetry?: (() => void) | undefined }) {
  const ref = useRef<HTMLDivElement>(null);
  const { status } = trial;
  // Pressing Try changes something below the fold: bring it into view when it starts and again when the result lands.
  useEffect(() => {
    if ((status === 'running' || status === 'done') && ref.current) scrollIntoViewIfNeeded(ref.current, window, document.querySelector<HTMLElement>('[data-sticky]')?.offsetHeight ?? 0);
  }, [status]);
  if (status === 'idle') return null;
  const inner = (() => {
    if (status === 'running')
      return (
        <>
          <p role="status" className="flex items-center gap-2.5 text-[15px] text-fg-2">
            <SealLoader size={18} className="text-accent" />
            {copy.draft.trying}
          </p>
          <div data-progress="" className="progress mt-4" aria-hidden="true">
            <i />
          </div>
        </>
      );
    if (status === 'done' && trial.result) return <TrialResult result={trial.result} draft={draft} />;
    if (status === 'limit')
      return (
        <>
          <p className="headline text-xl">{copy.draft.signInToKeepDrafting}</p>
          <p className="mb-3 mt-1 text-sm text-fg-2">{copy.draft.limitNote}</p>
          <SignInCard {...(draft ? { draft } : {})} />
        </>
      );
    if (status === 'failed')
      return (
        <>
          <p role="alert" className="text-[15px] text-danger">
            {trial.message ?? copy.errors.generic}
          </p>
          <Button type="button" variant="quiet" size="lg" className="mt-3" onClick={onRetry}>
            {copy.draft.tryAgain}
          </Button>
        </>
      );
    return null;
  })();
  if (!inner) return null;
  return (
    <div ref={ref} className="scroll-mt-24">
      <Region status={status}>{inner}</Region>
    </div>
  );
}
