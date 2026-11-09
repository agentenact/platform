/**
 * The draft screen's state and its pure helpers: the reducer, what to do on first load, this tab's sessionStorage copy,
 * and removing ?prompt= from the address bar. No React and no browser globals are read here (they are passed in), so
 * everything is testable without a browser.
 */
import { clampPrompt } from './prompt';
import { bannedWord } from './words';
import { asDraft, type DraftData, type DraftSpec, type TrialData } from './draft-types';
import { readValues, type Values } from './template-values';

export type Phase = 'booting' | 'waiting' | 'drafting' | 'ready' | 'limit' | 'failed' | 'empty';
export type FailKind = 'daily' | 'busy' | 'failed';

export interface TrialState {
  status: 'idle' | 'running' | 'done' | 'limit' | 'failed';
  result?: TrialData;
  message?: string;
}

export interface DraftState {
  phase: Phase;
  prompt: string;
  /** The handoff id waiting to be claimed (a single-use secret; shown to nobody). */
  handoff?: string;
  draft: DraftData | null;
  failKind?: FailKind;
  message?: string;
  edit: { busy: boolean; message?: string; signIn: boolean };
  trial: TrialState;
  /** "Create this agent" was pressed. */
  creating: boolean;
  /** Arrived signed in from a link meant for creating: ask for the tap, never start on our own. */
  askCreate: boolean;
}

export const initialState: DraftState = { phase: 'booting', prompt: '', draft: null, edit: { busy: false, signIn: false }, trial: { status: 'idle' }, creating: false, askCreate: false };

export type SpecPatch = { persona: string } | { system_prompt: string } | { skill: number; body: string };

export type DraftAction =
  | { t: 'wait'; handoff: string }
  | { t: 'drafting'; prompt: string }
  | { t: 'drafted'; draft: DraftData }
  | { t: 'resumed'; prompt: string; draft: DraftData; ask?: boolean }
  | { t: 'draft-failed'; kind: 'sign_in' | FailKind; message: string }
  | { t: 'empty' }
  | { t: 'edit-start' }
  | { t: 'edit-done'; draft: DraftData }
  | { t: 'edit-failed'; message: string; signIn: boolean }
  | { t: 'rename'; name: string }
  | { t: 'spec'; patch: SpecPatch }
  | { t: 'trial-start' }
  | { t: 'trial-done'; spec: DraftSpec; result: TrialData }
  | { t: 'trial-failed'; spec: DraftSpec; kind: 'sign_in' | FailKind; message: string }
  | { t: 'create' }
  | { t: 'back' };

const idle: TrialState = { status: 'idle' };
const calm = { busy: false, signIn: false } as const;

/** The draft after a patch to the description's text fields. Pure; the api re-validates on create. */
export function patchSpec(d: DraftData, patch: SpecPatch): DraftData {
  if ('persona' in patch) return { ...d, spec: { ...d.spec, persona: patch.persona } };
  if ('system_prompt' in patch) return { ...d, spec: { ...d.spec, system_prompt: patch.system_prompt } };
  return { ...d, spec: { ...d.spec, skills: d.spec.skills.map((s, i) => (i === patch.skill ? { ...s, body: patch.body } : s)) } };
}

