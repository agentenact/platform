import { describe, expect, test } from 'bun:test';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { AgentSkillSetsView, NewSetFormView, SkillSetsEditor, initialNewSetUi, newSetReady, picksToSend, safely, withPickedFound, type AgentSetsUi, type NewSetUi } from '../src/components/skill-sets';
import { createSkillActions } from '../src/server/skills-actions';
import type { SkillReviewShown, SkillSuggested } from '../src/lib/skills';
import { copy, errorCopy } from '../src/copy';
import { MAX_SET_SKILLS, MAX_SKILL_SETS, asAgentSets, asApproved, asSets, setStanding, toggledPicks, type AgentSet, type ApprovedSkill } from '../src/lib/skill-sets';
import { bannedWord } from '../src/lib/words';
import type { ApiCallOptions } from '../src/server/api';
import { createSkillSetActions } from '../src/server/skill-sets-actions';
import { AGENT_ID } from './support/agent';
import { textOf } from './support/screens';

const text = (html: string) => textOf(html).replace(/\s+/g, ' ').trim();
const SET = '22222222-3333-4444-8555-666666666666';
const C1 = 'a'.repeat(40);
const H1 = 'b'.repeat(64);

const setsJson = {
  sets: [
    {
      id: SET,
      name: 'Market notes',
      revision: 3,
      updatedAt: '2026-10-30T18:00:00.000Z',
      skills: [{ id: 'acme/skills/market-brief', name: 'market-brief', description: 'Writes a short market brief.', verdict: 'clear', commit: C1, addedAt: '2026-10-30T17:00:00.000Z' }],
    },
  ],
};
const agentSet = (over: Partial<AgentSet> = {}): AgentSet => ({ id: SET, name: 'Market notes', revision: 3, applied: null, add: ['market-brief'], update: [], same: [], conflicts: [], fits: true, ...over });
const ui = (sets: AgentSet[], over: Partial<AgentSetsUi> = {}): AgentSetsUi => ({ phase: 'ready', data: { version: 4, sets }, busy: null, message: null, note: null, copyOpen: false, copyName: '', ...over });
const view = (u: AgentSetsUi, canCopy = true) => renderToStaticMarkup(createElement(AgentSkillSetsView, { ui: u, canCopy }));

describe('reading the api', () => {
  test('sets and their pinned skills; a bad shape is null', () => {
    const s = asSets(setsJson)!;
    expect(s[0]!.skills[0]).toMatchObject({ name: 'market-brief', verdict: 'clear', commit: C1 });
    expect(asSets({ sets: [{ ...setsJson.sets[0], id: 'nope' }] })).toBeNull();
    expect(asSets({ sets: [{ ...setsJson.sets[0], skills: [{ ...setsJson.sets[0]!.skills[0], verdict: 'great' }] }] })).toBeNull();
    expect(asSets(null)).toBeNull();
  });
  test('an agent’s view of each set', () => {
    const a = asAgentSets({ version: 4, sets: [{ ...agentSet(), conflicts: [{ name: 'x', reason: 'edited' }] }] })!;
    expect(a.sets[0]!.conflicts).toEqual([{ name: 'x', reason: 'edited' }]);
    expect(asAgentSets({ version: 4, sets: [{ ...agentSet(), conflicts: [{ name: 'x', reason: 'other' }] }] })).toBeNull();
    expect(asAgentSets({ version: 0, sets: [] })).toBeNull();
  });
  test('standing: ready, current, blocked, empty, and changed since applied', () => {
    expect(setStanding(agentSet())).toEqual({ state: 'ready', changed: false });
    expect(setStanding(agentSet({ add: [], same: ['market-brief'], applied: 3 }))).toEqual({ state: 'current', changed: false });
    expect(setStanding(agentSet({ add: [], update: ['market-brief'], same: [], applied: 2 }))).toEqual({ state: 'ready', changed: true });
    expect(setStanding(agentSet({ conflicts: [{ name: 'market-brief', reason: 'name_taken' }], add: [] }))).toEqual({ state: 'blocked', changed: false });
    expect(setStanding(agentSet({ fits: false }))).toEqual({ state: 'blocked', changed: false });
    expect(setStanding(agentSet({ add: [] }))).toEqual({ state: 'empty', changed: false });
  });
});

