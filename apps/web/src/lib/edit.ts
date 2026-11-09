/**
 * "What it does" as plain data: the agent's sentence with the changes tapped so far, the pending change written from a
 * new request, and the controller that talks to the server actions (injected, so tests drive it with fakes).
 *
 * Taps are kept on screen until "Save changes": each tap asks the api to apply the new value to the stored description
 * (with the earlier taps replayed first, so none is lost) and shows the result. Nothing is stored until Save. A change
 * written from a request becomes a pending version that only "Update" approves; "Discard" throws it away.
 */
import { copy } from '../copy';
import { asDraft, type DraftData, type OptionValue } from './draft-types';
import { patchSpec, type SpecPatch } from './draft-state';

export interface Edit {
  param: string;
  value: OptionValue;
}
export interface Pending {
  version: number;
  draft: DraftData;
  /** When the api stored this draft. "Update" sends it back, so a draft replaced in the meantime is refused, not approved. */
  createdAt?: string;
}
export type Busy = 'none' | 'tap' | 'save' | 'revise' | 'update' | 'discard';

export interface EditState {
  /** The sentence as it stands on screen: the stored one plus the taps. */
  draft: DraftData;
  edits: Edit[];
  pending: Pending | null;
  busy: Busy;
  message: string | null;
  /** Which action the message is about, so it is shown beside that action only. */
  messageFrom: Busy;
  notice: string | null;
  /** The text in the "Add this to your agent" box. */
  prompt: string;
  /** The owner changed the raw words (persona, system prompt, a skill) under "Edit the details". Saved like taps. */
  specEdited: boolean;
}

export const initialEdit = (draft: DraftData, pending: Pending | null, prompt = ''): EditState => ({ draft, edits: [], pending, busy: 'none', message: null, messageFrom: 'none', notice: null, prompt, specEdited: false });

/** Something on screen differs from the stored description: taps or raw words. */
export const isDirty = (s: EditState): boolean => s.edits.length > 0 || s.specEdited;

/** The latest value per parameter, in the order they were last tapped. */
export const withEdit = (edits: readonly Edit[], e: Edit): Edit[] => [...edits.filter((x) => x.param !== e.param), e];

export type EditAction =
  | { t: 'busy'; busy: Busy }
  | { t: 'tapped'; draft: DraftData; edit: Edit }
  | { t: 'spec'; patch: SpecPatch }
  | { t: 'failed'; message: string }
  | { t: 'saved' }
  | { t: 'saved-unapproved'; pending: Pending; message: string }
  | { t: 'prompt'; text: string }
  | { t: 'revised'; pending: Pending }
  | { t: 'updated' }
  | { t: 'discarded' };

export function editReducer(s: EditState, a: EditAction): EditState {
  switch (a.t) {
    case 'busy':
      return { ...s, busy: a.busy, message: null, notice: null };
    case 'tapped':
      return { ...s, draft: a.draft, edits: withEdit(s.edits, a.edit), busy: 'none', message: null };
    case 'spec':
      return { ...s, draft: patchSpec(s.draft, a.patch), specEdited: true, message: null, notice: null };
    case 'failed':
      return { ...s, busy: 'none', message: a.message, messageFrom: s.busy };
    case 'saved':
      return { ...s, edits: [], specEdited: false, busy: 'none', message: null, notice: copy.edit.updated };
    case 'saved-unapproved':
      return { ...s, edits: [], specEdited: false, pending: a.pending, busy: 'none', message: a.message, messageFrom: 'save' };
    case 'prompt':
      return { ...s, prompt: a.text };
    case 'revised':
      return { ...s, pending: a.pending, prompt: '', busy: 'none', message: null };
    case 'updated':
      return s.pending ? { ...s, draft: s.pending.draft, edits: [], specEdited: false, pending: null, busy: 'none', message: null, notice: copy.edit.updated } : s;
    case 'discarded':
      return { ...s, pending: null, busy: 'none', message: null, notice: null };
  }
}

export type EditOut<T extends object = object> = ({ ok: true } & T) | { ok: false; message: string; version?: number };

/** The server actions this screen talks to. */
export interface EditActions {
  edit(param: string, value: OptionValue, earlier: Edit[]): Promise<EditOut<{ draft: unknown }>>;
  save(draft: DraftData): Promise<EditOut>;
  revise(prompt: string): Promise<EditOut<{ version: number; createdAt?: string; draft: unknown }>>;
  approve(version: number, createdAt?: string): Promise<EditOut>;
  discard(version: number): Promise<EditOut>;
}