export function draftReducer(s: DraftState, a: DraftAction): DraftState {
  switch (a.t) {
    case 'wait':
      return { ...initialState, phase: 'waiting', handoff: a.handoff };
    case 'empty':
      return { ...initialState, phase: 'empty' };
    case 'drafting':
      return { ...initialState, phase: 'drafting', prompt: a.prompt };
    case 'drafted':
      return { ...initialState, phase: 'ready', prompt: s.prompt, draft: a.draft };
    case 'resumed':
      return { ...initialState, phase: 'ready', prompt: a.prompt, draft: a.draft, askCreate: a.ask === true };
    case 'draft-failed':
      if (a.kind === 'sign_in') return { ...s, phase: 'limit', message: a.message };
      return { ...s, phase: 'failed', failKind: a.kind, message: a.message };
    case 'edit-start':
      return { ...s, edit: { busy: true, signIn: false } };
    case 'edit-done':
      // A changed sentence is a different draft: an old trial would describe something else.
      return { ...s, draft: a.draft, edit: calm, trial: idle };
    case 'edit-failed':
      return { ...s, edit: { busy: false, message: a.message, signIn: a.signIn } };
    case 'rename':
      return s.draft ? { ...s, draft: { ...s.draft, name: a.name } } : s;
    case 'spec':
      return s.draft ? { ...s, draft: patchSpec(s.draft, a.patch), trial: idle } : s;
    case 'trial-start':
      // Past the limit a second press asks to sign in; it never calls the api again.
      if (s.trial.status === 'limit' || s.trial.status === 'running') return s;
      return { ...s, trial: { status: 'running' } };
    case 'trial-done':
      // The result belongs to the description it was run on. If the sentence changed meanwhile, it is stale: drop it.
      if (s.draft?.spec !== a.spec) return s;
      return { ...s, trial: { status: 'done', result: a.result } };
    case 'trial-failed':
      if (s.draft?.spec !== a.spec) return s;
      return { ...s, trial: a.kind === 'sign_in' ? { status: 'limit', message: a.message } : { status: 'failed', message: a.message } };
    case 'create':
      // A name the api would refuse (a technical word) never starts creating: the card says why and Create stays off.
      return s.draft && bannedWord(s.draft.name) === null ? { ...s, creating: true, askCreate: false } : s;
    case 'back':
      // From the sign-in step of creating back to the draft; nothing is lost.
      return s.creating ? { ...s, creating: false } : s;
  }
}

/**
 * Whether this tab's copy should be written for this state. Not while a handoff is being claimed (a drafting state with no
 * prompt): that would overwrite the draft this tab already holds with an empty one before the claim has answered.
 */
export const shouldSave = (s: DraftState): boolean =>
  s.phase === 'ready' || s.phase === 'limit' || s.phase === 'failed' || (s.phase === 'drafting' && s.prompt !== '');

/** Whether Try it now should call the api: not while one runs and not past the limit (it then shows the sign-in card). */
export const canCallTrial = (s: DraftState): boolean => s.draft !== null && s.trial.status !== 'running' && s.trial.status !== 'limit';

// --- first load ------------------------------------------------------------

/** An agent whose creation started but never finished (the api calls it `provisioning`). Active and paused agents are finished. */
export const isUnfinishedAgent = (status: string | undefined): boolean => status === 'provisioning';

export const HANDOFF_ID = /^[A-Za-z0-9_-]{22}$/;
const first = (v: string | string[] | undefined): string | undefined => (Array.isArray(v) ? v[0] : v);

/** An agent template id, as the api names them (`?template=xlm-drop`). */
export const TEMPLATE_ID = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
/** A community template, by its sha256 (`?template=c-<64 hex>`): anyone may have published it, so the plan says so. */
export const COMMUNITY_TEMPLATE_ID = /^c-([0-9a-f]{64})$/;

/** A well-formed template id from a search param, else undefined. */
export const readTemplateId = (v: string | string[] | undefined): string | undefined => {
  const t = first(v);
  return t && ((t.length <= 40 && TEMPLATE_ID.test(t)) || COMMUNITY_TEMPLATE_ID.test(t)) ? t : undefined;
};

/**
 * ?prompt= (clamped, trimmed), ?h= (only a well-formed id), ?template= (a kebab-case id) with its values (`p.<param>=`, from the
 * /create builder; read only with a template) and ?intent= (only a single, exact "create") from the page's search params.
 */
export function readDraftParams(sp: Record<string, string | string[] | undefined>): { prompt?: string; handoff?: string; template?: string; values?: Values; intent?: 'create' } {
  const prompt = clampPrompt(first(sp.prompt) ?? '').trim();
  const h = first(sp.h);
  const template = readTemplateId(sp.template);
  const values = template ? readValues(sp) : {};
  return {
    ...(prompt ? { prompt } : {}),
    ...(h && HANDOFF_ID.test(h) ? { handoff: h } : {}),
    ...(template ? { template } : {}),
    ...(Object.keys(values).length > 0 ? { values } : {}),
    ...(sp.intent === 'create' ? { intent: 'create' as const } : {}),
  };
}