describe('the sets on the Skills tab', () => {
  test('says what giving each set would do, with one button only when it would do something', () => {
    const html = view(ui([agentSet(), agentSet({ id: '33333333-3333-4444-8555-666666666666', name: 'Done', add: [], same: ['pdf'], applied: 3 })]));
    const t = text(html);
    expect(t).toContain(`${copy.skillSets.adds} market-brief`);
    expect(t).toContain(copy.skillSets.current);
    expect(html.match(/data-apply-set=/g)).toHaveLength(1);
    expect(html).toContain('href="/dashboard/skill-sets"');
  });
  test('a changed set says nothing changes here until given again', () => {
    const t = text(view(ui([agentSet({ add: [], update: ['market-brief'], applied: 2 })])));
    expect(t).toContain(`${copy.skillSets.moves} market-brief`);
    expect(t).toContain(copy.skillSets.changedTag);
    expect(t).toContain(copy.skillSets.applyAgain);
    expect(t).toContain(copy.skillSets.changed);
  });
  test('a clash or a full agent is named, with no button', () => {
    const html = view(ui([agentSet({ add: [], conflicts: [{ name: 'market-brief', reason: 'edited' }], fits: false })]));
    expect(text(html)).toContain(copy.skillSets.conflictEdited('market-brief'));
    expect(text(html)).toContain(copy.skillSets.tooMany);
    expect(html).not.toContain('data-apply-set');
  });
  test('no sets yet; making one from the agent only when it has approved skills', () => {
    expect(text(view(ui([])))).toContain(copy.skillSets.none);
    expect(view(ui([]))).toContain('data-copy-open');
    expect(view(ui([], { copyOpen: true }))).toContain('data-copy-name');
    expect(view(ui([]), false)).not.toContain('data-copy-set');
  });
});

describe('the sets page', () => {
  test('lists each set with its skills and the ways to change it', () => {
    const html = renderToStaticMarkup(createElement(SkillSetsEditor, { sets: asSets(setsJson)!, refresh: () => {} }));
    const t = text(html);
    expect(t).toContain(copy.skillSets.pageTitle);
    expect(t).toContain('Market notes');
    expect(t).toContain('market-brief');
    expect(t).toContain(copy.skills.verdict.clear);
    expect(html).toContain('data-take="market-brief"');
    expect(html).toContain(`data-delete-set="${SET}"`);
    expect(text(renderToStaticMarkup(createElement(SkillSetsEditor, { sets: [], refresh: () => {} })))).toContain(copy.skillSets.pageNone);
  });
});

const approved = (over: Partial<ApprovedSkill> = {}): ApprovedSkill => ({ id: 'acme/skills/market-brief', name: 'market-brief', description: 'Writes a short market brief.', verdict: 'clear', commit: C1, contentHash: H1, agents: ['Morning desk'], ...over });
const formUi = (over: Partial<NewSetUi> = {}): NewSetUi => ({ ...initialNewSetUi, phase: 'ready', skills: [approved()], search: { phase: 'ready', found: [] }, ...over });
const FOUND = 'acme/skills/chart-notes';
const found = (over: Partial<SkillSuggested> = {}): SkillSuggested => ({ id: FOUND, name: 'chart-notes', source: 'acme/skills', installs: 500, url: `https://skills.sh/${FOUND}`, matched: [], ...over });
const reviewed = (over: Partial<SkillReviewShown> = {}): SkillReviewShown => ({ id: FOUND, name: 'chart-notes', description: 'Describes a chart.', verdict: 'clear', audits: [], findings: [], commit: C1, contentHash: H1, instructions: 'x', unused: [], fits: true, ...over });
const form = (u: NewSetUi) => renderToStaticMarkup(createElement(NewSetFormView, { ui: u }));

