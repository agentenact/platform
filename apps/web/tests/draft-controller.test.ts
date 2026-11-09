import { describe, expect, test } from 'bun:test';
import { copy } from '../src/copy';
import { createDraftController, type DraftActions } from '../src/lib/draft-controller';
import { draftReducer, initialState, loadStored, saveStored, shouldSave, STORAGE_KEY, type DraftAction, type DraftState } from '../src/lib/draft-state';
import type { ActionResult, TrialData } from '../src/lib/draft-types';
import { createBuilderActions } from '../src/server/builder-actions';
import { sampleDraft } from './support/draft';

const mem = () => {
  const m = new Map<string, string>();
  return { getItem: (k: string) => m.get(k) ?? null, setItem: (k: string, v: string) => void m.set(k, v), removeItem: (k: string) => void m.delete(k), m };
};
const ok = <T extends object>(v: T): ActionResult<T> => ({ ok: true, ...v });
const trialOf = (over: Partial<TrialData> = {}): TrialData => ({ status: 'done', condition: null, text: 'fine', wouldHave: [], steps: [], ...over });
const ID = 'AbCdEfGhIjKlMnOpQrStUv';

/** A controller over fake actions and a real reducer, with a log of every dispatch, call, address-bar write and navigation. */
function rig(over: Partial<DraftActions> = {}, start: DraftState = initialState, href = 'https://app.test/draft?prompt=watch%20xlm&h=' + ID) {
  const calls: { fn: string; args: unknown[] }[] = [];
  const log: DraftAction[] = [];
  const writes: string[] = [];
  const replaced: string[] = [];
  let state = start;
  const rec = <A extends unknown[], R>(fn: string, f: (...a: A) => R) => (...a: A): R => (calls.push({ fn, args: a }), f(...a));
  const actions: DraftActions = {
    draft: rec('draft', async () => ok({ draft: sampleDraft() as unknown })),
    edit: rec('edit', async () => ok({ draft: sampleDraft({ name: 'edited' }) as unknown })),
    trial: rec('trial', async () => ok({ trial: trialOf() as unknown })),
    claim: rec('claim', async () => ok({ draft: sampleDraft() as unknown })),
    template: rec('template', async () => ok({ draft: sampleDraft({ name: 'from template' }) as unknown })),
    ...over,
  };
  const store = mem();
  const win = { location: { href }, history: { state: null, replaceState: (_s: unknown, _u: string, url: string) => void writes.push(url) } };
  const ctl = createDraftController(actions, {
    getState: () => state,
    dispatch: (a) => {
      log.push(a);
      state = draftReducer(state, a);
    },
    getWindow: () => win,
    replace: (u) => void replaced.push(u),
    store,
  });
  return { ctl, calls, log, writes, replaced, store, get state() { return state; } };
}
const readyState = (): DraftState => draftReducer(draftReducer(initialState, { t: 'drafting', prompt: 'watch xlm' }), { t: 'drafted', draft: sampleDraft() });

describe('boot', () => {
  test('a prompt drafts after the address bar lost ?prompt=, and the draft lands', async () => {
    const r = rig();
    r.ctl.boot({ prompt: 'watch xlm' });
    expect(r.writes).toEqual(['/draft?h=' + ID]);
    expect(r.log[0]).toEqual({ t: 'drafting', prompt: 'watch xlm' });
    await Promise.resolve();
    await Promise.resolve();
    expect(r.calls.filter((c) => c.fn === 'draft')).toHaveLength(1);
    expect(r.state.phase).toBe('ready');
  });
  test('the strip happens before any draft call', () => {
    const seq: string[] = [];
    const ctl = createDraftController(
      { ...rigActions(), draft: async () => (seq.push('draft'), ok({ draft: sampleDraft() as unknown })) },
      { getState: () => initialState, dispatch: () => {}, getWindow: () => ({ location: { href: 'https://app.test/draft?prompt=x' }, history: { state: null, replaceState: () => void seq.push('strip') } }), replace: () => {}, store: mem() },
    );
    ctl.boot({ prompt: 'x' });
    expect(seq).toEqual(['strip', 'draft']);
  });
  test('a handoff only waits; nothing is claimed on load', () => {
    const r = rig();
    r.ctl.boot({ handoff: ID });
    expect(r.state.phase).toBe('waiting');
    expect(r.calls).toEqual([]);
  });
  test('the same prompt as this tab holds resumes without another draft call', () => {
    const r = rig();
    saveStored({ prompt: 'watch xlm', draft: sampleDraft() }, r.store);
    r.ctl.boot({ prompt: 'watch xlm' });
    expect(r.state.phase).toBe('ready');
    expect(r.calls).toEqual([]);
  });
  test('an empty tab goes back to the first screen', () => {
    const r = rig({}, initialState, 'https://app.test/draft');
    r.ctl.boot({});
    expect(r.state.phase).toBe('empty');
    expect(r.replaced).toEqual(['/']);
  });
});

