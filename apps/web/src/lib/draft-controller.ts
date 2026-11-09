/**
 * What the draft screen does when the visitor acts: the boot step and every handler, with the server actions, the state
 * and the browser handed in. No React and no globals are read here, so tests drive it with fake actions and a dispatch log.
 */
import { copy } from '../copy';
import { asDraft, asTrial, type ActionResult, type DraftData, type OptionValue } from './draft-types';
import { coerceValue, isValueKey, type Values } from './template-values';
import {
  canCallTrial,
  clearStored,
  loadStored,
  planBoot,
  stripParams,
  type DraftAction,
  type DraftState,
  type SpecPatch,
} from './draft-state';

/** The server actions the screen talks to. Injected so the flow can be driven with fakes. */
export interface DraftActions {
  draft(prompt: string): Promise<ActionResult<{ draft: unknown }>>;
  edit(draft: unknown, param: string, value: unknown): Promise<ActionResult<{ draft: unknown }>>;
  trial(spec: unknown): Promise<ActionResult<{ trial: unknown }>>;
  claim(id: string): Promise<ActionResult<{ draft: unknown }>>;
  /** A ready draft (agent template): no model call, no limit. */
  template(id: string): Promise<ActionResult<{ draft: unknown }>>;
}

type StripWindow = Parameters<typeof stripParams>[0];
type Store = NonNullable<Parameters<typeof loadStored>[0]>;

export interface DraftControllerDeps {
  /** The current state, read when a handler runs (not when it was made). */
  getState(): DraftState;
  dispatch(a: DraftAction): void;
  /** Called only in the browser, when a handler or the boot step runs. */
  getWindow(): StripWindow;
  replace(url: string): void;
  /** This tab's session storage; the real one when absent. */
  store?: Store;
}

/**
 * Handoff ids this page load has already claimed on its own. A claim is single use, so a second automatic try (React's
 * development double effect, a remount) would only fail; module level so it survives both.
 */
const autoClaimed = new Set<string>();

