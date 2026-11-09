'use client';
import { useId, useState } from 'react';
import { copy } from '@/copy';
import type { SpecPatch } from '@/lib/draft-state';
import type { DraftData } from '@/lib/draft-types';

const area = 'mt-1 min-h-28 w-full rounded-lg border border-line bg-white p-2 font-mono text-sm';

/**
 * The raw words behind the draft, opened by a plain "Edit the details" button. The region stays in the page while closed
 * (hidden), so closing it never drops an edit; everything technical in it sits inside data-advanced.
 * Edits stay in the browser: the api checks the whole draft again when the agent is created.
 */
export function Advanced({ draft, onChange, readOnly = false, note }: { draft: DraftData; onChange?: (patch: SpecPatch) => void; readOnly?: boolean; note?: string }) {
  const a = copy.advanced;
  const [open, setOpen] = useState(false);
  const id = useId();
  return (
    <div className="mt-3 px-1">
      <button
        type="button"
        aria-expanded={open}
        aria-controls={id}
        onClick={() => setOpen(!open)}
        className="inline-flex min-h-11 items-center gap-1.5 text-sm text-fg-2 underline decoration-line underline-offset-4 hover:text-fg"
      >
        {copy.draft.editDetails}
        <span aria-hidden="true" className={`inline-block text-xs transition-transform duration-150 ${open ? 'rotate-180' : ''}`}>
          ▾
        </span>
      </button>
      <div id={id} data-advanced="" hidden={!open} className="mt-2 rounded-[14px] border border-line bg-white p-4">
        {note ? <p className="mb-3 text-xs text-fg-3">{note}</p> : null}
        <div className="flex flex-col gap-4">
          <label className="block text-sm">
            {a.persona}
            <textarea className={area} readOnly={readOnly || !onChange} value={draft.spec.persona} onChange={(e) => onChange?.({ persona: e.target.value })} />
          </label>
          <label className="block text-sm">
            {a.systemPrompt}
            <textarea className={`${area} min-h-48`} readOnly={readOnly || !onChange} value={draft.spec.system_prompt} onChange={(e) => onChange?.({ system_prompt: e.target.value })} />
          </label>
          {draft.spec.skills.map((s, i) => (
            <label key={`${s.name}-${i}`} className="block text-sm">
              {a.skillBody(s.name)}
              <textarea className={area} readOnly={readOnly || !onChange} value={s.body} onChange={(e) => onChange?.({ skill: i, body: e.target.value })} />
            </label>
          ))}
        </div>
      </div>
    </div>
  );
}