function rigActions(): DraftActions {
  return { draft: async () => ok({ draft: sampleDraft() as unknown }), edit: async () => ok({ draft: sampleDraft() as unknown }), trial: async () => ok({ trial: trialOf() as unknown }), claim: async () => ok({ draft: sampleDraft() as unknown }), template: async () => ok({ draft: sampleDraft() as unknown }) };
}

describe('editing', () => {
  test('editing sends the draft the screen holds, with the parameter and value, and shows the new one', async () => {
    const r = rig({}, readyState());
    const before = r.state.draft;
    expect(await r.ctl.onEdit('drop', 8)).toBe(true);
    expect(r.calls).toEqual([{ fn: 'edit', args: [before, 'drop', 8] }]);
    expect(r.state.draft?.name).toBe('edited');
    expect(r.state.edit.busy).toBe(false);
  });
  test('a refused edit returns false, keeps the draft and carries the plain message', async () => {
    const r = rig({ edit: async () => ({ ok: false, kind: 'failed', message: copy.errors.badEdit }) }, readyState());
    const before = r.state.draft;
    expect(await r.ctl.onEdit('drop', 999)).toBe(false);
    expect(r.state.draft).toBe(before);
    expect(r.state.edit.message).toBe(copy.errors.badEdit);
  });
  test('an edit limit shows sign in; a throwing action shows generic copy', async () => {
    const lim = rig({ edit: async () => ({ ok: false, kind: 'sign_in', message: copy.errors.signInToKeepDrafting }) }, readyState());
    expect(await lim.ctl.onEdit('drop', 3)).toBe(false);
    expect(lim.state.edit.signIn).toBe(true);
    const thr = rig({ edit: async () => { throw new Error('boom'); } }, readyState());
    expect(await thr.ctl.onEdit('drop', 3)).toBe(false);
    expect(thr.state.edit.message).toBe(copy.errors.generic);
  });
  test('with no draft nothing is called', async () => {
    const r = rig();
    expect(await r.ctl.onEdit('drop', 1)).toBe(false);
    expect(r.calls).toEqual([]);
  });
});

describe('Try it now', () => {
  test('sends the spec of the draft on screen and shows the result', async () => {
    const r = rig({}, readyState());
    const spec = r.state.draft!.spec;
    await r.ctl.onTry();
    expect(r.calls).toEqual([{ fn: 'trial', args: [spec] }]);
    expect(r.state.trial.status).toBe('done');
  });
  test('past the limit a second press does not call the api', async () => {
    let n = 0;
    const r = rig({ trial: async () => (n++, { ok: false, kind: 'sign_in', message: copy.errors.signInToKeepDrafting }) }, readyState());
    await r.ctl.onTry();
    expect(r.state.trial.status).toBe('limit');
    await r.ctl.onTry();
    expect(n).toBe(1);
    expect(r.state.trial.status).toBe('limit');
  });
  test('a second press during a run is ignored', async () => {
    let n = 0;
    let release: (v: ActionResult<{ trial: unknown }>) => void = () => {};
    const r = rig({ trial: () => (n++, new Promise((res) => (release = res))) }, readyState());
    const first = r.ctl.onTry();
    await r.ctl.onTry();
    expect(n).toBe(1);
    release(ok({ trial: trialOf() as unknown }));
    await first;
    expect(r.state.trial.status).toBe('done');
  });
  test('BUG 2: a trial that finishes after the sentence was edited is dropped, not shown on the new sentence', async () => {
    let release: (v: ActionResult<{ trial: unknown }>) => void = () => {};
    const r = rig({ trial: () => new Promise((res) => (release = res)) }, readyState());
    const running = r.ctl.onTry();
    await r.ctl.onEdit('drop', 8); // edit-done lands while the trial runs
    expect(r.state.trial.status).toBe('idle');
    release(ok({ trial: trialOf({ text: 'about the OLD sentence' }) as unknown }));
    await running;
    expect(r.state.trial.status).toBe('idle');
    expect(r.state.trial.result).toBeUndefined();
  });
  test('a stale failure is dropped too, and a rename does not make a result stale', async () => {
    let release: (v: ActionResult<{ trial: unknown }>) => void = () => {};
    const r = rig({ trial: () => new Promise((res) => (release = res)) }, readyState());
    const running = r.ctl.onTry();
    r.ctl.onRename('A new name');
    r.ctl.onSpec({ persona: 'changed' });
    release({ ok: false, kind: 'failed', message: copy.errors.status5xx });
    await running;
    expect(r.state.trial.status).toBe('idle');
    const r2 = rig({}, readyState());
    const p = r2.ctl.onTry();
    r2.ctl.onRename('Mine');
    await p;
    expect(r2.state.trial.status).toBe('done');
  });
  test('a throwing action is a plain failure', async () => {
    const r = rig({ trial: async () => { throw new Error('boom'); } }, readyState());
    await r.ctl.onTry();
    expect(r.state.trial).toMatchObject({ status: 'failed', message: copy.errors.generic });
  });
});