export function createDraftController(actions: DraftActions, deps: DraftControllerDeps) {
  const { getState, dispatch } = deps;

  async function runDraft(text: string): Promise<void> {
    dispatch({ t: 'drafting', prompt: text });
    try {
      const r = await actions.draft(text);
      const d = r.ok ? asDraft(r.draft) : null;
      if (d) dispatch({ t: 'drafted', draft: d });
      else dispatch({ t: 'draft-failed', kind: r.ok ? 'failed' : r.kind, message: r.ok ? copy.errors.builderFailed : r.message });
    } catch {
      dispatch({ t: 'draft-failed', kind: 'failed', message: copy.errors.generic });
    }
  }

  /** The template this screen opened (and the builder's values for it), so Retry opens it again instead of drafting an empty prompt. */
  let openedTemplate: { id: string; values: Values } | undefined;

  /**
   * The builder's values on the ready draft, one at a time through the api's param engine (the same edit a tap makes, no
   * model call). A value that does not fit its param is skipped (and said); a refused edit stops there and keeps the last good draft.
   */
  async function applyValues(d: DraftData, values: Values): Promise<{ draft: DraftData; failed?: { message: string; signIn: boolean } }> {
    let draft = d;
    let skipped = false;
    for (const [id, raw] of Object.entries(values)) {
      const p = draft.params.find((x) => x.id === id);
      const v = p ? coerceValue(p, raw) : null;
      if (!p || v === null) {
        skipped = true;
        continue;
      }
      if (v === p.value) continue;
      try {
        const r = await actions.edit(draft, id, v);
        const next = r.ok ? asDraft(r.draft) : null;
        if (!next) return { draft, failed: { message: r.ok ? copy.errors.badEdit : r.message, signIn: !r.ok && r.kind === 'sign_in' } };
        draft = next;
      } catch {
        return { draft, failed: { message: copy.errors.generic, signIn: false } };
      }
    }
    return skipped ? { draft, failed: { message: copy.errors.badEdit, signIn: false } } : { draft };
  }

  /** A template link: the ready draft, straight to the plan. The id and its values leave the address bar first, like a prompt. */
  async function openTemplate(id: string, values: Values = {}): Promise<void> {
    openedTemplate = { id, values };
    dispatch({ t: 'drafting', prompt: '' });
    stripParams(deps.getWindow(), (n) => n === 'template' || isValueKey(n));
    try {
      const r = await actions.template(id);
      const d = r.ok ? asDraft(r.draft) : null;
      if (!d) {
        dispatch({ t: 'draft-failed', kind: r.ok ? 'failed' : r.kind, message: r.ok ? copy.errors.notFound : r.message });
        return;
      }
      const applied = await applyValues(d, values);
      dispatch({ t: 'resumed', prompt: '', draft: applied.draft });
      // The plan opens either way; a value it would not take is said plainly under the sentence, like a refused tap.
      if (applied.failed) dispatch({ t: 'edit-failed', ...applied.failed });
    } catch {
      dispatch({ t: 'draft-failed', kind: 'failed', message: copy.errors.generic });
    }
  }

  /** The automatic claim: "Opening your draft", then the draft (and creating, if that is why the visitor signed in). No retry. */
  async function openParked(id: string, intent: 'create' | undefined): Promise<void> {
    dispatch({ t: 'drafting', prompt: '' });
    // The id leaves the address bar before the answer: a refresh or a screenshot mid-claim cannot reuse or show it.
    stripParams(deps.getWindow(), ['h', 'intent']);
    let draft = null;
    try {
      const r = await actions.claim(id);
      draft = r.ok ? asDraft(r.draft) : null;
    } catch {
      draft = null;
    }
    // Never enter creation from a link: with intent=create the visitor lands on the draft and taps Create themselves.
    if (draft) dispatch({ t: 'resumed', prompt: '', draft, ...(intent === 'create' ? { ask: true } : {}) });
    else dispatch({ t: 'wait', handoff: id });
  }

  return {
    runDraft,

    /**
     * Runs once on arrival: read this tab's copy, clean the address bar, then do what the plan says. `home` is where an
     * empty tab goes: the homepage, or the owner's area for someone who already has an agent (the homepage is public and
     * no longer sends owners on).
     */
    boot(i: { prompt?: string | undefined; handoff?: string | undefined; template?: string | undefined; values?: Values | undefined; signedIn?: boolean | undefined; intent?: 'create' | undefined; home?: string | undefined }): void {
      const plan = planBoot({ prompt: i.prompt, handoff: i.handoff, template: i.template, values: i.values, stored: loadStored(deps.store) });
      stripParams(deps.getWindow(), ['prompt']);
      if (plan.kind === 'handoff') {
        // Signed in: open the parked draft on our own, once (the browser session is what makes the claim work). Signed out:
        // the screen waits with the sign-in card. Either way a failed claim ends on the "Show my draft" button.
        if (i.signedIn) {
          if (autoClaimed.has(plan.id)) {
            // Already claimed by an earlier run of this page: show this tab's draft, else the button. Never blank.
            const st = loadStored(deps.store);
            if (st?.draft) dispatch({ t: 'resumed', prompt: st.prompt, draft: st.draft });
            else dispatch({ t: 'wait', handoff: plan.id });
            return;
          }
          autoClaimed.add(plan.id);
          void openParked(plan.id, i.intent);
        } else dispatch({ t: 'wait', handoff: plan.id });
      } else if (plan.kind === 'template') void openTemplate(plan.id, plan.values);
      else if (plan.kind === 'resume') dispatch({ t: 'resumed', prompt: plan.prompt, draft: plan.draft });
      else if (plan.kind === 'draft') void runDraft(plan.prompt);
      else {
        dispatch({ t: 'empty' });
        deps.replace(i.home ?? '/');
      }
    },

    /** "Show my draft": the button a failed automatic claim falls back to. The id leaves the address bar whatever the answer. */
    async onShow(): Promise<void> {
      const id = getState().handoff;
      if (!id) return;
      dispatch({ t: 'drafting', prompt: '' });
      try {
        const r = await actions.claim(id);
        const d = r.ok ? asDraft(r.draft) : null;
        if (d) dispatch({ t: 'resumed', prompt: '', draft: d });
        else dispatch({ t: 'draft-failed', kind: r.ok ? 'failed' : r.kind, message: r.ok ? copy.errors.notFound : r.message });
      } catch {
        dispatch({ t: 'draft-failed', kind: 'failed', message: copy.errors.generic });
      } finally {
        stripParams(deps.getWindow(), ['h', 'intent']);
      }
    },

    onRetry: (): Promise<void> => {
      const prompt = getState().prompt;
      return !prompt && openedTemplate ? openTemplate(openedTemplate.id, openedTemplate.values) : runDraft(prompt);
    },

    onStartOver(): void {
      clearStored(deps.store);
      deps.replace('/');
    },

    onRename: (name: string): void => dispatch({ t: 'rename', name }),
    onSpec: (patch: SpecPatch): void => dispatch({ t: 'spec', patch }),
    onCreate: (): void => dispatch({ t: 'create' }),
    onBack: (): void => dispatch({ t: 'back' }),

    async onEdit(param: string, value: OptionValue): Promise<boolean> {
      const draft = getState().draft;
      if (!draft) return false;
      dispatch({ t: 'edit-start' });
      try {
        const r = await actions.edit(draft, param, value);
        const d = r.ok ? asDraft(r.draft) : null;
        if (d) {
          dispatch({ t: 'edit-done', draft: d });
          return true;
        }
        dispatch({ t: 'edit-failed', message: r.ok ? copy.errors.badEdit : r.message, signIn: !r.ok && r.kind === 'sign_in' });
      } catch {
        dispatch({ t: 'edit-failed', message: copy.errors.generic, signIn: false });
      }
      return false;
    },

    async onTry(): Promise<void> {
      const s = getState();
      if (!s.draft) return;
      const spec = s.draft.spec;
      // Past the limit a second press only shows the sign-in card again; the api is not called.
      const call = canCallTrial(s);
      dispatch({ t: 'trial-start' });
      if (!call) return;
      try {
        const r = await actions.trial(spec);
        const t = r.ok ? asTrial(r.trial) : null;
        if (t) dispatch({ t: 'trial-done', spec, result: t });
        else dispatch({ t: 'trial-failed', spec, kind: r.ok ? 'failed' : r.kind, message: r.ok ? copy.errors.generic : r.message });
      } catch {
        dispatch({ t: 'trial-failed', spec, kind: 'failed', message: copy.errors.generic });
      }
    },
  };
}

export type DraftController = ReturnType<typeof createDraftController>;
