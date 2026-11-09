import { describe, expect, test } from 'bun:test';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { paramDisplay as apiParamDisplay, renderSentence as apiRenderSentence } from '../../api/src/builder/draft-schema';
import { Advanced } from '../src/components/advanced';
import { DraftFlowView } from '../src/components/draft-flow';
import { applyEdit, DraftSentence, submitEdit, timeFrom } from '../src/components/draft-sentence';
import { FlowSteps } from '../src/components/flow-steps';
import { copy } from '../src/copy';
import { currentNumber, highlightText, paramDisplay, pillAndRest, parseNumber, parseText, plainText, rangeText, renderSentence, shortenAddresses, stepFrom, stepNumber, withUnit } from '../src/lib/draft-display';
import { isUnfinishedAgent } from '../src/lib/draft-state';
import {
  canCallTrial,
  draftReducer,
  initialState,
  loadStored,
  patchSpec,
  planBoot,
  readDraftParams,
  saveStored,
  STORAGE_KEY,
  stripParams,
  urlWithout,
  type DraftState,
} from '../src/lib/draft-state';
import { asDraft, asTrial, type ParamSpec, type TrialData } from '../src/lib/draft-types';
import { createBuilderActions } from '../src/server/builder-actions';
import { bannedWord } from '../src/lib/words';
import { G, sampleDraft } from './support/draft';
import { stripAdvanced, textOf } from './support/screens';

const ready = (d = sampleDraft()): DraftState => draftReducer(draftReducer(initialState, { t: 'drafting', prompt: 'watch xlm' }), { t: 'drafted', draft: d });
const tDone = (s: DraftState, result: TrialData): DraftState => draftReducer(s, { t: 'trial-done', spec: s.draft!.spec, result });
const tFail = (s: DraftState, kind: 'sign_in' | 'failed', message: string): DraftState => draftReducer(s, { t: 'trial-failed', spec: s.draft!.spec, kind, message });
const view = (state: DraftState, signedIn = false) => renderToStaticMarkup(createElement(DraftFlowView, { state, signedIn }));