let n = 0;
const fresh = () => `Auto${String(++n).padStart(18, '0')}`;

describe('landing signed in with ?h= (auto-claim)', () => {
  test('claims once on its own, shows "Opening your draft" first, and lands on the draft with ?h= gone', async () => {
    const id = fresh();
    const r = rig({}, initialState, `https://app.test/draft?h=${id}`);
    r.ctl.boot({ handoff: id, signedIn: true });
    expect(r.state).toMatchObject({ phase: 'drafting', prompt: '' });
    await new Promise((res) => setTimeout(res, 0));
    expect(r.calls).toEqual([{ fn: 'claim', args: [id] }]);
    expect(r.state.phase).toBe('ready');
    expect(r.state.creating).toBe(false);
    expect(r.writes).toEqual(['/draft']);
  });
  test('boot twice for one id (strict-mode double effect, a remount) claims once', async () => {
    const id = fresh();
    const r = rig({}, initialState, `https://app.test/draft?h=${id}`);
    r.ctl.boot({ handoff: id, signedIn: true });
    r.ctl.boot({ handoff: id, signedIn: true });
    const other = rig({}, initialState, `https://app.test/draft?h=${id}`);
    other.ctl.boot({ handoff: id, signedIn: true });
    await new Promise((res) => setTimeout(res, 0));
    expect(r.calls.filter((c) => c.fn === 'claim')).toHaveLength(1);
    expect(other.calls).toEqual([]);
  });
  test('with intent=create it lands on the ready draft and asks; it never starts creating from a link', async () => {
    const id = fresh();
    const r = rig({}, initialState, `https://app.test/draft?h=${id}&intent=create`);
    r.ctl.boot({ handoff: id, signedIn: true, intent: 'create' });
    await new Promise((res) => setTimeout(res, 0));
    expect(r.state).toMatchObject({ phase: 'ready', creating: false, askCreate: true });
    expect(r.log.some((a) => a.t === 'create')).toBe(false);
    r.ctl.onCreate();
    expect(r.state).toMatchObject({ creating: true, askCreate: false });
  });
  test('?h= and intent leave the address bar before the claim answers', async () => {
    const id = fresh();
    let release: (v: ActionResult<{ draft: unknown }>) => void = () => {};
    const r = rig({ claim: () => new Promise((res) => (release = res)) }, initialState, `https://app.test/draft?h=${id}&intent=create`);
    r.ctl.boot({ handoff: id, signedIn: true, intent: 'create' });
    expect(r.writes).toEqual(['/draft']);
    release(ok({ draft: sampleDraft() as unknown }));
  });
  test('a remount with an already-claimed id is never blank: the stored draft, else the fallback button', () => {
    const id = fresh();
    const first = rig({ claim: () => new Promise(() => {}) }, initialState, `https://app.test/draft?h=${id}`);
    first.ctl.boot({ handoff: id, signedIn: true });
    const again = rig({}, initialState, `https://app.test/draft?h=${id}`);
    again.ctl.boot({ handoff: id, signedIn: true });
    expect(again.state).toMatchObject({ phase: 'waiting', handoff: id });
    const stored = rig({}, initialState, `https://app.test/draft?h=${id}`);
    saveStored({ prompt: 'watch xlm', draft: sampleDraft() }, stored.store);
    stored.ctl.boot({ handoff: id, signedIn: true });
    expect(stored.state.phase).toBe('ready');
    expect(again.calls).toEqual([]);
  });
  test('a failed claim leaves the old button, never retries, and the button still works', async () => {
    const id = fresh();
    let claims = 0;
    const r = rig({ claim: async () => (claims++, { ok: false, kind: 'failed', message: copy.errors.status404 }) }, initialState, `https://app.test/draft?h=${id}&intent=create`);
    r.ctl.boot({ handoff: id, signedIn: true, intent: 'create' });
    await new Promise((res) => setTimeout(res, 5));
    expect(claims).toBe(1);
    expect(r.state).toMatchObject({ phase: 'waiting', handoff: id, creating: false });
    expect(r.writes).toEqual(['/draft']);
    await r.ctl.onShow();
    expect(claims).toBe(2);
    expect(r.state.phase).toBe('failed');
  });
  test('a thrown claim falls back the same way', async () => {
    const id = fresh();
    const r = rig({ claim: async () => { throw new Error('boom'); } }, initialState, `https://app.test/draft?h=${id}`);
    r.ctl.boot({ handoff: id, signedIn: true });
    await new Promise((res) => setTimeout(res, 5));
    expect(r.state).toMatchObject({ phase: 'waiting', handoff: id });
  });
  test('signed out, nothing is claimed: the sign-in screen waits', () => {
    const id = fresh();
    const r = rig();
    r.ctl.boot({ handoff: id, signedIn: false, intent: 'create' });
    expect(r.state).toMatchObject({ phase: 'waiting', handoff: id });
    expect(r.calls).toEqual([]);
  });
  test('going back from the sign-in step returns to the draft, nothing lost', () => {
    const r = rig({}, draftReducer(readyState(), { t: 'create' }));
    expect(r.state.creating).toBe(true);
    r.ctl.onBack();
    expect(r.state).toMatchObject({ phase: 'ready', creating: false });
    expect(r.state.draft?.name).toBe('XLM watcher');
  });
});