export interface EditControllerDeps {
  getState(): EditState;
  dispatch(a: EditAction): void;
}

export function createEditController(actions: EditActions, d: EditControllerDeps) {
  const idle = () => d.getState().busy === 'none';
  const generic = copy.errors.generic;

  return {
    setPrompt: (text: string): void => d.dispatch({ t: 'prompt', text }),

    /** A change to the raw words under "Edit the details". Kept on screen until "Save changes", like a tap. */
    setSpec: (patch: SpecPatch): void => {
      if (idle()) d.dispatch({ t: 'spec', patch });
    },

    /** A tap on the sentence. True when the value was taken; a refused tap leaves the sentence as it was. */
    async onEdit(param: string, value: OptionValue): Promise<boolean> {
      // The api rebuilds the sentence from the stored description, so a tap would drop unsaved raw words: save them first.
      if (!idle() || d.getState().specEdited) return false;
      const s = d.getState();
      d.dispatch({ t: 'busy', busy: 'tap' });
      try {
        const r = await actions.edit(param, value, s.edits);
        const draft = r.ok ? asDraft(r.draft) : null;
        if (draft) {
          d.dispatch({ t: 'tapped', draft, edit: { param, value } });
          return true;
        }
        d.dispatch({ t: 'failed', message: r.ok ? copy.errors.badEdit : r.message });
      } catch {
        d.dispatch({ t: 'failed', message: generic });
      }
      return false;
    },

    /** "Save changes": store the sentence as a new version and approve it. */
    async onSave(): Promise<void> {
      const s = d.getState();
      if (!idle() || !isDirty(s)) return;
      d.dispatch({ t: 'busy', busy: 'save' });
      try {
        const r = await actions.save(s.draft);
        if (r.ok) return d.dispatch({ t: 'saved' });
        // Stored but not approved: it is a pending change now, and "Update" can finish the job.
        if (r.version !== undefined) return d.dispatch({ t: 'saved-unapproved', pending: { version: r.version, draft: s.draft }, message: r.message });
        d.dispatch({ t: 'failed', message: r.message });
      } catch {
        d.dispatch({ t: 'failed', message: generic });
      }
    },

    /** "Write the change": a new request becomes a pending version. Never approves anything. */
    async onAdd(): Promise<void> {
      const s = d.getState();
      const text = s.prompt.trim();
      if (!idle() || text === '' || isDirty(s)) return;
      d.dispatch({ t: 'busy', busy: 'revise' });
      try {
        const r = await actions.revise(text);
        const draft = r.ok ? asDraft(r.draft) : null;
        if (r.ok && draft) return d.dispatch({ t: 'revised', pending: { version: r.version, draft, ...(r.createdAt ? { createdAt: r.createdAt } : {}) } });
        d.dispatch({ t: 'failed', message: r.ok ? copy.errors.builderFailed : r.message });
      } catch {
        d.dispatch({ t: 'failed', message: generic });
      }
    },

    /** "Update": approves exactly the pending version that is on screen. */
    async onUpdate(): Promise<void> {
      const p = d.getState().pending;
      if (!idle() || !p) return;
      d.dispatch({ t: 'busy', busy: 'update' });
      try {
        const r = await actions.approve(p.version, p.createdAt);
        d.dispatch(r.ok ? { t: 'updated' } : { t: 'failed', message: r.message });
      } catch {
        d.dispatch({ t: 'failed', message: generic });
      }
    },

    /** "Discard": deletes the pending version. The active one is untouched. */
    async onDiscard(): Promise<void> {
      const p = d.getState().pending;
      if (!idle() || !p) return;
      d.dispatch({ t: 'busy', busy: 'discard' });
      try {
        const r = await actions.discard(p.version);
        d.dispatch(r.ok ? { t: 'discarded' } : { t: 'failed', message: r.message });
      } catch {
        d.dispatch({ t: 'failed', message: generic });
      }
    },
  };
}
export type EditController = ReturnType<typeof createEditController>;

/** The edit screen's data from the api's spec view: the stored sentence and the pending change, if any. */
export interface SpecShown {
  active: { version: number; draft: DraftData } | null;
  pending: Pending | null;
}