describe('the sentence', () => {
  test('renders one tappable highlight per parameter, in order', () => {
    const html = renderToStaticMarkup(createElement(DraftSentence, { draft: sampleDraft() }));
    const ids = [...html.matchAll(/<button[^>]*data-param="([a-z_]+)"/g)].map((m) => m[1]);
    expect(ids).toEqual(['every', 'drop', 'how']);
    expect(textOf(html)).toContain('5 minutes');
    expect(textOf(html)).toContain('5%');
    expect(html).toContain('break-words');
  });
  test('a segmented choice is one labelled group, not two nested groups with the same label', () => {
    const options = [{ label: 'Often', value: 1 }, { label: 'Rarely', value: 2 }];
    const d = sampleDraft({ params: [{ id: 'every', label: 'How often', kind: 'choice', options, value: 1 }, ...sampleDraft().params.slice(1)] });
    const html = renderToStaticMarkup(createElement(DraftSentence, { draft: d, initialOpen: 'every' }));
    expect(html).toContain('data-segmented');
    const labelled = [...html.matchAll(/<[^>]*role="group"[^>]*>/g)].map((m) => m[0]).filter((t) => t.includes('aria-label="How often"'));
    expect(labelled).toHaveLength(1);
    // A list of radios has no group of its own, so the outer one keeps its label.
    const five = sampleDraft({ params: [{ id: 'every', label: 'How often', kind: 'choice', options: [1, 2, 3, 4, 5].map((n) => ({ label: `O${n}`, value: n })), value: 1 }, ...sampleDraft().params.slice(1)] });
    const list = renderToStaticMarkup(createElement(DraftSentence, { draft: five, initialOpen: 'every' }));
    expect([...list.matchAll(/<[^>]*role="group"[^>]*aria-label="How often"[^>]*>/g)]).toHaveLength(1);
  });
  test('an open number editor has min, max and the current value; a choice is a segmented group (pressed buttons); no editor by default', () => {
    expect(renderToStaticMarkup(createElement(DraftSentence, { draft: sampleDraft() }))).not.toContain('data-editor');
    const num = renderToStaticMarkup(createElement(DraftSentence, { draft: sampleDraft(), initialOpen: 'drop' }));
    expect(num).toContain('type="number"');
    expect(num).toContain('min="1"');
    expect(num).toContain('max="50"');
    const choice = renderToStaticMarkup(createElement(DraftSentence, { draft: sampleDraft(), initialOpen: 'every' }));
    expect(choice).toContain('role="group"');
    expect(choice.match(/aria-pressed="/g)).toHaveLength(2);
    expect(choice).not.toContain('role="radio');
    expect(renderToStaticMarkup(createElement(DraftSentence, { draft: sampleDraft(), initialOpen: 'how' }))).toContain('type="text"');
  });
  test('a refused edit shows its plain message under the sentence, with the old value still in place', () => {
    const html = renderToStaticMarkup(createElement(DraftSentence, { draft: sampleDraft(), message: copy.errors.badEdit }));
    expect(textOf(html)).toContain(copy.errors.badEdit);
    expect(textOf(html)).toContain('5%');
  });
  test('typed values are checked before the api is asked', () => {
    const p = { min: 1, max: 50 };
    expect(parseNumber('5', p)).toBe(5);
    expect(parseNumber('2.5', p)).toBe(2.5);
    for (const bad of ['', ' ', 'abc', '0', '51', 'Infinity', 'NaN']) expect(parseNumber(bad, p)).toBeNull();
    expect(parseText('  hi ')).toBe('hi');
    expect(parseText('  ')).toBeNull();
    expect(parseText('x'.repeat(101))).toBeNull();
  });
  test('units: a symbol hugs the number, a word gets a space', () => {
    expect(withUnit('5', '%')).toBe('5%');
    expect(withUnit('3', 'hours')).toBe('3 hours');
    expect(withUnit('3', undefined)).toBe('3');
  });
  test('the unit shows once when the sentence already writes it after the value', () => {
    const drop = { id: 'drop', label: 'Drop', kind: 'number' as const, value: 5, min: 1, max: 50, unit: '%' };
    const hours = { id: 'h', label: 'Hours', kind: 'number' as const, value: 3, min: 1, max: 24, unit: 'hours' };
    const d = sampleDraft({ sentence: ['Email me if XLM falls ', { param: 'drop' }, '% or more within ', { param: 'h' }, ' hours.'], params: [drop, hours] });
    const html = renderToStaticMarkup(createElement(DraftSentence, { draft: d }));
    const text = html.replace(/<[^>]+>/g, '');
    expect(text).toBe('Email me if XLM falls 5% or more within 3 hours.');
    expect(highlightText(drop, '% or more')).toBe('5');
    expect(highlightText(hours, ' hours.')).toBe('3');
    expect(highlightText(hours, ' hourses')).toBe('3 hours');
    expect(highlightText(drop, ' or more')).toBe('5%');
    expect(highlightText(drop)).toBe('5%');
  });
  test('a unit the sentence writes moves into the pill, and the text after it starts past the unit', () => {
    const drop = { id: 'drop', label: 'Drop', kind: 'number' as const, value: 5, min: 1, max: 50, unit: '%' };
    const hours = { id: 'h', label: 'Hours', kind: 'number' as const, value: 3, min: 1, max: 24, unit: 'hours' };
    expect(pillAndRest(drop, '% or more within ')).toEqual({ pill: '5%', rest: ' or more within ' });
    expect(pillAndRest(hours, ' Hours.')).toEqual({ pill: '3 Hours', rest: '.' });
    expect(pillAndRest(hours, ' hourses')).toEqual({ pill: '3 hours', rest: ' hourses' });
    expect(pillAndRest(drop, ' or more')).toEqual({ pill: '5%', rest: ' or more' });
    const d = sampleDraft({ sentence: ['Email me if XLM falls ', { param: 'drop' }, '% or more within ', { param: 'h' }, ' hours.'], params: [drop, hours] });
    const html = renderToStaticMarkup(createElement(DraftSentence, { draft: d }));
    expect(html).toMatch(/data-param="drop"[^>]*>5%<\/button><span> or more within <\/span>/);
    expect(html).toMatch(/data-param="h"[^>]*>3 hours<\/button><span>\.<\/span>/);
    expect(html.replace(/<[^>]+>/g, '')).toBe('Email me if XLM falls 5% or more within 3 hours.');
  });
});

describe('editing through the reducer', () => {
  test('editing the threshold replaces the draft with the one the api returned and clears any old trial', () => {
    const s0 = tDone(ready(), { status: 'done', condition: null, text: 't', wouldHave: [], steps: [] });
    expect(s0.trial.status).toBe('done');
    const edited = sampleDraft({ params: sampleDraft().params.map((p) => (p.id === 'drop' ? ({ ...p, value: 8 } as ParamSpec) : p)) });
    const s1 = draftReducer(draftReducer(s0, { t: 'edit-start' }), { t: 'edit-done', draft: edited });
    expect(s1.edit.busy).toBe(false);
    expect(s1.trial.status).toBe('idle');
    expect(textOf(renderToStaticMarkup(createElement(DraftSentence, { draft: s1.draft! })))).toContain('8%');
  });
  test('a refused edit keeps the draft and shows a plain message', () => {
    const s0 = ready();
    const s1 = draftReducer(draftReducer(s0, { t: 'edit-start' }), { t: 'edit-failed', message: copy.errors.badEdit, signIn: false });
    expect(s1.draft).toBe(s0.draft);
    expect(s1.edit).toEqual({ busy: false, message: copy.errors.badEdit, signIn: false });
    expect(textOf(view(s1))).toContain(copy.errors.badEdit);
  });
  test('the name is editable; the advanced fields patch the description and reset the trial', () => {
    const s = draftReducer(ready(), { t: 'rename', name: 'Mine' });
    expect(s.draft!.name).toBe('Mine');
    const p = patchSpec(s.draft!, { skill: 0, body: 'New body' });
    expect(p.spec.skills[0]!.body).toBe('New body');
    expect(p.spec.persona).toBe('I am calm.');
    expect(patchSpec(s.draft!, { persona: 'P' }).spec.persona).toBe('P');
    expect(patchSpec(s.draft!, { system_prompt: 'S' }).spec.system_prompt).toBe('S');
    const t = draftReducer(tDone(s, { status: 'done', condition: null, text: '', wouldHave: [], steps: [] }), { t: 'spec', patch: { persona: 'x' } });
    expect(t.trial.status).toBe('idle');
  });
});

describe('limits and failures', () => {
  test('the draft limit shows "Sign in to keep drafting" and the sign-in form, not an error', () => {
    const s = draftReducer(draftReducer(initialState, { t: 'drafting', prompt: 'x' }), { t: 'draft-failed', kind: 'sign_in', message: copy.errors.signInToKeepDrafting });
    expect(s.phase).toBe('limit');
    const html = view(s);
    expect(textOf(html)).toContain('Sign in to keep drafting');
    expect(html).toContain('type="email"');
    expect(html).not.toContain('role="alert"');
  });
  test('the daily limit is a plain sentence without a retry button', () => {
    const s = draftReducer(draftReducer(initialState, { t: 'drafting', prompt: 'x' }), { t: 'draft-failed', kind: 'daily', message: copy.errors.dailyLimit });
    expect(textOf(view(s))).toContain(copy.errors.dailyLimit);
    expect(view(s)).not.toContain(copy.draft.tryAgain);
  });
  test('a failed draft says it plainly and offers Try again', () => {
    const s = draftReducer(draftReducer(initialState, { t: 'drafting', prompt: 'x' }), { t: 'draft-failed', kind: 'failed', message: copy.errors.status5xx });
    const html = view(s);
    expect(s.phase).toBe('failed');
    expect(textOf(html)).toContain(copy.errors.status5xx);
    expect(html).toContain(copy.draft.tryAgain);
  });
  test('drafting shows a plain progress line', () => {
    expect(textOf(view(draftReducer(initialState, { t: 'drafting', prompt: 'x' })))).toContain(copy.draft.drafting);
  });
  test('drafting shows the user\'s own words in quotes and a progress bar', () => {
    const html = view(draftReducer(initialState, { t: 'drafting', prompt: 'tell me when XLM falls' }));
    expect(textOf(html)).toContain('You asked');
    expect(textOf(html)).toContain('"tell me when XLM falls"');
    expect(html).toContain('data-progress');
    expect(html).toContain('data-step="describe"');
  });
  test('limit and failed are the same card with one primary action', () => {
    const f = view(draftReducer(draftReducer(initialState, { t: 'drafting', prompt: 'x' }), { t: 'draft-failed', kind: 'failed', message: copy.errors.status5xx }));
    expect(f).toContain('data-card');
    expect(f.match(/data-variant="primary"/g)).toHaveLength(1);
    const daily = view(draftReducer(draftReducer(initialState, { t: 'drafting', prompt: 'x' }), { t: 'draft-failed', kind: 'daily', message: copy.errors.dailyLimit }));
    expect(daily).toContain('data-card');
    expect(daily).not.toContain('data-variant="primary"');
    const l = view(draftReducer(draftReducer(initialState, { t: 'drafting', prompt: 'x' }), { t: 'draft-failed', kind: 'sign_in', message: 'm' }));
    expect(l).toContain('data-card');
  });
});

describe('Try it now', () => {
  const trial: TrialData = {
    status: 'done',
    condition: { held: false, data: '' },
    text: `XLM is steady. I would write to ${G}.`,
    wouldHave: [
      { kind: 'email', summary: 'Subject: XLM steady' },
      { kind: 'hire', summary: 'Ask a helper about a service token' },
      { kind: 'webhook', summary: `POST for ${G}` },
    ],
    steps: [{ n: 1, tools: ['stellar_price'] }],
  };
  const withTrial = (t: TrialData) => tDone(draftReducer(ready(), { t: 'trial-start' }), t);

  test('shows the would-have lines and never an address or a technical word', () => {
    const html = view(withTrial(trial));
    const text = textOf(html);
    expect(text).toContain('Tried just now');
    expect(text).toContain(copy.draft.trial.quiet);
    expect(text).toContain(copy.draft.trial.preview);
    expect(text).toContain(copy.draft.trial.howTitle);
    expect(text).toContain(copy.draft.trial.email);
    expect(text).toContain(copy.draft.trial.webhook);
    expect(text).toContain(copy.draft.trial.hire);
    expect(text).toContain('Subject: XLM steady');
    expect(bannedWord(textOf(stripAdvanced(html)))).toBeNull();
    expect(text).not.toContain(G);
    expect(text).toContain('GABC…WXYZ');
  });
  test('a held condition says it would get my attention', () => {
    expect(textOf(view(withTrial({ ...trial, condition: { held: true, data: '' } })))).toContain(copy.draft.trial.attention);
  });
  test('words the api should not have used are kept off the screen', () => {
    const html = view(withTrial({ ...trial, text: 'The trigger condition holds.' }));
    const text = textOf(stripAdvanced(html));
    expect(text).toContain(copy.draft.trial.hidden);
    expect(text).not.toContain('trigger');
    expect(bannedWord(text)).toBeNull();
  });
  test('the hidden words are not lost: the original sits inside a closed Advanced disclosure', () => {
    const html = view(withTrial({ ...trial, text: 'The trigger condition holds.' }));
    const m = /<details data-advanced=""[^>]*>(?:(?!<\/details>)[\s\S])*The trigger condition holds\.[\s\S]*?<\/details>/.exec(html);
    expect(m).not.toBeNull();
    expect(m![0]).not.toMatch(/^<details[^>]*\sopen/);
    // the hire line's technical summary is kept the same way
    expect(textOf(html)).toContain('Ask a helper about a service token');
    expect(textOf(stripAdvanced(html))).not.toContain('service token');
  });
  test.each(['error', 'budget'] as const)('a trial that ended in %s says so plainly and never "Nothing to send"', (status) => {
    const html = view(withTrial({ status, condition: null, text: '', wouldHave: [{ kind: 'email', summary: 'Subject: half done' }], steps: [] }));
    const text = textOf(html);
    expect(text).toContain(copy.draft.trial.failed);
    expect(copy.draft.trial.failed).toBe("I couldn't finish trying this just now. Try again.");
    expect(text).not.toContain(copy.draft.trial.empty);
    expect(text).not.toContain(copy.draft.trial.preview);
    expect(text).not.toContain(copy.draft.trial.quiet);
    // an unfinished run lists no steps: the plain failure line stands alone
    expect(text).not.toContain('Subject: half done');
    expect(html).not.toContain('role="alert"');
  });
  test('a finished trial that sent nothing still says "Nothing to send"', () => {
    expect(textOf(view(withTrial({ ...trial, text: '', condition: null, wouldHave: [], steps: [] })))).toContain(copy.draft.trial.empty);
  });
  test('asTrial keeps the status and drops would-have lines of an unknown kind', () => {
    const t = asTrial({ status: 'error', text: '', condition: null, wouldHave: [{ kind: 'email', summary: 'a' }, { kind: 'nuke', summary: 'b' }] });
    expect(t?.status).toBe('error');
    expect(t?.wouldHave).toEqual([{ kind: 'email', summary: 'a' }]);
  });
  test('a second Try it now in the same limit state shows sign in and does not call the api', () => {
    const limited = tFail(draftReducer(ready(), { t: 'trial-start' }), 'sign_in', copy.errors.signInToKeepDrafting);
    expect(limited.trial.status).toBe('limit');
    expect(canCallTrial(limited)).toBe(false);
    const again = draftReducer(limited, { t: 'trial-start' });
    expect(again.trial.status).toBe('limit');
    const html = view(again);
    expect(textOf(html)).toContain('Sign in to keep drafting');
    expect(html).toContain('type="email"');
  });
  test('one run at a time, and a failed run can be tried again', () => {
    const running = draftReducer(ready(), { t: 'trial-start' });
    expect(canCallTrial(running)).toBe(false);
    const failed = tFail(running, 'failed', copy.errors.status5xx);
    expect(canCallTrial(failed)).toBe(true);
    expect(textOf(view(failed))).toContain(copy.errors.status5xx);
    expect(textOf(view(failed))).toContain(copy.draft.tryAgain);
    expect(textOf(view(failed))).not.toContain(copy.draft.tryNote);
    expect(textOf(view(withTrial(trial)))).toContain(copy.draft.tryNote);
  });
});

describe('sign-in cards carry what they need', () => {
  test('the limit card and the ready cards hand the prompt to SignInCard; the waiting card hands the handoff id', async () => {
    const { readFileSync } = await import('node:fs');
    const src = readFileSync(new URL('../src/components/draft-flow.tsx', import.meta.url), 'utf8');
    expect(src).toContain('<SignInCard prompt={state.prompt} />');
    expect(src.match(/<SignInCard draft=\{d\} prompt=\{state\.prompt\} \/>/g)).toHaveLength(1);
    expect(src).toContain('<SignInCard draft={d} prompt={state.prompt} create={{ name: d.name, onBack: on.onBack }} />');
    expect(src).toContain('handoff: state.handoff');
  });
  test('the limit card keeps its honest note only when there is a prompt to bring back', () => {
    const limited = draftReducer(draftReducer(initialState, { t: 'drafting', prompt: 'watch xlm' }), { t: 'draft-failed', kind: 'sign_in', message: 'm' });
    expect(textOf(view(limited))).toContain(copy.draft.kept);
    expect(copy.draft.kept).toBe('We will bring back what you typed after you sign in.');
  });
  test('a waiting draft asks a signed-out visitor to sign in instead of claiming it', () => {
    const w = draftReducer(initialState, { t: 'wait', handoff: 'a'.repeat(22) });
    const out = view(w, false);
    expect(out).toContain('type="email"');
    expect(out).not.toContain(copy.draft.showDraft);
    expect(textOf(out)).not.toContain('You are signed in');
    expect(view(w, true)).toContain(copy.draft.showDraft);
  });
});

describe('mobile action bar', () => {
  test('comes before the details in the DOM, and the spacer after them', () => {
    const out = view(ready());
    const bar = out.indexOf('data-sticky');
    const details = out.indexOf('data-advanced');
    expect(bar).toBeGreaterThan(-1);
    expect(details).toBeGreaterThan(bar);
    expect(out.indexOf('safe-area-inset-bottom))] sm:hidden')).toBeGreaterThan(details);
  });
});

describe('Create this agent, signed out: the card becomes the sign-in', () => {
  const creating = () => draftReducer(ready(), { t: 'create' });
  test('replaces the whole body: eyebrow, "First, your email", the line, the field, the way back', () => {
    const out = renderToStaticMarkup(createElement(DraftFlowView, { state: creating(), signedIn: false, on: { onBack: () => {} } }));
    const t = textOf(out);
    expect(t).toContain(`Create ${sampleDraft().name}`);
    expect(t).toContain('First, your email');
    expect(t).toContain('We send you a link. Open it and you are back on your draft. Press Create, then approve three times with your screen lock.');
    expect(out).toContain('type="email"');
    expect(t).toContain('Back to my draft');
    expect(out).not.toContain('data-param');
    expect(t).not.toContain(copy.draft.tryFirst);
    expect(t).not.toContain(copy.draft.create);
    expect(out).not.toContain('data-sticky');
    expect(out).not.toContain('data-advanced');
    expect(bannedWord(textOf(stripAdvanced(out)))).toBeNull();
  });
  test('"Back to my draft" is wired to the back handler', async () => {
    const { readFileSync } = await import('node:fs');
    const src = readFileSync(new URL('../src/components/draft-flow.tsx', import.meta.url), 'utf8');
    expect(src).toContain('onBack: ctl.onBack');
    expect(src).toContain('onBack: on.onBack');
    expect(draftReducer(creating(), { t: 'back' }).creating).toBe(false);
  });
  test('signed in nothing changes: creation starts, no email step', () => {
    const inn = view(creating(), true);
    expect(inn).toContain('data-create="flow"');
    expect(textOf(inn)).not.toContain('First, your email');
  });
  test('an owner at the agent limit never sees it', () => {
    const out = renderToStaticMarkup(createElement(DraftFlowView, { state: creating(), signedIn: false, full: true }));
    expect(textOf(out)).not.toContain('First, your email');
  });
});

describe('landing from a link never starts creating', () => {
  const asked = () => draftReducer(initialState, { t: 'resumed', prompt: '', draft: sampleDraft(), ask: true });
  test('one plain line above the actions, Create is the single primary, no creation flow', () => {
    const out = view(asked(), true);
    expect(textOf(out)).toContain("You're signed in. Read the draft above, and press Create this agent only if it's what you want.");
    expect(out).not.toContain('data-create=');
    expect(out).toContain(copy.draft.create);
    expect(bannedWord(textOf(stripAdvanced(out)))).toBeNull();
  });
  test('the line shows only signed in, and goes once creation starts', () => {
    expect(textOf(view(asked(), false))).not.toContain('Press Create this agent');
    expect(textOf(view(draftReducer(asked(), { t: 'create' }), true))).not.toContain('Press Create this agent');
    expect(draftReducer(asked(), { t: 'create' }).creating).toBe(true);
  });
});

describe('opening a parked draft', () => {
  test('a claim in progress says so in plain words, with no empty quote', () => {
    const s = draftReducer(initialState, { t: 'drafting', prompt: '' });
    const t = textOf(view(s, true));
    expect(t).toContain('Opening your draft');
    expect(t).not.toContain('""');
    expect(t).not.toContain(copy.draft.youAsked);
  });
  test('a drafting prompt still shows what was asked', () => {
    expect(textOf(view(draftReducer(initialState, { t: 'drafting', prompt: 'watch xlm' }), true))).toContain(copy.draft.youAsked);
  });
  test('?intent= counts only when it is exactly "create" and single', () => {
    expect(readDraftParams({ intent: 'create' })).toEqual({ intent: 'create' });
    expect(readDraftParams({ intent: ['create', 'x'] })).toEqual({});
    expect(readDraftParams({ intent: ['create', 'create'] })).toEqual({});
    expect(readDraftParams({ intent: 'Create' })).toEqual({});
    expect(readDraftParams({ intent: 'other' })).toEqual({});
    expect(readDraftParams({ h: 'abcdefghijklmnopqrstuv', intent: 'create' })).toEqual({ handoff: 'abcdefghijklmnopqrstuv', intent: 'create' });
  });
});

describe('Create this agent', () => {
  test('signed out it is a sign-in prompt; signed in it starts the creation', () => {
    const s = draftReducer(ready(), { t: 'create' });
    const out = view(s, false);
    expect(out).toContain('data-create="sign-in"');
    expect(out).toContain('type="email"');
    expect(out).not.toContain('data-create="flow"');
    const inn = view(s, true);
    expect(inn).toContain('data-create="flow"');
    expect(inn).not.toContain('type="email"');
  });
  test('before it is pressed neither shows, only the note; an empty name cannot be created', () => {
    const html = view(ready());
    expect(html).not.toContain('data-create=');
    expect(textOf(html)).toContain(copy.draft.fineSignedOut);
    expect(view(draftReducer(ready(), { t: 'rename', name: '' }))).toMatch(/<button[^>]*disabled[^>]*>Create this agent/);
  });
  test('a name with a technical word says so in plain words and cannot be created, however the press arrives', () => {
    for (const name of ['Token watcher', 'Price service', 'My tx tracker']) {
      const renamed = draftReducer(ready(), { t: 'rename', name });
      const html = view(renamed);
      expect(html).toMatch(/<p[^>]*role="alert"[^>]*data-name-error[^>]*>/);
      expect(textOf(stripAdvanced(html))).toContain(copy.draft.nameTooTechnical);
      expect(html).toMatch(/<button[^>]*\sdisabled=""[^>]*>Create this agent/);
      // Even a press that gets past the disabled button does not start creating.
      expect(draftReducer(renamed, { t: 'create' }).creating).toBe(false);
    }
    expect(bannedWord(copy.draft.nameTooTechnical)).toBeNull();
    const fine = view(draftReducer(ready(), { t: 'rename', name: 'XLM watcher' }));
    expect(fine).not.toContain('data-name-error');
    expect(fine).not.toMatch(/<button[^>]*\sdisabled=""[^>]*>Create this agent/);
  });
  test('a provided creation flow replaces the real one', () => {
    const html = renderToStaticMarkup(createElement(DraftFlowView, { state: draftReducer(ready(), { t: 'create' }), signedIn: true, createFlow: () => createElement('p', null, 'REAL FLOW') }));
    expect(html).toContain('REAL FLOW');
    expect(html).not.toContain('data-create="flow"');
  });
  test('while creating, the card holds only the creation view: no sentence, Try, Advanced, New idea or rename', () => {
    const html = renderToStaticMarkup(createElement(DraftFlowView, { state: draftReducer(ready(), { t: 'create' }), signedIn: true }));
    expect(html).toContain('data-create="flow"');
    expect(html).toContain(`Creating ${sampleDraft().name}`);
    expect(html).not.toContain('data-sticky');
    expect(html).not.toContain('data-actions');
    const t = textOf(html);
    for (const gone of [copy.draft.tryFirst, copy.draft.newIdea, copy.draft.rename, copy.draft.create, copy.draft.caption, 'Advanced']) expect(t).not.toContain(gone);
  });
  test('an owner at the agent limit sees "Add this to your agent", never "Create this agent"', () => {
    const s = draftReducer(ready(), { t: 'create' });
    const html = renderToStaticMarkup(createElement(DraftFlowView, { state: s, signedIn: true, full: true }));
    expect(textOf(html)).toContain(copy.draft.addToAgent);
    expect(textOf(html)).not.toContain(copy.draft.create);
    expect(html).not.toContain('data-create=');
    // The link carries the draft's prompt, so the revise route (Task 18) can turn it into a new description.
    expect(html).toContain('href="/dashboard?prompt=watch%20xlm"');
  });
});

describe('Advanced', () => {
  test('is closed by default and its text lives inside data-advanced', () => {
    const html = renderToStaticMarkup(createElement(Advanced, { draft: sampleDraft() }));
    expect(html).toContain('data-advanced=""');
    expect(html).toMatch(/<div[^>]*data-advanced=""[^>]*\shidden/);
    expect(html).not.toContain('<details');
    expect(html).toMatch(/<button[^>]*aria-expanded="false"[^>]*>Edit the details/);
    expect(textOf(stripAdvanced(html))).not.toContain('Watch the price.');
    expect(html).toContain('Watch the price.');
    expect(html).toContain('Write a digest.');
    const whole = view(ready());
    expect(whole.indexOf('Watch the price.')).toBeGreaterThan(whole.indexOf('data-advanced'));
    expect(whole.match(/<textarea/g)).toHaveLength(3);
  });
});

describe('the address bar, this tab, and first load', () => {
  test('?prompt= is removed from the URL after reading, other parts kept', () => {
    const calls: unknown[][] = [];
    const w = { location: { href: 'https://agentenact.io/draft?prompt=watch%20xlm&x=1#top' }, history: { state: { n: 1 }, replaceState: (...a: unknown[]) => void calls.push(a) } };
    stripParams(w, ['prompt']);
    expect(calls).toEqual([[{ n: 1 }, '', '/draft?x=1#top']]);
    expect(urlWithout('/draft?prompt=a&h=b', ['prompt'])).toBe('/draft?h=b');
  });
  test('nothing to strip means no history write; a locked-down history does not throw', () => {
    const calls: unknown[][] = [];
    stripParams({ location: { href: 'https://x.test/draft' }, history: { state: null, replaceState: (...a: unknown[]) => void calls.push(a) } }, ['prompt']);
    expect(calls).toEqual([]);
    expect(() => stripParams({ location: { href: '/draft?prompt=a' }, history: { state: null, replaceState: () => { throw new Error('locked'); } } }, ['prompt'])).not.toThrow();
  });
  const mem = () => {
    const m = new Map<string, string>();
    return { getItem: (k: string) => m.get(k) ?? null, setItem: (k: string, v: string) => void m.set(k, v), removeItem: (k: string) => void m.delete(k), m };
  };
  test('a reload keeps the draft from sessionStorage', () => {
    const store = mem();
    saveStored({ prompt: 'watch xlm', draft: sampleDraft() }, store);
    const stored = loadStored(store);
    expect(stored?.draft?.name).toBe('XLM watcher');
    expect(planBoot({ stored })).toEqual({ kind: 'resume', prompt: 'watch xlm', draft: stored!.draft! });
  });
  test('no sessionStorage still works', () => {
    const broken = { getItem: () => { throw new Error('blocked'); }, setItem: () => { throw new Error('blocked'); }, removeItem: () => { throw new Error('blocked'); } };
    expect(loadStored(broken)).toBeNull();
    expect(() => saveStored({ prompt: 'x', draft: null }, broken)).not.toThrow();
    expect(planBoot({ prompt: 'watch xlm', stored: loadStored(broken) })).toEqual({ kind: 'draft', prompt: 'watch xlm' });
  });
  test('a corrupt entry is ignored', () => {
    const store = mem();
    store.setItem(STORAGE_KEY, '{nope');
    expect(loadStored(store)).toBeNull();
    store.setItem(STORAGE_KEY, JSON.stringify({ prompt: 'p', draft: { name: 5 } }));
    expect(loadStored(store)).toEqual({ prompt: 'p', draft: null });
  });
  test('only sessionStorage is used, never localStorage', async () => {
    const { readFileSync, readdirSync } = await import('node:fs');
    for (const f of ['lib/draft-state.ts', 'components/draft-flow.tsx', 'components/draft-sentence.tsx', 'components/trial-panel.tsx', 'components/advanced.tsx'])
      expect(readFileSync(new URL(`../src/${f}`, import.meta.url), 'utf8')).not.toMatch(/localStorage|indexedDB/);
    expect(readdirSync(new URL('../src/components', import.meta.url)).length).toBeGreaterThan(5);
  });
  test('boot plans: a handoff wins; a fresh prompt drafts; the same prompt resumes; a prompt-less empty tab leaves', () => {
    const d = sampleDraft();
    expect(planBoot({ handoff: 'a'.repeat(22), prompt: 'p', stored: { prompt: 'p', draft: d } })).toEqual({ kind: 'handoff', id: 'a'.repeat(22) });
    expect(planBoot({ prompt: 'new', stored: { prompt: 'old', draft: d } })).toEqual({ kind: 'draft', prompt: 'new' });
    expect(planBoot({ prompt: 'old', stored: { prompt: 'old', draft: d } }).kind).toBe('resume');
    expect(planBoot({ stored: { prompt: 'interrupted', draft: null } })).toEqual({ kind: 'draft', prompt: 'interrupted' });
    expect(planBoot({ stored: null })).toEqual({ kind: 'empty' });
  });
  test('the page reads ?prompt= (clamped) and only a well-formed ?h=', () => {
    expect(readDraftParams({ prompt: '  hi  ' })).toEqual({ prompt: 'hi' });
    expect(readDraftParams({ prompt: 'a'.repeat(600) }).prompt).toHaveLength(500);
    expect(readDraftParams({ prompt: ['a', 'b'] })).toEqual({ prompt: 'a' });
    expect(readDraftParams({ h: 'short' })).toEqual({});
    expect(readDraftParams({ h: 'abcdefghijklmnopqrstuv' })).toEqual({ handoff: 'abcdefghijklmnopqrstuv' });
    expect(readDraftParams({ h: '../../etc/passwd/xxxxxx' })).toEqual({});
    expect(readDraftParams({})).toEqual({});
  });
});

describe('a waiting handoff', () => {
  test('is claimed by a button, not on load: the waiting screen only offers it', () => {
    const s = draftReducer(initialState, { t: 'wait', handoff: 'a'.repeat(22) });
    const html = view(s, true);
    expect(s.phase).toBe('waiting');
    expect(html).toContain(copy.draft.showDraft);
    expect(html).toMatch(/<button[^>]*type="button"/);
    expect(html).not.toContain('a'.repeat(22));
  });
  test('claimAction claims once, signed in, over POST; no token and bad ids never reach the api', async () => {
    const seen: { path: string; method?: string | undefined; token?: string | undefined }[] = [];
    const api = async (path: string, o?: { method?: string; token?: string }) => (seen.push({ path, method: o?.method, token: o?.token }), { status: 200, json: { draft: { ok: 1 } } });
    const a = createBuilderActions({ api: api as never, token: async () => 'tok' });
    const id = 'AbCdEfGhIjKlMnOpQrStUv';
    expect(await a.claim(id)).toEqual({ ok: true, draft: { ok: 1 } });
    expect(seen).toEqual([{ path: `/api/builder/handoff/${id}/claim`, method: 'POST', token: 'tok' }]);
    expect((await a.claim('../x')).ok).toBe(false);
    const anon = createBuilderActions({ api: api as never, token: async () => undefined });
    expect(await anon.claim(id)).toMatchObject({ ok: false, kind: 'sign_in' });
    expect(seen).toHaveLength(1);
  });
  test('a spent or unknown id is a plain failure, not an error page', async () => {
    const a = createBuilderActions({ api: async () => ({ status: 404, json: null }), token: async () => 't' });
    expect(await a.claim('AbCdEfGhIjKlMnOpQrStUv')).toEqual({ ok: false, kind: 'failed', message: copy.errors.status404 });
  });
});

describe('guards', () => {
  test('asDraft accepts a real draft and refuses broken ones', () => {
    expect(asDraft(sampleDraft())).not.toBeNull();
    expect(asDraft(null)).toBeNull();
    expect(asDraft({ ...sampleDraft(), sentence: [{ param: 'ghost' }] })).toBeNull();
    expect(asDraft({ ...sampleDraft(), spec: {} })).toBeNull();
  });
});

describe('web paramDisplay and renderSentence match the api', () => {
  const params: ParamSpec[] = [
    { id: 'a', label: 'A', kind: 'text', value: G },
    { id: 'b', label: 'B', kind: 'text', value: `USDC:${G}` },
    { id: 'c', label: 'C', kind: 'text', value: `LONGCODE12:${G}` },
    { id: 'd', label: 'D', kind: 'text', value: 'a plain name' },
    { id: 'e', label: 'E', kind: 'text', value: `X${G}` },
    { id: 'f', label: 'F', kind: 'text', value: G.slice(0, 20) },
    { id: 'g', label: 'G', kind: 'text', value: `${G}extra` },
    { id: 'h', label: 'H', kind: 'text', value: '' },
    { id: 'i', label: 'I', kind: 'number', value: 5, min: 1, max: 9, unit: '%' },
    { id: 'j', label: 'J', kind: 'number', value: 2.5, min: 1, max: 9 },
    { id: 'k', label: 'K', kind: 'choice', options: [{ label: 'Five', value: 5 }, { label: 'Yes', value: true }], value: 5 },
    { id: 'l', label: 'L', kind: 'choice', options: [{ label: 'Five', value: 5 }, { label: 'Yes', value: true }], value: true },
    { id: 'm', label: 'M', kind: 'choice', options: [{ label: 'x', value: 'x' }, { label: 'y', value: 'y' }], value: 'zzz' },
    { id: 'n', label: 'N', kind: 'time', presets: [{ label: 'morning', value: '0 8 * * *' }], value: '0 8 * * *' },
    { id: 'o', label: 'O', kind: 'time', presets: [{ label: 'morning', value: '0 8 * * *' }], value: '30 7 * * *' },
    { id: 'p', label: 'P', kind: 'time', presets: [{ label: 'Monday morning', value: '0 8 * * 1' }], value: '5 21 * * 0' },
    { id: 'q', label: 'Q', kind: 'time', presets: [], value: 'not a time' },
  ];
  test('every kind of parameter reads the same', () => {
    for (const p of params) expect({ id: p.id, shown: paramDisplay(p) }).toEqual({ id: p.id, shown: apiParamDisplay(p as never) });
    expect(paramDisplay(params[0]!)).toBe('GABC…WXYZ');
    expect(paramDisplay(params[1]!)).toBe('USDC:GABC…WXYZ');
    expect(params.slice(13).map(paramDisplay)).toEqual(['morning at 08:00', 'day at 07:30', 'Sunday at 21:05', 'not a time']);
  });
  test('whole sentences read the same', () => {
    const d = sampleDraft({
      sentence: ['Watch ', { param: 'a' }, ' and ', { param: 'b' }, ' at ', { param: 'i' }, ', ', { param: 'k' }, ' ', { param: 'l' }, '.'],
      params,
    });
    expect(renderSentence(d)).toBe(apiRenderSentence(d as never));
    expect(renderSentence(d)).not.toContain(G);
  });
  test('highlights show the unit; addresses are shortened in them too', () => {
    expect(highlightText(params[8]!)).toBe('5%');
    expect(highlightText(params[0]!)).toBe('GABC…WXYZ');
  });
  test('shortenAddresses keeps the asset prefix and leaves short text alone', () => {
    expect(shortenAddresses(`pay USDC:${G} now`)).toBe('pay USDC:GABC…WXYZ now');
    expect(shortenAddresses('GABC…WXYZ is short')).toBe('GABC…WXYZ is short');
    expect(plainText('all quiet')).toBe('all quiet');
    expect(plainText('a hash')).toBeNull();
  });
});

describe('the time editor', () => {
  const when = { id: 'when', label: 'When', kind: 'time' as const, presets: [{ label: 'morning', value: '0 8 * * *' }, { label: 'evening', value: '0 18 * * *' }], value: '0 8 * * *' };
  const timed = (value = '0 8 * * *', tz?: string) =>
    sampleDraft({ sentence: ['Every ', { param: 'when' }, ' I write.'], params: [{ ...when, value }], bindings: [{ param: 'when', path: '/triggers/0/cron' }], spec: { ...sampleDraft().spec, triggers: [{ kind: 'cron', cron: value, mission: 'm', ...(tz ? { tz } : {}) }] } });
  const html = (d: ReturnType<typeof timed>) => renderToStaticMarkup(createElement(DraftSentence, { draft: d, initialOpen: 'when' }));

  test('the sentence shows the hour; the quick picks show theirs, and "Other time" is there', () => {
    const out = html(timed());
    expect(out).toContain('aria-label="When: morning at 08:00"');
    expect(out).toContain('18:00');
    expect(out).toContain(copy.draft.otherTime);
    expect(out).not.toContain('data-other-time');
  });
  test('a time that is no quick pick opens on "Other time" with the clock filled', () => {
    const out = html(timed('30 7 * * *'));
    expect(out).toContain('data-other-time');
    expect(out).toContain('value="07:30"');
  });
  test('the zone shown is the stored one when the schedule has one', () => {
    expect(textOf(html(timed('0 8 * * *', 'America/New_York')))).toContain(copy.draft.zone('New York'));
  });
  test('a typed clock becomes the schedule; a weekly one keeps or changes its weekday', () => {
    expect(timeFrom('07:30', when)).toBe('30 7 * * *');
    expect(timeFrom('7:05', when)).toBe('5 7 * * *');
    for (const bad of ['', '24:00', '7:5', 'morning', '07:30 9']) expect(timeFrom(bad, when)).toBeNull();
    const weekly = { ...when, presets: [{ label: 'Monday morning', value: '0 8 * * 1' }], value: '0 8 * * 1' };
    expect(timeFrom('09:15', weekly)).toBe('15 9 * * 1');
    expect(timeFrom('09:15 5', weekly)).toBe('15 9 * * 5');
  });
});

describe('the draft card', () => {
  const sticky = (html: string) => html.slice(html.indexOf('data-sticky'));
  const card = (html: string) => html.slice(0, html.indexOf('data-sticky'));
  test('the ready state has one primary ("Create this agent") and one quiet ("Try it first") in the card', () => {
    const c = card(view(ready()));
    expect(c.match(/data-variant="primary"/g)).toHaveLength(1);
    expect(c.match(/data-variant="quiet"/g)).toHaveLength(1);
    expect(c).toMatch(/data-variant="primary"[^>]*>Create this agent/);
    expect(c).toMatch(/data-variant="quiet"[^>]*>Try it first/);
    expect(c).toContain('data-card');
  });
  test('value params are accent pills; the unit shows once', () => {
    const html = view(ready());
    const pills = [...html.matchAll(/<button[^>]*data-param="([a-z_]+)"[^>]*class="[^"]*value-pill/g)];
    expect(pills.map((m) => m[1])).toEqual(['every', 'drop', 'how']);
    expect(textOf(html)).toContain('5%');
    expect(textOf(html)).not.toContain('5%%');
  });
  test('the caption sits above the sentence; the header row holds the name, Rename and "← New idea"', () => {
    const html = view(ready());
    expect(textOf(html)).toContain('Tap a highlighted value to change it.');
    expect(html.indexOf('Tap a highlighted value')).toBeLessThan(html.indexOf('data-param='));
    expect(html.indexOf('← New idea')).toBeLessThan(html.indexOf('Tap a highlighted value'));
    expect(html.indexOf('Rename')).toBeLessThan(html.indexOf('← New idea'));
    expect(textOf(html)).toContain('XLM watcher');
    expect(copy.draft.newIdea).toBe('← New idea');
  });
  test('a number editor is a stepper with the range in its label and a Done button', () => {
    const html = renderToStaticMarkup(createElement(DraftSentence, { draft: sampleDraft(), initialOpen: 'drop' }));
    expect(html).toContain('data-stepper');
    expect(html).toMatch(/aria-label="Less Drop"/);
    expect(html).toMatch(/aria-label="More Drop"/);
    expect(textOf(html)).toContain('Drop, from 1% to 50%');
    expect(textOf(html)).toContain('Done');
  });
  test('stepping honors the bounds and the step size', () => {
    expect(stepNumber(5, 1, { min: 1, max: 50, value: 5 })).toBe(6);
    expect(stepNumber(5, -1, { min: 1, max: 50, value: 5 })).toBe(4);
    expect(stepNumber(50, 1, { min: 1, max: 50, value: 50 })).toBe(50);
    expect(stepNumber(1, -1, { min: 1, max: 50, value: 1 })).toBe(1);
    expect(stepNumber(0.5, 1, { min: 0.1, max: 2, value: 0.5 })).toBe(0.6);
    expect(stepNumber(0.3, 1, { min: 0, max: 1, value: 0.3 })).toBe(0.4);
  });
  test('an off-step value snaps to the step grid on the first press, in the direction pressed', () => {
    expect(stepNumber(2.5, 1, { min: 1, max: 9, value: 2.5 })).toBe(2.6); // tenths: already on the grid
    expect(stepNumber(2.54, 1, { min: 1, max: 9, value: 2.5 })).toBe(2.6);
    expect(stepNumber(2.54, -1, { min: 1, max: 9, value: 2.5 })).toBe(2.5);
    expect(stepNumber(2.5, 1, { min: 0, max: 1000, value: 2.5 })).toBe(3); // wide range: whole steps
    expect(stepNumber(2.5, -1, { min: 0, max: 1000, value: 2.5 })).toBe(2);
  });
  test('zero is a number, not an empty box', () => {
    const p = { min: -5, max: 5, value: 3 };
    expect(stepFrom('0', 1, p)).toBe('1');
    expect(stepFrom('0', -1, p)).toBe('-1');
    expect(stepFrom('', 1, p)).toBe('4');
    expect(stepFrom('abc', -1, p)).toBe('2');
    expect(currentNumber('0', p)).toBe(0);
    expect(currentNumber(' ', p)).toBe(3);
  });
  test('min equal to max disables both buttons', () => {
    const html = renderToStaticMarkup(createElement(DraftSentence, { draft: sampleDraft({ params: [{ id: 'drop', label: 'Drop', kind: 'number', value: 5, min: 5, max: 5 }], sentence: ['x ', { param: 'drop' }] }), initialOpen: 'drop' }));
    expect(html).toMatch(/<button[^>]*aria-label="Less Drop"[^>]*disabled/);
    expect(html).toMatch(/<button[^>]*aria-label="More Drop"[^>]*disabled/);
  });
  test('a refused edit leaves the editor open and restores the shown value; an accepted one closes it', async () => {
    const log: string[] = [];
    const ui = { clearMessage: () => log.push('clear'), close: () => log.push('close'), restore: () => log.push('restore'), setMessage: (m: string) => log.push(`msg:${m}`) };
    const drop = { id: 'drop', label: 'Drop', kind: 'number' as const, value: 5, min: 1, max: 50 };
    await applyEdit(async () => false, drop, 7, ui);
    expect(log).toEqual(['clear', 'restore']);
    log.length = 0;
    await applyEdit(async () => true, drop, 7, ui);
    expect(log).toEqual(['clear', 'close']);
    log.length = 0;
    await applyEdit(undefined, drop, 7, ui);
    expect(log).toEqual(['clear', 'restore']);
  });
  test('a typed value outside the range shows the message and sends nothing', async () => {
    const sent: unknown[] = [];
    const log: string[] = [];
    const ui = { clearMessage: () => {}, close: () => {}, restore: () => {}, setMessage: (m: string) => log.push(m) };
    const drop = { id: 'drop', label: 'Drop', kind: 'number' as const, value: 5, min: 1, max: 50 };
    const onEdit = async (...a: unknown[]) => (sent.push(a), true);
    for (const raw of ['100', '0', '', 'abc']) await submitEdit(drop, raw, onEdit, ui);
    expect(sent).toEqual([]);
    expect(log).toEqual(Array(4).fill(copy.draft.outOfRange(1, 50)));
    await submitEdit(drop, '50', onEdit, ui);
    expect(sent).toEqual([['drop', 50]]);
    await submitEdit({ id: 'how', label: 'How', kind: 'text', value: 'x' }, '   ', onEdit, ui);
    expect(log.at(-1)).toBe(copy.draft.notAText);
    expect(sent).toHaveLength(1);
  });
  test('the range reads in plain words, a word unit once at the end', () => {
    expect(rangeText({ min: 1, max: 50, unit: '%' })).toBe('from 1% to 50%');
    expect(rangeText({ min: 1, max: 24, unit: 'hours' })).toBe('from 1 to 24 hours');
    expect(rangeText({ min: 1, max: 24 })).toBe('from 1 to 24');
  });
  test('2 to 4 choices are a segmented control, more are the list', () => {
    const opts = (n: number) => Array.from({ length: n }, (_, i) => ({ label: `Option ${i}`, value: i }));
    const d = (n: number) => sampleDraft({ params: [{ id: 'every', label: 'How often', kind: 'choice', options: opts(n), value: 0 }, ...sampleDraft().params.slice(1)] });
    for (const n of [2, 3, 4]) expect(renderToStaticMarkup(createElement(DraftSentence, { draft: d(n), initialOpen: 'every' }))).toContain('data-segmented');
    const five = renderToStaticMarkup(createElement(DraftSentence, { draft: d(5), initialOpen: 'every' }));
    expect(five).not.toContain('data-segmented');
    expect(five.match(/type="radio"/g)).toHaveLength(5);
  });
  test('one fine line under the actions, by sign-in state', () => {
    expect(copy.draft.fineSignedOut).toBe("Free. You'll sign in with your email, then approve three times with your device's screen lock: PIN, password or Face ID. Stellar testnet.");
    expect(copy.draft.fineSignedIn).toBe("Free. Approve three times with your device's screen lock: PIN, password or Face ID. Stellar testnet.");
    const out = textOf(view(ready(), false));
    const inn = textOf(view(ready(), true));
    expect(out).toContain(copy.draft.fineSignedOut);
    expect(out).not.toContain(copy.draft.fineSignedIn);
    expect(inn).toContain(copy.draft.fineSignedIn);
    expect(copy.draft.fineSignedIn).not.toMatch(/email/i);
    for (const t of [out, inn]) expect(t).not.toContain(copy.draft.tryNote);
  });
  test('"Edit the details" replaces the raw details summary and keeps data-advanced', () => {
    const html = view(ready());
    expect(textOf(html)).toContain('Edit the details');
    expect(html).toContain('data-advanced=""');
    expect(html).not.toMatch(/<details data-advanced=""[^>]*><summary[^>]*>Advanced/);
  });
  test('the mobile action bar is sticky, hidden from sm up, and the card actions are hidden below sm', () => {
    const html = view(ready());
    expect(html).toContain('h-[calc(7.25rem+env(safe-area-inset-bottom))]');
    expect(html).toMatch(/<div[^>]*data-sticky[^>]*class="[^"]*sm:hidden/);
    expect(sticky(html)).toContain('Create this agent');
    expect(sticky(html)).toContain('Try it first');
    expect(html).toMatch(/<div[^>]*data-actions[^>]*class="[^"]*\bhidden\b[^"]*sm:flex/);
    expect(html).toContain('safe-area-inset-bottom');
  });
  test('an owner at the agent limit gets "Add this to your agent" in the bar and the card, never Create', () => {
    const html = renderToStaticMarkup(createElement(DraftFlowView, { state: ready(), signedIn: true, full: true }));
    expect(sticky(html)).toContain(copy.draft.addToAgent);
    expect(textOf(html)).not.toContain(copy.draft.create);
    expect(textOf(html)).toContain(copy.draft.fullNote);
  });
  test('an owner with agents under the limit creates first; adding to one of them is offered beside it', () => {
    const html = renderToStaticMarkup(createElement(DraftFlowView, { state: ready(), signedIn: true, hasAgents: true }));
    expect(sticky(html)).toContain(copy.draft.create);
    expect(textOf(html)).toContain(copy.draft.addToOne);
    expect(html).toMatch(/<a[^>]*data-add-to-agent[^>]*href="\/dashboard\?prompt=watch%20xlm"/);
    // While the three taps run, the way out to another agent is gone.
    const creating = renderToStaticMarkup(createElement(DraftFlowView, { state: draftReducer(ready(), { t: 'create' }), signedIn: true, hasAgents: true, createFlow: () => null }));
    expect(textOf(creating)).not.toContain(copy.draft.addToOne);
  });
  test('at the limit, an owner whose agent is not finished is offered "Finish creating your agent", a link to /dashboard, never "Add this to your agent"', () => {
    const html = renderToStaticMarkup(createElement(DraftFlowView, { state: ready(), signedIn: true, full: true, unfinished: true }));
    expect(sticky(html)).toContain(copy.draft.finishAgent);
    expect(copy.draft.finishAgent).toBe('Finish creating your agent');
    expect(html).toMatch(/<a[^>]*data-finish-agent[^>]*href="\/dashboard"/);
    const t = textOf(html);
    expect(t).not.toContain(copy.draft.addToAgent);
    expect(t).not.toContain(copy.draft.addNote);
    expect(t).not.toContain(copy.draft.create);
    expect(html).not.toContain('data-add-to-agent');
  });
  test('only a provisioning agent counts as unfinished; active and paused keep the revise path', () => {
    expect(isUnfinishedAgent('provisioning')).toBe(true);
    for (const st of ['active', 'paused', undefined]) expect(isUnfinishedAgent(st)).toBe(false);
  });
  test('the steps above the card: Describe done, Try now; Create now once creating', () => {
    expect(view(ready())).toMatch(/data-step="describe"[^>]*data-state="done"/);
    expect(view(ready())).toMatch(/data-step="try"[^>]*data-state="now"/);
    const creating = view(draftReducer(ready(), { t: 'create' }));
    expect(creating).toMatch(/data-step="try"[^>]*data-state="done"/);
    expect(creating).toMatch(/data-step="create"[^>]*data-state="now"/);
    expect(renderToStaticMarkup(createElement(FlowSteps, { at: 'describe' }))).toMatch(/data-step="describe"[^>]*data-state="now"/);
  });
  test('creating hides the mobile bar so the flow has the floor', () => {
    expect(view(draftReducer(ready(), { t: 'create' }))).not.toContain('data-sticky');
  });
});