describe('claiming a waiting handoff', () => {
  const waiting = (): DraftState => draftReducer(initialState, { t: 'wait', handoff: ID });
  test('claims once with the waiting id, shows the draft, and takes ?h= out of the bar', async () => {
    const r = rig({}, waiting());
    await r.ctl.onShow();
    expect(r.calls).toEqual([{ fn: 'claim', args: [ID] }]);
    expect(r.state.phase).toBe('ready');
    expect(r.writes).toEqual(['/draft?prompt=watch+xlm']);
  });
  test('BUG 1b: ?h= leaves the bar even when the claim throws or fails', async () => {
    const thrown = rig({ claim: async () => { throw new Error('boom'); } }, waiting());
    await thrown.ctl.onShow();
    expect(thrown.state.phase).toBe('failed');
    expect(thrown.writes).toHaveLength(1);
    const spent = rig({ claim: async () => ({ ok: false, kind: 'failed', message: copy.errors.status404 }) }, waiting());
    await spent.ctl.onShow();
    expect(spent.state).toMatchObject({ phase: 'failed', message: copy.errors.status404 });
    expect(spent.writes).toHaveLength(1);
  });
  test('without a waiting id nothing is called', async () => {
    const r = rig();
    await r.ctl.onShow();
    expect(r.calls).toEqual([]);
  });
  test('BUG 1: claiming does not overwrite the draft this tab already stored', async () => {
    const store = mem();
    saveStored({ prompt: 'watch xlm', draft: sampleDraft() }, store);
    let release: (v: ActionResult<{ draft: unknown }>) => void = () => {};
    const r = rig({ claim: () => new Promise((res) => (release = res)) }, waiting());
    // Mimic the screen's save effect after every state change, against the real rule.
    const saveIfAllowed = () => {
      if (shouldSave(r.state)) saveStored({ prompt: r.state.prompt, draft: r.state.draft }, store);
    };
    const claiming = r.ctl.onShow();
    saveIfAllowed(); // the state right after dispatch({t:'drafting', prompt:''})
    expect(r.state.phase).toBe('drafting');
    expect(loadStored(store)?.draft?.name).toBe('XLM watcher');
    release(ok({ draft: sampleDraft({ name: 'claimed' }) as unknown }));
    await claiming;
    saveIfAllowed();
    expect(loadStored(store)?.draft?.name).toBe('claimed');
  });
});