describe('making a set on the sets page', () => {
  test('no sets: the empty state offers the one way to start', () => {
    const html = renderToStaticMarkup(createElement(SkillSetsEditor, { sets: [], refresh: () => {} }));
    expect(html).toContain('data-new-set-open');
    expect(text(html)).toContain(copy.skillSets.newSetOpen);
  });
  test('with sets it stays one button away, until the account is full', () => {
    const one = asSets(setsJson)!;
    expect(renderToStaticMarkup(createElement(SkillSetsEditor, { sets: one, refresh: () => {} }))).toContain('data-new-set-open');
    const full = Array.from({ length: MAX_SKILL_SETS }, () => one[0]!).map((x, i) => ({ ...x, id: `${i}` }));
    expect(renderToStaticMarkup(createElement(SkillSetsEditor, { sets: full, refresh: () => {} }))).not.toContain('data-new-set-open');
  });
  test('lists each approved skill with its verdict and the agents that hold it', () => {
    const html = form(formUi({ skills: [approved({ agents: ['Morning desk', 'Night desk'] }), approved({ id: 'acme/skills/chart-notes', name: 'chart-notes', verdict: 'unaudited' })] }));
    const t = text(html);
    expect(t).toContain('market-brief');
    expect(t).toContain('Morning desk, Night desk');
    expect(t).toContain(copy.skills.verdict.unaudited);
    expect(html.match(/data-pick-skill=/g)).toHaveLength(2);
  });
  test('saving needs a name; picks are optional and counted', () => {
    const off = /<button[^>]* disabled=""[^>]*data-new-set-save/;
    expect(form(formUi())).toMatch(off);
    const named = form(formUi({ name: 'Notes' }));
    expect(named).not.toMatch(off);
    expect(text(form(formUi({ name: 'Notes', picks: ['acme/skills/market-brief'] })))).toContain(copy.skillSets.chosen(1));
  });
  test('while reading it says so; with nothing approved only skills.sh shows; a failed read does not hide it', () => {
    expect(text(form({ ...initialNewSetUi }))).toContain(copy.skillSets.approvedLoading);
    const none = form(formUi({ skills: [], search: { phase: 'ready', found: [found()] } }));
    expect(none).not.toContain('data-from-agents');
    expect(none).toContain(`data-pick-found="${FOUND}"`);
    const failed = form(formUi({ phase: 'failed', skills: [], message: 'Nope.', search: { phase: 'ready', found: [found()] } }));
    expect(text(failed)).toContain('Nope.');
    expect(failed).toContain(`data-pick-found="${FOUND}"`);
    expect(text(form(formUi({ search: { phase: 'failed', found: [found()], message: 'No search.' } })))).toContain('No search.');
    expect(form(formUi({ search: { phase: 'failed', found: [found()], message: 'No search.' } }))).toContain(`data-pick-found="${FOUND}"`);
    expect(form(formUi())).toContain('data-found-none');
  });
  test('skills.sh lists what agents do not already hold, once', () => {
    const html = form(formUi({ search: { phase: 'ready', found: [found(), found({ id: 'acme/skills/market-brief', name: 'market-brief' })] } }));
    expect(html.match(/data-pick-found=/g)).toHaveLength(1);
    expect(html.match(/data-pick-skill=/g)).toHaveLength(1);
    expect(text(html)).toContain(copy.skills.by('acme/skills'));
    expect(html).toContain(`href="https://skills.sh/${FOUND}"`);
  });
  test('a new search keeps what is picked on the list, so it can still be taken back', () => {
    const other = found({ id: 'acme/skills/pdf', name: 'pdf' });
    const ui = formUi({ picks: [FOUND], search: { phase: 'ready', found: [found(), found({ id: 'acme/skills/unpicked', name: 'unpicked' })] } });
    expect(withPickedFound(ui, [other]).map((f) => f.id)).toEqual([FOUND, other.id]);
    expect(withPickedFound(ui, [found(), other]).map((f) => f.id)).toEqual([FOUND, other.id]);
  });
  test('a pick from skills.sh must be read, and ticked when risky, before the set can be made', () => {
    const base = formUi({ name: 'Notes', picks: [FOUND], search: { phase: 'ready', found: [found()] } });
    const with_ = (r: NewSetUi['reviews'][string]) => ({ ...base, reviews: { [FOUND]: r } });
    expect(newSetReady(base)).toBe(false);
    expect(newSetReady(with_({ phase: 'loading' }))).toBe(false);
    expect(text(form(with_({ phase: 'loading' })))).toContain(copy.skills.reading);
    expect(newSetReady(with_({ phase: 'failed', message: 'Unreadable.' }))).toBe(false);
    expect(text(form(with_({ phase: 'failed', message: 'Unreadable.' })))).toContain('Unreadable.');
    expect(newSetReady(with_({ phase: 'ready', review: reviewed(), acceptRisk: false }))).toBe(true);
    const risky = with_({ phase: 'ready', review: reviewed({ verdict: 'unaudited' }), acceptRisk: false });
    expect(newSetReady(risky)).toBe(false);
    expect(form(risky)).toContain(`data-found-risk="${FOUND}"`);
    expect(newSetReady(with_({ phase: 'ready', review: reviewed({ verdict: 'unaudited' }), acceptRisk: true }))).toBe(true);
    const long = with_({ phase: 'ready', review: reviewed({ fits: false }), acceptRisk: false });
    expect(newSetReady(long)).toBe(false);
    expect(form(long)).toContain('data-found-too-long');
  });
  test('sends held picks by fingerprint and reviewed picks with the commit and tick shown', () => {
    const ui = formUi({ picks: ['acme/skills/market-brief', FOUND], reviews: { [FOUND]: { phase: 'ready', review: reviewed({ verdict: 'unaudited' }), acceptRisk: true } } });
    expect(picksToSend(ui)).toEqual([{ id: 'acme/skills/market-brief', contentHash: H1 }, { id: FOUND, contentHash: H1, commit: C1, acceptRisk: true }]);
  });
  test('an action that throws (a tab older than the release) asks for a reload, not "something went wrong"', async () => {
    const out = await safely(async () => {
      throw new Error('An unexpected response was received from the server.');
    });
    expect(out).toEqual({ ok: false, message: copy.skillSets.stale });
    expect(copy.skillSets.stale).not.toBe(copy.errors.generic);
  });
  test('at the limit, only what is already picked can change', () => {
    const skills = Array.from({ length: MAX_SET_SKILLS + 1 }, (_, i) => approved({ id: `acme/skills/s${i}`, name: `s${i}` }));
    const html = form(formUi({ skills, picks: skills.slice(0, MAX_SET_SKILLS).map((k) => k.id) }));
    expect(html.match(/<input[^>]* disabled=""[^>]*data-pick-skill/g)).toHaveLength(1);
  });
  test('toggling a pick: on, off, and one name per set', () => {
    const a = approved();
    const other = approved({ id: 'other/skills/market-brief' });
    const b = approved({ id: 'acme/skills/chart-notes', name: 'chart-notes' });
    const all = [a, other, b];
    expect(toggledPicks(all, [], a.id)).toEqual([a.id]);
    expect(toggledPicks(all, [a.id], a.id)).toEqual([]);
    expect(toggledPicks(all, [a.id, b.id], other.id)).toEqual([b.id, other.id]);
  });
});

