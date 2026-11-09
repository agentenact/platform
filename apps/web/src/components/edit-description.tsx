'use client';
import { useEffect, useMemo, useReducer, useRef } from 'react';
import { Advanced } from '@/components/advanced';
import { approveAction, discardAction, reviseAction, saveAction, tapAction } from '@/app/actions/agent-edit';
import { DraftSentence } from '@/components/draft-sentence';
import { Button } from '@/components/ui/button';
import { Textarea } from '@/components/ui/textarea';
import { copy } from '@/copy';
import type { DraftData, OptionValue } from '@/lib/draft-types';
import { stripParams } from '@/lib/draft-state';
import { draftWithTimeZone, localTimeZone } from '@/lib/time-zone';
import type { SpecPatch } from '@/lib/draft-state';
import { createEditController, editReducer, initialEdit, isDirty, type EditActions, type EditState, type Pending } from '@/lib/edit';

const serverActions = (agentId: string): EditActions => ({
  edit: (param, value, earlier) => tapAction(agentId, param, value, earlier),
  // A schedule saved without a zone (a new one, or one stored before zones) gets the person's own.
  save: (draft) => saveAction(agentId, draftWithTimeZone(draft, localTimeZone())),
  revise: (prompt) => reviseAction(agentId, prompt),
  approve: (version, createdAt) => approveAction(agentId, version, createdAt),
  discard: (version) => discardAction(agentId, version),
});

export interface EditHandlers {
  onEdit?: (param: string, value: OptionValue) => Promise<boolean>;
  onSave?: () => void;
  onPrompt?: (text: string) => void;
  onSpec?: (patch: SpecPatch) => void;
  onAdd?: () => void;
  onUpdate?: () => void;
  onDiscard?: () => void;
}

/** The whole screen as markup for a given state, so every state can be rendered and scanned without a browser. */
export function EditView({ state, on = {} }: { state: EditState; on?: EditHandlers }) {
  const c = copy.edit;
  const busy = state.busy !== 'none';
  const note = (from: readonly string[]) =>
    state.message && from.includes(state.messageFrom) ? (
      <p role="alert" data-edit-message="" className="mt-3 text-sm text-danger">
        {state.message}
      </p>
    ) : null;

  // A change waiting for approval replaces the editor: there is one thing to decide, and the stored sentence is not edited
  // underneath it. This card is the only place that explains the approval.
  if (state.pending) {
    return (
      <section className="card" data-pending={state.pending.version} aria-live="polite">
        <p className="eyebrow">{c.waitingTitle}</p>
        <div className="object mt-3 p-4 sm:p-5">
          <DraftSentence draft={state.pending.draft} busy />
        </div>
        <p className="mt-3 text-sm text-fg-2">{copy.draft.addNote}</p>
        <div className="mt-4 flex flex-col gap-2 sm:flex-row">
          <Button type="button" disabled={busy} busy={state.busy === 'update'} onClick={on.onUpdate} data-update="">
            {state.busy === 'update' ? c.updating : c.update}
          </Button>
          <Button type="button" variant="quiet" disabled={busy} busy={state.busy === 'discard'} onClick={on.onDiscard} data-discard="">
            {state.busy === 'discard' ? c.discarding : c.discard}
          </Button>
        </div>
        {note(['save', 'update', 'discard'])}
      </section>
    );
  }

  // One panel, one primary button. Its label follows what you did: a tapped value -> "Save changes", text typed -> "Write the
  // change". The two never coexist: unsaved taps close the box, and typed text has nothing to save.
  const dirty = isDirty(state);
  const tapped = state.edits.length > 0;
  const typed = state.prompt.trim() !== '';
  const writing = !dirty && typed;
  return (
    <section className="card" aria-live="polite">
      <p className="eyebrow">{c.title}</p>
      <div className="object mt-3 p-4 sm:p-5">
        <DraftSentence draft={state.draft} busy={busy} message={state.message && state.messageFrom === 'tap' ? state.message : undefined} {...(on.onEdit && !state.specEdited ? { onEdit: on.onEdit } : {})} />
      </div>
      {state.draft.params.length > 0 ? <p className="mt-3 text-xs text-fg-3">{state.specEdited ? c.saveFirst : copy.draft.edit}</p> : null}
      {/* The raw words the agent runs with (persona, system prompt, skills). Saved with "Save changes"; taps and these never mix. */}
      <Advanced draft={state.draft} readOnly={busy || tapped} {...(on.onSpec ? { onChange: on.onSpec } : {})} {...(tapped ? { note: c.saveFirst } : {})} />

      <div className="mt-5 border-t border-line pt-5">
        <label className="block text-sm font-semibold text-fg" htmlFor="edit-add">
          {c.changeTitle}
        </label>
        <Textarea
          id="edit-add"
          value={state.prompt}
          rows={3}
          maxLength={2000}
          placeholder={c.addPlaceholder}
          disabled={busy || dirty}
          onChange={(e) => on.onPrompt?.(e.target.value)}
          className="mt-2 text-base"
        />
        {dirty ? <p className="mt-2 text-xs text-fg-3">{c.saveFirst}</p> : null}
      </div>

      <div className="mt-5 flex flex-wrap items-center gap-3">
        {writing ? (
          <Button type="button" disabled={busy} busy={state.busy === 'revise'} onClick={on.onAdd} data-add="">
            {state.busy === 'revise' ? c.writing : c.addButton}
          </Button>
        ) : (
          <Button type="button" disabled={busy || !dirty} busy={state.busy === 'save'} onClick={on.onSave} data-save="">
            {state.busy === 'save' ? c.saving : c.save}
          </Button>
        )}
        {state.notice ? (
          <p role="status" data-edit-notice="" className="text-sm font-medium text-proven">
            {state.notice}
          </p>
        ) : null}
      </div>
      {note(['save', 'revise'])}
    </section>
  );
}

/**
 * "What it does". The stored sentence can be tapped like on the draft screen; "Save changes" stores and approves it. A new
 * request in the box below is written into a pending change that only "Update" approves. `initialPrompt` (from "Add this to
 * your agent" on the draft screen) only fills the box, and is taken off the address bar; the paid step never runs on its own.
 */
export function EditDescription({
  agentId,
  active,
  pending,
  initialPrompt = '',
  actions,
}: {
  agentId: string;
  active: { version: number; draft: DraftData } | null;
  pending: Pending | null;
  initialPrompt?: string;
  actions?: EditActions;
}) {
  const [state, dispatch] = useReducer(editReducer, undefined, () => initialEdit(active?.draft ?? emptyDraft, pending, initialPrompt));
  const stateRef = useRef(state);
  stateRef.current = state;
  const ctl = useMemo(
    () => createEditController(actions ?? serverActions(agentId), { getState: () => stateRef.current, dispatch }),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [agentId, actions],
  );
  const stripped = useRef(false);
  useEffect(() => {
    if (stripped.current) return;
    stripped.current = true;
    stripParams(window, ['prompt']);
  }, []);

  if (!active) return <p className="card text-sm text-fg-2">{copy.edit.none}</p>;
  return (
    <EditView
      state={state}
      on={{
        onEdit: ctl.onEdit,
        onSave: () => void ctl.onSave(),
        onPrompt: ctl.setPrompt,
        onSpec: ctl.setSpec,
        onAdd: () => void ctl.onAdd(),
        onUpdate: () => void ctl.onUpdate(),
        onDiscard: () => void ctl.onDiscard(),
      }}
    />
  );
}

const emptyDraft: DraftData = { name: '', sentence: [], params: [], bindings: [], spec: { persona: '', system_prompt: '', skills: [] } };
