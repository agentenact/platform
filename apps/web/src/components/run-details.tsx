import { copy } from '@/copy';
import { formatUsdc, safeUrl } from '@/lib/agent-format';
import type { CallDetail, RunDetail, RunStep } from '@/lib/agent-types';
import { durationWords, shortId, txUrl, utcWords } from '@/lib/run-details';
import { plainText } from '@/lib/draft-display';
import { stepWords } from '@/lib/run-words';
import { Loading } from '@/components/seal-loader';
import { Markdown } from '@/components/markdown';

export type RunState = { kind: 'loading' } | { kind: 'error' } | { kind: 'ready'; run: RunDetail };

const isZero = (v: string) => /^0*\.?0*$/.test(v);
const a = copy.advanced.run;
const link = 'underline underline-offset-2';

/** Loading, failed or the details. Plain words only; the failed state offers a retry. */
export function RunPanel({ state, proofUrl, problem, onRetry }: { state: RunState; proofUrl?: string; problem?: boolean; onRetry?: () => void }) {
  if (state.kind === 'loading')
    return (
      <p className="py-2 text-sm text-fg-2">
        <Loading label={copy.runDetails.loading} />
      </p>
    );
  if (state.kind === 'error')
    return (
      <div role="alert" className="py-2 text-sm text-danger">
        <p>{copy.runDetails.failed}</p>
        {onRetry ? (
          <button type="button" onClick={onRetry} className="inline-flex min-h-11 items-center underline underline-offset-4">
            {copy.runDetails.retry}
          </button>
        ) : null}
      </div>
    );
  return <RunDetails run={state.run} {...(proofUrl ? { proofUrl } : {})} {...(problem ? { problem } : {})} />;
}

/**
 * What one run did (mockups H and H2). The plain part is a line per step, the run's message, how long it took and what it
 * cost; a sale also says what it earned and links its proof. The table of everything else sits in a collapsed
 * data-advanced region.
 */
export function RunDetails({ run, proofUrl, problem }: { run: RunDetail; proofUrl?: string; problem?: boolean }) {
  const t = copy.runDetails;
  const proof = safeUrl(proofUrl);
  // The agent's answer, formatted: the whole of it when the api kept it, else the 400-character summary. Plain words only
  // (spec §5): an answer with a technical word falls back to the summary, then to nothing (Technical details holds it).
  const answerShown = problem ? null : ((run.result ? plainText(run.result) : null) ?? (run.summary ? plainText(run.summary) : null));
  return (
    <div className="flex flex-col gap-3 py-3 text-sm">
      {problem ? <p className="text-fg-2">{t.problem}</p> : null}
      {answerShown ? <Markdown text={answerShown} className="text-[15px] leading-relaxed text-fg" /> : null}
      {run.steps.length > 0 ? (
        <ol className={`flex flex-col gap-1 text-fg-2 ${answerShown ? 'border-t border-line pt-3' : ''}`}>
          {run.steps.flatMap((s) =>
            stepLines(s).map(({ line, detail }, i) => (
              <li key={`${s.n}-${i}`}>{detail ? <StepDetail line={line} detail={detail} /> : line}</li>
            )),
          )}
        </ol>
      ) : problem ? null : (
        <p className="text-fg-2">{t.noSteps}</p>
      )}
      <p className="text-fg-2">
        {durationWords(run.startedAt, run.endedAt)} · {isZero(run.usdcSpent) ? t.spentNothing : t.spent(formatUsdc(run.usdcSpent))}
      </p>
      {!isZero(run.usdcEarned) ? (
        <p className="font-medium text-proven">
          {t.earned(formatUsdc(run.usdcEarned))}
          {proof ? (
            <>
              {' · '}
              <a href={proof} target="_blank" rel="noopener noreferrer" className={link}>
                {t.proof}
              </a>
            </>
          ) : null}
        </p>
      ) : null}
      <Technical run={run} />
    </div>
  );
}

/** The plain lines of one step: the api's line per call (when it is plain), else the words for that call's tool; older runs have only the tools. */
function stepLines(s: RunStep): { line: string; detail?: CallDetail }[] {
  if (!s.calls || s.calls.length === 0) return [{ line: stepWords(s.tools) }];
  return s.calls.map((c) => ({
    line: c.tool === 'more' ? copy.runDetails.more : ((c.line ? plainText(c.line) : null) ?? stepWords([c.tool])),
    ...(c.detail ? { detail: c.detail } : {}),
  }));
}

const D = copy.runDetails.detail;

/**
 * One step that has more to show: the line opens what the call was about (the search and what it found, the page, the
 * email it wrote, the note it kept). The owner's own run, so the agent's words are shown as written; links go only to https.
 */