describe('skill set actions', () => {
  const recorder = (status = 200, json: unknown = { revision: 4 }) => {
    const seen: { path: string; o: ApiCallOptions | undefined }[] = [];
    const a = createSkillSetActions({ api: async (path, o) => (seen.push({ path, o }), { status, json }), token: async () => 'tok' });
    return { a, seen };
  };
  test('sends exactly what the screen showed', async () => {
    const { a, seen } = recorder();
    expect(await a.addSkill(SET, { id: 'acme/skills/market-brief', commit: C1, contentHash: H1, revision: 3, acceptRisk: false })).toEqual({ ok: true, data: { revision: 4 } });
    expect(seen[0]).toEqual({ path: `/api/skill-sets/${SET}/skills`, o: { token: 'tok', method: 'POST', body: { id: 'acme/skills/market-brief', commit: C1, contentHash: H1, revision: 3, acceptRisk: false } } });
    const applied = createSkillSetActions({ api: async (path, o) => (seen.push({ path, o }), { status: 200, json: { version: 5, added: ['market-brief'], updated: [] } }), token: async () => 'tok' });
    expect(await applied.apply(AGENT_ID, SET, { version: 4, revision: 3 })).toEqual({ ok: true, data: { version: 5, added: ['market-brief'], updated: [] } });
    expect(seen[1]).toEqual({ path: `/api/agents/${AGENT_ID}/skill-sets/${SET}/apply`, o: { token: 'tok', method: 'POST', body: { version: 4, revision: 3 } } });
    const renamed = createSkillSetActions({ api: async (path, o) => (seen.push({ path, o }), { status: 204, json: null }), token: async () => 'tok' });
    expect(await renamed.rename(SET, '  Notes ')).toEqual({ ok: true, data: true });
    expect(seen[2]).toEqual({ path: `/api/skill-sets/${SET}`, o: { token: 'tok', method: 'PUT', body: { name: 'Notes' } } });
  });
  test('a new set from picks sends what the screen showed, and only that', async () => {
    const { a, seen } = recorder(200, { id: SET, revision: 1 });
    const pick = { id: 'acme/skills/market-brief', contentHash: H1 };
    expect(await a.createWith(' Notes ', [pick])).toEqual({ ok: true, data: { id: SET, revision: 1 } });
    expect(seen[0]).toEqual({ path: '/api/skill-sets', o: { token: 'tok', method: 'POST', body: { name: 'Notes', skills: [pick] } } });
    expect((await a.createWith('Notes', [{ id: 'nope', contentHash: H1 }])).ok).toBe(false);
    expect((await a.createWith('Notes', [{ id: pick.id, contentHash: 'short' }])).ok).toBe(false);
    expect((await a.createWith('  ', [pick])).ok).toBe(false);
    expect(seen).toHaveLength(1);
  });
  test('reads what can be picked; a bad shape is the generic failure', async () => {
    const skill = { ...approved() };
    expect(asApproved({ skills: [skill] })).toEqual([skill]);
    expect(asApproved({ skills: [{ ...skill, verdict: 'great' }] })).toBeNull();
    expect(asApproved({ skills: [{ ...skill, agents: 'x' }] })).toBeNull();
    expect(asApproved(null)).toBeNull();
    const { a, seen } = recorder(200, { skills: [skill] });
    expect(await a.approved()).toEqual({ ok: true, data: [skill] });
    expect(seen[0]).toEqual({ path: '/api/skill-sets/approved', o: { token: 'tok' } });
  });
  test('a pick reviewed on skills.sh carries its commit; searching skills.sh needs no agent', async () => {
    const { a, seen } = recorder(200, { id: SET, revision: 1 });
    await a.createWith('Notes', [{ id: FOUND, contentHash: H1, commit: C1 }]);
    expect((seen[0]!.o!.body as { skills: unknown[] }).skills).toEqual([{ id: FOUND, contentHash: H1, commit: C1, acceptRisk: false }]);
    const asked: string[] = [];
    const s = createSkillActions({ api: async (path) => (asked.push(path), { status: 200, json: { suggestions: [found()] } }), token: async () => 'tok' });
    expect(await s.search()).toEqual({ ok: true, data: [found()] });
    expect(await s.search(' pdf reports ')).toEqual({ ok: true, data: [found()] });
    expect(asked).toEqual(['/api/skills/search', '/api/skills/search?q=pdf%20reports']);
    expect((await createSkillActions({ api: async () => ({ status: 200, json: { suggestions: [{ id: 1 }] } }), token: async () => 'tok' }).search()).ok).toBe(false);
  });
  test('refuses malformed input before the api', async () => {
    const { a, seen } = recorder();
    expect((await a.apply(AGENT_ID, 'nope', { version: 1, revision: 1 })).ok).toBe(false);
    expect((await a.removeSkill(SET, 'Bad Name', 1)).ok).toBe(false);
    expect((await a.create('   ')).ok).toBe(false);
    expect((await a.create('x'.repeat(61))).ok).toBe(false);
    expect(seen).toHaveLength(0);
  });
  test('each refusal reads as its own plain sentence', async () => {
    for (const code of ['set_not_found', 'set_changed', 'set_conflict', 'name_taken', 'too_many_sets', 'no_skills_to_copy', 'bad_skill_set']) {
      const { a } = recorder(409, { error: code });
      const out = await a.apply(AGENT_ID, SET, { version: 1, revision: 1 });
      expect(out.ok ? '' : out.message).toBe(errorCopy(code));
      expect(errorCopy(code)).not.toBe(copy.errors.generic);
    }
  });
  test('no copy here uses a banned word', () => {
    const c = copy.skillSets;
    const all: string[] = [
      ...(Object.values(c) as unknown[]).filter((v): v is string => typeof v === 'string'),
      c.skills(1),
      c.skills(3),
      c.applied('Notes', 2, 1),
      c.applied('Notes', 0, 0),
      c.deleteConfirm('Notes'),
      c.conflictTaken('a'),
      c.conflictEdited('a'),
      c.made('Notes'),
      c.addedTo('a', 'Notes'),
      c.chosen(0),
      c.chosen(2),
      c.heldBy(['A', 'B']),
    ];
    for (const s of all) expect(bannedWord(s)).toBeNull();
  });
});