describe('the other handlers', () => {
  test('retry drafts the stored prompt again; start over clears this tab and goes home', async () => {
    const r = rig({}, draftReducer(draftReducer(initialState, { t: 'drafting', prompt: 'watch xlm' }), { t: 'draft-failed', kind: 'failed', message: 'x' }));
    await r.ctl.onRetry();
    expect(r.calls).toEqual([{ fn: 'draft', args: ['watch xlm'] }]);
    expect(r.state.phase).toBe('ready');
    r.store.setItem(STORAGE_KEY, '{}');
    r.ctl.onStartOver();
    expect(r.store.getItem(STORAGE_KEY)).toBeNull();
    expect(r.replaced).toEqual(['/']);
  });
  test('a draft that comes back malformed is a plain failure, not a crash', async () => {
    const r = rig({ draft: async () => ok({ draft: { nope: 1 } as unknown }) });
    await r.ctl.runDraft('x');
    expect(r.state).toMatchObject({ phase: 'failed', message: copy.errors.builderFailed });
  });
  test('rename, spec patch and create go straight to the state', () => {
    const r = rig({}, readyState());
    r.ctl.onRename('Mine');
    r.ctl.onSpec({ persona: 'P' });
    r.ctl.onCreate();
    expect(r.state.draft?.name).toBe('Mine');
    expect(r.state.draft?.spec.persona).toBe('P');
    expect(r.state.creating).toBe(true);
  });
});

describe('shouldSave', () => {
  test('saves ready, limit, failed and a drafting state that has a prompt; never a claim in flight or boot', () => {
    expect(shouldSave(readyState())).toBe(true);
    expect(shouldSave(draftReducer(initialState, { t: 'drafting', prompt: 'x' }))).toBe(true);
    expect(shouldSave(draftReducer(initialState, { t: 'drafting', prompt: '' }))).toBe(false);
    expect(shouldSave(initialState)).toBe(false);
    expect(shouldSave(draftReducer(initialState, { t: 'wait', handoff: ID }))).toBe(false);
    expect(shouldSave(draftReducer(draftReducer(initialState, { t: 'drafting', prompt: 'x' }), { t: 'draft-failed', kind: 'sign_in', message: 'm' }))).toBe(true);
  });
});

describe('the trial server action logs only the matched word', () => {
  const api = (trial: unknown) => async () => ({ status: 200, json: { trial } });
  test('logs one entry per hidden line with the word and nothing else', async () => {
    const entries: unknown[] = [];
    const a = createBuilderActions({ api: api({ status: 'done', text: 'The trigger condition holds for my private note.', wouldHave: [{ kind: 'email', summary: 'All fine' }, { kind: 'hire', summary: 'ask about a service' }] }) as never, token: async () => 't', log: (e) => void entries.push(e) });
    const r = await a.trial({ any: 1 });
    expect(r.ok).toBe(true);
    for (const e of entries) expect(Object.keys(e as object).sort()).toEqual(['event', 'word']);
    expect(entries.length).toBe(2);
    expect(JSON.stringify(entries)).not.toMatch(/private note|ask about/);
    expect(entries.every((e) => (e as { event: string }).event === 'trial_words')).toBe(true);
  });
  test('a hidden address is logged as "address", never the address itself', async () => {
    const entries: unknown[] = [];
    const g = 'G' + 'A'.repeat(55);
    const a = createBuilderActions({ api: api({ status: 'done', text: `I would pay ${g} now.`, wouldHave: [] }) as never, token: async () => 't', log: (e) => void entries.push(e) });
    await a.trial({});
    expect(entries).toEqual([{ event: 'trial_words', word: 'address' }]);
    expect(JSON.stringify(entries)).not.toContain(g);
  });
  test('plain text logs nothing, a failed call logs nothing, and a throwing logger never breaks the trial', async () => {
    const entries: unknown[] = [];
    const plain = createBuilderActions({ api: api({ status: 'done', text: 'All quiet', wouldHave: [] }) as never, token: async () => 't', log: (e) => void entries.push(e) });
    await plain.trial({});
    const failed = createBuilderActions({ api: (async () => ({ status: 500, json: null })) as never, token: async () => 't', log: (e) => void entries.push(e) });
    expect((await failed.trial({})).ok).toBe(false);
    expect(entries).toEqual([]);
    const noisy = createBuilderActions({ api: api({ status: 'done', text: 'the token', wouldHave: [] }) as never, token: async () => 't', log: () => { throw new Error('log down'); } });
    expect((await noisy.trial({})).ok).toBe(true);
  });
});