export interface Stored {
  prompt: string;
  draft: DraftData | null;
}

export type BootPlan =
  | { kind: 'handoff'; id: string }
  | { kind: 'draft'; prompt: string }
  | { kind: 'template'; id: string; values?: Values }
  | { kind: 'resume'; prompt: string; draft: DraftData }
  | { kind: 'empty' };

/**
 * What the screen does first. A handoff id wins. A fresh prompt drafts, unless this tab already holds a draft of that same
 * prompt (a reload before the address bar was cleaned, or a repeat visit), which resumes at no cost. With neither, this
 * tab's saved draft resumes, an interrupted draft starts again from its prompt, and an empty tab goes back to the first screen.
 */
export function planBoot(i: { prompt?: string | undefined; handoff?: string | undefined; template?: string | undefined; values?: Values | undefined; stored: Stored | null }): BootPlan {
  if (i.handoff) return { kind: 'handoff', id: i.handoff };
  // A template link is a fresh choice: it opens that ready draft even over this tab's saved one, and costs nothing.
  if (i.template) return { kind: 'template', id: i.template, ...(i.values && Object.keys(i.values).length > 0 ? { values: i.values } : {}) };
  const st = i.stored;
  if (i.prompt) return st?.draft && st.prompt === i.prompt ? { kind: 'resume', prompt: st.prompt, draft: st.draft } : { kind: 'draft', prompt: i.prompt };
  if (st?.draft) return { kind: 'resume', prompt: st.prompt, draft: st.draft };
  if (st?.prompt) return { kind: 'draft', prompt: st.prompt };
  return { kind: 'empty' };
}

// --- this tab's session copy ---------------------------------------------

export const STORAGE_KEY = 'agentenact.draft.v1';
type Store = Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>;

/** Reads this tab's saved draft. Any failure (no storage, blocked, corrupt) is "nothing saved". */
export function loadStored(store?: Store): Stored | null {
  try {
    const raw = (store ?? sessionStorage).getItem(STORAGE_KEY);
    if (!raw) return null;
    const v = JSON.parse(raw) as { prompt?: unknown; draft?: unknown } | null;
    if (!v || typeof v !== 'object') return null;
    return { prompt: typeof v.prompt === 'string' ? v.prompt : '', draft: v.draft ? asDraft(v.draft) : null };
  } catch {
    return null;
  }
}

export function saveStored(s: Stored, store?: Store): void {
  try {
    (store ?? sessionStorage).setItem(STORAGE_KEY, JSON.stringify(s));
  } catch {
    /* no storage: the screen works, a reload just starts over */
  }
}

export function clearStored(store?: Store): void {
  try {
    (store ?? sessionStorage).removeItem(STORAGE_KEY);
  } catch {
    /* nothing to clear */
  }
}

// --- the address bar ----------------------------------------------------------

/** Which query parameters to drop: these names, or every name a test matches (`isValueKey` for the `p.<param>` values). */
type Drop = readonly string[] | ((name: string) => boolean);

/** `href` without the named query parameters (path, other parameters and fragment kept, as a relative URL). */
export function urlWithout(href: string, names: Drop): string {
  const u = new URL(href, 'http://local.invalid');
  const drop = typeof names === 'function' ? [...new Set(u.searchParams.keys())].filter(names) : names;
  for (const n of drop) u.searchParams.delete(n);
  return `${u.pathname}${u.search}${u.hash}`;
}

/** Takes the named parameters out of the address bar without a navigation. Keeps Next's own history state. */
export function stripParams(w: { location: { href: string }; history: { state: unknown; replaceState(state: unknown, unused: string, url: string): void } }, names: Drop): void {
  try {
    const next = urlWithout(w.location.href, names);
    const cur = new URL(w.location.href, 'http://local.invalid');
    if (next !== `${cur.pathname}${cur.search}${cur.hash}`) w.history.replaceState(w.history.state, '', next);
  } catch {
    /* a locked-down history: the parameter stays in the bar, nothing breaks */
  }
}
