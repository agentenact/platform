'use client';
import { useState } from 'react';
import { setMorningNoteAction } from '@/app/actions/agent';
import { Button } from '@/components/ui/button';
import { copy } from '@/copy';
import { runMorningNote, type SaveMorningNote } from '@/lib/morning-note';

const T = copy.morningNote;

/** What the question shows. `answer` null = not asked yet; asked once, then a quiet line with the way to change it. */
export function MorningNoteView({ answer, busy, message, onChoose }: { answer: boolean | null; busy: boolean; message: string | null; onChoose: (on: boolean) => void }) {
  return (
    <div data-morning-note={answer === null ? 'ask' : answer ? 'on' : 'off'} className="mt-4 border-t border-line pt-4">
      {answer === null ? (
        <>
          <p className="text-[15px] font-medium">{T.ask}</p>
          <p className="mt-1 text-sm text-fg-2">{T.hint}</p>
          <div className="mt-3 flex flex-wrap gap-2">
            <Button type="button" variant="quiet" disabled={busy} onClick={() => onChoose(true)}>
              {T.yes}
            </Button>
            <Button type="button" variant="ghost" disabled={busy} onClick={() => onChoose(false)}>
              {T.no}
            </Button>
          </div>
        </>
      ) : (
        <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-1">
          <p className="min-w-0 text-sm text-fg-2">{answer ? T.on : T.off}</p>
          <Button type="button" variant="ghost" disabled={busy} onClick={() => onChoose(!answer)}>
            {answer ? T.turnOff : T.turnOn}
          </Button>
        </div>
      )}
      {message ? (
        <p role="alert" className="mt-2 text-sm text-danger">
          {message}
        </p>
      ) : null}
    </div>
  );
}

/** The question for one agent. The answer changes only after the server has stored it. `save` is for tests; the page uses the server action. */
export function MorningNote({ agentId, answer, save }: { agentId: string; answer: boolean | null; save?: SaveMorningNote }) {
  const [s, setS] = useState({ answer, busy: false, message: null as string | null });
  const go = save ?? ((on: boolean) => setMorningNoteAction(agentId, on));
  return (
    <MorningNoteView
      answer={s.answer}
      busy={s.busy}
      message={s.message}
      onChoose={(on) => {
        setS({ ...s, busy: true, message: null });
        void runMorningNote(s, on, go).then(setS);
      }}
    />
  );
}
