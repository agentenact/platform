import { ReadingCells } from '@/components/reading-cells';
import { StepRing } from '@/components/step-ring';
import { copy } from '@/copy';
import { ago } from '@/lib/agent-format';
import type { Moment } from '@/lib/agent-moment';
import type { Overview } from '@/lib/agent-types';
import type { DraftData } from '@/lib/draft-types';
import { readingCells, readingLine } from '@/lib/reading-cells';

const T = copy.firstCheck;

/**
 * The first minute on the agent page. While the first check has not landed it says, in plain words, that the agent is checking
 * now; a check that could not finish says so and never reads as a success. When it lands it shows only what that check really
 * read (the newest row of the agent's own check log), in the same cells the draft's try uses.
 */
export function FirstCheck({ o, now, moment, draft }: { o: Overview; now: number; moment: Extract<Moment, 'waiting' | 'failed' | 'first'>; draft?: DraftData | null }) {
  const c = o.latestCheck;
  if (moment !== 'first' || !c) {
    const failed = moment === 'failed';
    return (
      <section data-first-check={moment} data-card="" className="card fade-in mb-4" aria-live="polite">
        <div className="flex items-start gap-3.5">
          <StepRing state="working" n={1} />
          <div className="min-w-0">
            <p className="eyebrow">{T.eyebrow}</p>
            <p className="mt-1 text-lg font-semibold tracking-[-0.01em]">{failed ? T.failed : T.looking}</p>
            {failed ? null : <p className="mt-1 text-sm text-fg-2">{T.wait}</p>}
          </div>
        </div>
      </section>
    );
  }
  const line = readingLine(c.reading, draft);
  return (
    <section data-first-check="first" data-card="" className="card fade-in mb-4">
      <div className="flex items-start gap-3.5">
        <StepRing state="done" n={1} />
        <div className="min-w-0">
          <p className="eyebrow">{T.when(ago(c.at, now))}</p>
          <p className="mt-1 text-lg font-semibold tracking-[-0.01em]">{c.held === true ? T.attention : T.quiet}</p>
          {line ? <p data-reading-line="" className="mt-1 break-words text-sm text-fg-2">{line}</p> : null}
        </div>
      </div>
      <ReadingCells cells={readingCells(c.reading, draft)} />
    </section>
  );
}
