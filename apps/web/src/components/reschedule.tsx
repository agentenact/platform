'use client';
import { Popover as P } from 'radix-ui';
import { useState } from 'react';
import { rescheduleAction } from '@/app/actions/agent-edit';
import { TimeEditor, timeFrom } from '@/components/draft-sentence';
import { Button } from '@/components/ui/button';
import { copy } from '@/copy';
import { clockText, parseTime } from '@/lib/draft-display';
import type { DraftData, TimeParam } from '@/lib/draft-types';
import { timeParams, type RescheduleOut } from '@/lib/reschedule';
import { localTimeZone } from '@/lib/time-zone';

const S = copy.agent.reschedule;

export type RunReschedule = (param: string, value: string) => Promise<RescheduleOut>;

/** What a time editor starts with: the clock ("18:00"), and the weekday for a weekly time ("08:00 1"). */
const startOf = (p: TimeParam): string => {
  const t = parseTime(p.value);
  return t ? (t.weekday === null ? clockText(t) : `${clockText(t)} ${t.weekday}`) : '';
};

/**
 * Reschedule, beside Run now in the agent's header: the same time list as "What it does", in a small sheet under the
 * button. A pick saves at once, with no second "Save" step: the new time is stored and approved, the sheet closes, and the
 * header's Next check moves to it. Only for agents that run on a clock. `run` is for tests; the page uses the server action.
 */
export function Reschedule({ agentId, draft, run }: { agentId: string; draft: DraftData; run?: RunReschedule }) {
  const params = timeParams(draft);
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [raw, setRaw] = useState<Record<string, string>>({});
  if (params.length === 0) return null;
  const go: RunReschedule = run ?? ((param, value) => rescheduleAction(agentId, param, value, localTimeZone()));

  const commit = async (p: TimeParam, value: string) => {
    if (value === p.value) return setOpen(false);
    setBusy(true);
    setMessage(null);
    const out = await go(p.id, value).catch((): RescheduleOut => ({ ok: false, message: S.failed }));
    setBusy(false);
    if (out.ok) setOpen(false);
    else setMessage(out.message);
  };

  return (
    <P.Root
      open={open}
      onOpenChange={(o) => {
        if (busy) return;
        setOpen(o);
        setMessage(null);
        if (o) setRaw(Object.fromEntries(params.map((p) => [p.id, startOf(p)])));
      }}
    >
      <P.Trigger asChild>
        <Button type="button" variant="quiet" data-reschedule="">
          <ClockGlyph />
          {S.label}
        </Button>
      </P.Trigger>
      <P.Portal>
        <P.Content
          align="end"
          sideOffset={8}
          collisionPadding={16}
          data-reschedule-sheet=""
          className="fade-in z-50 flex w-[min(24rem,calc(100vw-32px))] flex-col gap-4 rounded-2xl border border-line bg-white p-4 text-fg shadow-[0_24px_48px_-24px_rgb(0_0_0/0.8)]"
        >
          {params.map((p) => (
            <form
              key={p.id}
              noValidate
              onSubmit={(e) => {
                e.preventDefault();
                const v = timeFrom(raw[p.id] ?? '', p);
                if (v === null) return setMessage(copy.draft.notATime);
                void commit(p, v);
              }}
            >
              <TimeEditor param={p} draft={draft} raw={raw[p.id] ?? ''} setRaw={(v) => setRaw((r) => ({ ...r, [p.id]: v }))} busy={busy} commit={(v) => void commit(p, v)} />
            </form>
          ))}
          {busy ? (
            <p role="status" className="text-sm text-fg-2">
              {S.saving}
            </p>
          ) : message ? (
            <p role="alert" className="text-sm text-danger">
              {message}
            </p>
          ) : null}
        </P.Content>
      </P.Portal>
    </P.Root>
  );
}

function ClockGlyph() {
  return (
    <svg aria-hidden="true" viewBox="0 0 16 16" className="size-4" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
      <circle cx="8" cy="8" r="6.25" />
      <path d="M8 4.75V8l2.25 1.5" />
    </svg>
  );
}
