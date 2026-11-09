import { copy } from '@/copy';

const ORDER = ['describe', 'try', 'create'] as const;
export type FlowStep = (typeof ORDER)[number];

/** Where the visitor is: Describe, Try, Create. Steps before `at` are done; the one at `at` is now. */
export function FlowSteps({ at }: { at: FlowStep }) {
  const here = ORDER.indexOf(at);
  // Past the last step ("create") everything before it is done, and it stays the current one.
  return (
    <ol aria-label={copy.steps.label} className="mb-4 mt-2 flex list-none flex-wrap items-center gap-1.5 p-0 text-[13px] text-fg-2">
      {ORDER.map((id, i) => {
        const state = i < here ? 'done' : i === here ? 'now' : 'next';
        return (
          <li key={id} className="flex items-center gap-1.5">
            {i > 0 ? <span aria-hidden="true" className="h-px w-5 bg-line" /> : null}
            <span
              data-step={id}
              data-state={state}
              {...(state === 'now' ? { 'aria-current': 'step' as const } : {})}
              className={`inline-flex items-center gap-[7px] whitespace-nowrap ${state === 'now' ? 'font-semibold text-fg' : ''}`}
            >
              <i
                aria-hidden="true"
                className={`grid size-5 place-items-center rounded-full border text-[11px] font-semibold not-italic ${
                  state === 'done' ? 'border-fg bg-fg text-bg' : state === 'now' ? 'border-fg bg-white' : 'border-line bg-white'
                }`}
              >
                {state === 'done' ? '✓' : i + 1}
              </i>
              {copy.steps[id]}
              {state === 'done' ? <span className="sr-only">{copy.steps.done}</span> : null}
            </span>
          </li>
        );
      })}
    </ol>
  );
}