function StepDetail({ line, detail: d }: { line: string; detail: CallDetail }) {
  return (
    <details data-step-detail="" className="group">
      <summary className="-mx-1 inline-flex min-h-8 cursor-pointer list-none items-center gap-1.5 rounded-md px-1 hover:text-fg [&::-webkit-details-marker]:hidden">
        <span className="min-w-0 break-words">{line}</span>
        <svg aria-hidden="true" viewBox="0 0 16 16" className="size-3.5 shrink-0 text-fg-3 transition-transform group-open:rotate-90" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round">
          <path d="M6 4l4 4-4 4" />
        </svg>
        <span className="sr-only">{D.show}</span>
      </summary>
      <dl className="mb-2 mt-1 flex flex-col gap-2 border-l border-line pl-3 text-[13px]">
        {d.query ? <Field k={D.query}>{d.query}</Field> : null}
        {d.results ? (
          <Field k={D.results}>
            <ul className="flex flex-col gap-0.5">
              {d.results.map((h, i) => (
                <li key={i} className="break-words">
                  <Out url={h.url}>{h.title || hostOf(h.url)}</Out>
                </li>
              ))}
            </ul>
          </Field>
        ) : null}
        {d.url ? (
          <Field k={D.url}>
            <Out url={d.url}>{d.title || d.url}</Out>
          </Field>
        ) : null}
        {d.subject ? <Field k={D.subject}>{d.subject}</Field> : null}
        {d.body ? (
          <Field k={D.body}>
            <Markdown text={d.body} />
          </Field>
        ) : null}
        {d.note ? <Field k={D.note}>{d.note}</Field> : null}
        {d.code ? (
          <Field k={D.code}>
            <pre className="overflow-x-auto whitespace-pre-wrap break-words font-mono text-xs">{d.code}</pre>
          </Field>
        ) : null}
        {d.input ? (
          <Field k={D.input}>
            <span className="break-all font-mono text-xs">{d.input}</span>
          </Field>
        ) : null}
      </dl>
    </details>
  );
}

function Field({ k, children }: { k: string; children: React.ReactNode }) {
  return (
    <div className="min-w-0">
      <dt className="text-xs text-fg-3">{k}</dt>
      <dd className="m-0 mt-0.5 min-w-0 break-words text-fg">{children}</dd>
    </div>
  );
}

const hostOf = (u: string): string => {
  try {
    return new URL(u).hostname;
  } catch {
    return u;
  }
};

/** A link out, https only; anything else is plain text. */
function Out({ url, children }: { url: string; children: React.ReactNode }) {
  const href = safeUrl(url);
  return href ? (
    <a href={href} target="_blank" rel="noopener noreferrer nofollow" className={link} title={href}>
      {children}
    </a>
  ) : (
    <span>{children}</span>
  );
}

function startedBy(run: RunDetail): string {
  if (run.triggerId) return a.byTrigger(shortId(run.triggerId));
  if (run.serviceId) return a.byService(shortId(run.serviceId));
  return run.mode === 'chat' ? a.byChat : a.byMission;
}

function Technical({ run }: { run: RunDetail }) {
  const tx = run.settlementTx;
  const href = txUrl(tx);
  const cache = run.cacheReadTokens + run.cacheWriteTokens;
  return (
    <details data-advanced="" className="rounded-[14px] border border-line bg-white px-3 text-fg-2">
      <summary className="flex min-h-11 cursor-pointer items-center text-sm">{a.title}</summary>
      <table className="mb-3 w-full text-left text-xs">
        <tbody className="divide-y divide-line align-top">
          <Row k={a.startedBy}>{startedBy(run)}</Row>
          <Row k={a.steps}>
            {run.steps.length === 0
              ? '—'
              : run.steps.map((s) => (
                  <span key={s.n} className="block break-words">
                    {a.step(s.n, s.tools.length ? s.tools.join(', ') : a.noTools, s.inputTokens, s.outputTokens)}
                  </span>
                ))}
          </Row>
          {run.summary ? <Row k={a.summary}>{run.summary}</Row> : null}
          {run.model ? <Row k={a.model}>{run.model}</Row> : null}
          <Row k={a.totals}>{a.total(run.steps.length, run.toolCalls, run.inputTokens, run.outputTokens, cache)}</Row>
          <Row k={a.spent}>{formatUsdc(run.usdcSpent)}</Row>
          <Row k={a.earned}>{formatUsdc(run.usdcEarned)}</Row>
          {tx ? (
            <Row k={a.tx}>
              {href ? (
                <a href={href} target="_blank" rel="noopener noreferrer" className={`${link} font-mono`}>
                  {shortId(tx, 8)}
                </a>
              ) : (
                <span className="font-mono">{shortId(tx, 8)}</span>
              )}
            </Row>
          ) : null}
          <Row k={a.status}>{run.status}</Row>
          {run.stopReason ? <Row k={a.stopReason}>{run.stopReason}</Row> : null}
          <Row k={a.began}>{utcWords(run.startedAt)}</Row>
          <Row k={a.ended}>{run.endedAt ? utcWords(run.endedAt) : a.stillRunning}</Row>
        </tbody>
      </table>
    </details>
  );
}

function Row({ k, children }: { k: string; children: React.ReactNode }) {
  return (
    <tr>
      <th scope="row" className="w-1/3 py-1.5 pr-3 font-medium text-fg-3">
        {k}
      </th>
      <td className="min-w-0 break-words py-1.5">{children}</td>
    </tr>
  );
}
