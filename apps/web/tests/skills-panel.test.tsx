import { describe, expect, test } from 'bun:test';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { SkillsSlot } from '../src/components/agent-screen';
import { SkillsCardView } from '../src/components/skills-card';
import { initialSkillsUi, SkillChecks, SkillsView, type SkillsUi } from '../src/components/skills-panel';
import { copy, errorCopy } from '../src/copy';
import { asHeld, asReview, asSuggestions, hideSkillsForAWeek, needsRisk, showSkillsCard, SKILLS_HIDE_DAYS, skillsHiddenNow, toggledSkills } from '../src/lib/skills';
import { bannedWord } from '../src/lib/words';
import type { ApiCall, ApiCallOptions } from '../src/server/api';
import { createSkillActions } from '../src/server/skills-actions';
import { createLoadSkillsHint } from '../src/server/skills-data';
import { AGENT_ID, NOW } from './support/agent';
import { stripAdvanced, textOf } from './support/screens';

const text = (html: string) => textOf(html).replace(/\s+/g, ' ').trim();
const C1 = 'a'.repeat(40);
const H1 = 'b'.repeat(64);

const heldJson = {
  version: 3,
  skills: [
    { name: 'pdf', description: 'Read and write PDF files.', source: { id: 'anthropics/skills/pdf', verdict: 'clear', approvedAt: new Date(NOW - 3_600_000).toISOString(), commit: C1, edited: false } },
    { name: 'xlm-notes', description: 'How to describe XLM moves.', source: null },
  ],
};
const suggestJson = {
  version: 3,
  queries: ['stellar', 'crypto market'],
  suggestions: [{ id: 'acme/skills/market-brief', name: 'market-brief', source: 'acme/skills', installs: 1234, url: 'https://skills.sh/acme/skills/market-brief', matched: ['crypto market'] }],
};
const reviewJson = (over: Record<string, unknown> = {}) => ({
  id: 'acme/skills/market-brief',
  name: 'market-brief',
  description: 'Writes a short market brief.',
  verdict: 'clear',
  audits: [{ provider: 'Socket', status: 'pass', riskLevel: 'LOW', summary: 'No issues.', auditedAt: '2026-10-01T00:00:00Z' }],
  findings: [],
  commit: C1,
  contentHash: H1,
  instructions: '# Market brief\nUse the token price and the prompt below.',
  unused: ['scripts/fetch.py'],
  fits: true,
  ...over,
});

const held = asHeld(heldJson)!;
const review = asReview(reviewJson())!;
const ui = (over: Partial<SkillsUi> = {}): SkillsUi => ({ ...initialSkillsUi(3), suggest: { phase: 'ready', data: asSuggestions(suggestJson)! }, ...over });
const tab = (u: SkillsUi, h = held) => renderToStaticMarkup(createElement(SkillsView, { held: h, ui: u, now: NOW }));
// The checks open in a portal, which static markup never mounts: an open review is rendered after the tab, as the dialog shows it over it.
const render = (u: SkillsUi, h = held) =>
  tab(u, h) + (u.open?.phase === 'ready' ? renderToStaticMarkup(createElement(SkillChecks, { r: u.open.review, ui: u as SkillsUi & { open: { phase: 'ready' } }, on: {} })) : '');

describe('reading the api', () => {
  test('held skills keep their source; a bad shape is null', () => {
    expect(held.version).toBe(3);
    expect(held.skills[0]!.source?.id).toBe('anthropics/skills/pdf');
    expect(held.skills[1]!.source).toBeNull();
    expect(asHeld({ version: 0, skills: [] })).toBeNull();
    expect(asHeld({ version: 1, skills: [{ name: 'x', description: 'y', source: { id: 'a/b/c', verdict: 'great', approvedAt: '', commit: null, edited: false } }] })).toBeNull();
    expect(asHeld(null)).toBeNull();
  });
  test('suggestions link only to skills.sh', () => {
    const s = asSuggestions({ ...suggestJson, suggestions: [{ ...suggestJson.suggestions[0], url: 'https://evil.example/x' }] })!;
    expect(s.suggestions[0]!.url).toBe('https://skills.sh/acme/skills/market-brief');
    expect(asSuggestions({ ...suggestJson, suggestions: [{ id: 1 }] })).toBeNull();
  });
  test('a review needs every field; unknown finding codes are refused', () => {
    expect(review.audits[0]).toEqual({ provider: 'Socket', status: 'pass', riskLevel: 'LOW', summary: 'No issues.', auditedAt: '2026-10-01T00:00:00Z' });
    expect(asReview(reviewJson({ findings: [{ code: 'mystery', path: 'a', detail: 'b' }] }))).toBeNull();
    expect(asReview(reviewJson({ fits: 'yes' }))).toBeNull();
  });
  test('blocked and unaudited need the extra tick', () => {
    expect(['clear', 'caution', 'blocked', 'unaudited'].map((v) => needsRisk(v as never))).toEqual([false, false, true, true]);
  });
});

describe('the Skills tab', () => {
  test('lists held skills with where they came from, and the suggestions', () => {
    const t = text(render(ui()));
    expect(t).toContain(copy.skills.intro);
    expect(t).toContain('From skills.sh · anthropics/skills/pdf · You approved it 1 hour ago');
    expect(t).toContain(copy.skills.ownSkill);
    expect(t).toContain('market-brief');
    expect(t).toContain('by acme/skills · 1,234 installs');
    expect(render(ui())).toContain('href="https://skills.sh/acme/skills/market-brief"');
  });
  test('a skill changed by hand after approval says so', () => {
    const edited = asHeld({ ...heldJson, skills: [{ ...heldJson.skills[0], source: { ...heldJson.skills[0]!.source, edited: true } }] })!;
    expect(text(render(ui(), edited))).toContain(copy.skills.edited);
  });
  test('loading, empty and failed suggestions', () => {
    expect(text(render(ui({ suggest: { phase: 'loading' } })))).toContain(copy.skills.searching);
    expect(text(render(ui({ suggest: { phase: 'ready', data: { version: 3, queries: [], suggestions: [] } } })))).toContain(copy.skills.noneFound);
    expect(text(render(ui({ suggest: { phase: 'failed', message: copy.errors.status5xx } })))).toContain(copy.errors.status5xx);
    expect(text(render(ui(), { version: 1, skills: [], offers: [] }))).toContain(copy.skills.none);
  });
  test('the review shows audits, our notes, unused files; instructions only inside the advanced part', () => {
    const findings = [{ code: 'executable', path: 'scripts/fetch.py', detail: 'x' }, { code: 'network', path: 'SKILL.md', detail: 'y' }];
    const r = asReview(reviewJson({ verdict: 'caution', findings }))!;
    const html = render(ui({ open: { id: r.id, phase: 'ready', review: r, acceptRisk: false } }));
    const t = text(html);
    expect(t).toContain(copy.skills.verdict.caution);
    expect(t).toContain('Socket · Passed · Risk: low');
    expect(t).toContain(copy.skills.finding.executable);
    expect(t).toContain(copy.skills.finding.network);
    expect(t).toContain('scripts/fetch.py');
    expect(t).toContain(copy.skills.pinned);
    expect(text(stripAdvanced(html))).not.toContain('Market brief');
    expect(html).toContain('data-advanced');
    expect(html).not.toContain('data-accept-risk');
    expect(html).toMatch(/<button[^>]*data-add=""[^>]*>/);
    expect(html.match(/<button[^>]*data-add=""[^>]*>/)![0]).not.toContain(' disabled=""');
  });
  test('opening a skill keeps the list and the search in place, with no back button', () => {
    const html = tab(ui({ open: { id: review.id, phase: 'ready', review, acceptRisk: false } }));
    expect(html).toContain('data-find');
    expect(html).toContain('data-query');
    expect(html).toContain(`data-look="${review.id}"`);
    expect(html).not.toContain('data-back');
    expect(html).not.toContain('data-review=');
  });
  test('a failed add shows inside the open checks, not behind them', () => {
    const u = ui({ open: { id: review.id, phase: 'ready', review, acceptRisk: false }, message: errorCopy('skill_changed') });
    expect(tab(u)).not.toContain('data-skills-message');
    expect(render(u)).toContain('data-skills-message');
  });
  test('a blocked skill cannot be added until the box is ticked', () => {
    const r = asReview(reviewJson({ verdict: 'blocked', audits: [{ provider: 'Snyk', status: 'fail', riskLevel: 'HIGH', summary: 'Bad.', auditedAt: '2026-10-01T00:00:00Z' }] }))!;
    const off = render(ui({ open: { id: r.id, phase: 'ready', review: r, acceptRisk: false } }));
    expect(text(off)).toContain(copy.skills.verdict.blocked);
    expect(off).toContain('data-accept-risk');
    expect(off.match(/<button[^>]*data-add=""[^>]*>/)![0]).toContain(' disabled=""');
    const on = render(ui({ open: { id: r.id, phase: 'ready', review: r, acceptRisk: true } }));
    expect(on.match(/<button[^>]*data-add=""[^>]*>/)![0]).not.toContain(' disabled=""');
  });
  test('instructions too long for the agent: no add button', () => {
    const r = asReview(reviewJson({ fits: false }))!;
    const html = render(ui({ open: { id: r.id, phase: 'ready', review: r, acceptRisk: false } }));
    expect(text(html)).toContain(copy.skills.tooLong);
    expect(html).not.toContain('data-add');
  });
  test('no banned word outside the advanced part, in any state', () => {
    const blocked = asReview(reviewJson({ verdict: 'unaudited', audits: [], findings: [{ code: 'secret_reference', path: 'SKILL.md', detail: 'x' }, { code: 'broad_tools', path: 'SKILL.md', detail: 'y' }] }))!;
    const screens = [
      render(ui()),
      render(ui({ suggest: { phase: 'loading' }, note: copy.skills.added('pdf'), message: errorCopy('skill_changed') })),
      render(ui({ open: { id: blocked.id, phase: 'ready', review: blocked, acceptRisk: false }, busy: 'add' })),
      render(ui({ open: { id: 'acme/skills/x', phase: 'failed', message: errorCopy('skill_not_found', 404) } })),
      renderToStaticMarkup(createElement(SkillsCardView)),
    ];
    // The fixtures' own instructions mention "token" and "prompt": only the advanced part may show them.
    for (const html of screens) expect(bannedWord(text(stripAdvanced(html)))).toBeNull();
  });
});

describe('skills when other agents pay', () => {
  const offers = [
    { slug: 'digest', description: 'A DeFi digest', skills: ['pdf'] },
    { slug: 'brief', description: 'A market brief', skills: ['a', 'b'] },
  ];
  const withOffers = asHeld({ ...heldJson, services: offers })!;
  test('the list reads the offers; an answer without them has none', () => {
    expect(withOffers.offers).toEqual(offers);
    expect(held.offers).toEqual([]);
    expect(asHeld({ ...heldJson, services: [{ slug: 1 }] })).toBeNull();
  });
  test('only skills from skills.sh, unchanged since approval, can be switched on; a full offer cannot take more', () => {
    const html = render(ui(), withOffers);
    expect(html).toContain('data-offers="pdf"');
    expect(html).not.toContain('data-offers="xlm-notes"'); // written for this agent: never named in a proof
    const t = text(html);
    expect(t).toContain(copy.skills.offersTitle);
    expect(t).toContain('A DeFi digest');
    expect(t).toContain(`A market brief · ${copy.skills.offerFull}`);
    expect(html.match(/<input[^>]*data-offer="digest"[^>]*>/)![0]).toContain('checked=""');
    expect(html.match(/<input[^>]*data-offer="brief"[^>]*>/)![0]).toContain(' disabled=""');
    const edited = asHeld({ ...heldJson, services: offers, skills: [{ ...heldJson.skills[0], source: { ...heldJson.skills[0]!.source, edited: true } }] })!;
    expect(render(ui(), edited)).not.toContain('data-offers=');
    expect(bannedWord(text(html))).toBeNull();
  });
  test('switching on and off, with the limit of two', () => {
    expect(toggledSkills(offers[0]!, 'x', true)).toEqual(['pdf', 'x']);
    expect(toggledSkills(offers[0]!, 'pdf', false)).toEqual([]);
    expect(toggledSkills(offers[1]!, 'x', true)).toBeNull();
    expect(toggledSkills(offers[1]!, 'a', true)).toEqual(['a', 'b']);
  });
  test('the action sends the whole list with the version shown; refusals read plainly', async () => {
    const seen: { path: string; o: ApiCallOptions | undefined }[] = [];
    const a = createSkillActions({ api: async (path, o) => (seen.push({ path, o }), { status: 200, json: { version: 7 } }), token: async () => 'tok' });
    expect(await a.setOfferSkills(AGENT_ID, 'digest', ['pdf'], 6)).toEqual({ ok: true, data: { version: 7 } });
    expect(seen[0]).toEqual({ path: `/api/agents/${AGENT_ID}/services/digest/skills`, o: { token: 'tok', method: 'PUT', body: { skills: ['pdf'], version: 6 } } });
    expect((await a.setOfferSkills(AGENT_ID, 'digest', ['a', 'b', 'c'], 6)).ok).toBe(false);
    expect(seen).toHaveLength(1);
    for (const code of ['skill_not_approved', 'skills_too_long', 'service_not_found']) {
      const r = createSkillActions({ api: async () => ({ status: code === 'service_not_found' ? 404 : 409, json: { error: code } }), token: async () => 't' });
      const out = await r.setOfferSkills(AGENT_ID, 'digest', [], 1);
      expect(out.ok ? '' : out.message).toBe(errorCopy(code));
      expect(bannedWord(errorCopy(code))).toBeNull();
    }
  });
});

describe('server actions', () => {
  const fake = (status: number, json: unknown) => {
    const seen: { path: string; o: ApiCallOptions | undefined }[] = [];
    const api: ApiCall = async (path, o) => (seen.push({ path, o }), { status, json });
    return { seen, a: createSkillActions({ api, token: async () => 'tok' }) };
  };
  test('approve sends exactly what the owner saw', async () => {
    const f = fake(200, { version: 4 });
    expect(await f.a.approve(AGENT_ID, { id: review.id, commit: C1, contentHash: H1, version: 3, acceptRisk: false })).toEqual({ ok: true, data: { version: 4 } });
    expect(f.seen[0]!.path).toBe(`/api/agents/${AGENT_ID}/skills`);
    expect(f.seen[0]!.o).toEqual({ token: 'tok', method: 'POST', body: { id: review.id, commit: C1, contentHash: H1, version: 3, acceptRisk: false } });
  });
  test('refusals carry a plain sentence from the code', async () => {
    for (const code of ['skill_changed', 'needs_accept_risk', 'version_changed', 'pending_draft', 'too_many_skills', 'skill_exists', 'skill_unusable']) {
      const out = await fake(409, { error: code }).a.approve(AGENT_ID, { id: review.id, commit: C1, contentHash: H1, version: 3, acceptRisk: false });
      expect(out).toEqual({ ok: false, message: errorCopy(code) });
      expect(out.ok ? '' : out.message).not.toBe(copy.errors.generic);
    }
    expect(await fake(503, null).a.suggest(AGENT_ID)).toEqual({ ok: false, message: copy.errors.status5xx });
    expect(await fake(200, { odd: true }).a.review(review.id)).toEqual({ ok: false, message: copy.errors.status5xx });
  });
  test('suggest, review and remove build the right paths; bad input never reaches the api', async () => {
    const f = fake(200, suggestJson);
    await f.a.suggest(AGENT_ID, '  pdf reports ');
    expect(f.seen[0]!.path).toBe(`/api/agents/${AGENT_ID}/skills/suggestions?q=pdf%20reports`);
    const r = fake(200, reviewJson());
    expect((await r.a.review('acme/skills/market-brief')).ok).toBe(true);
    expect(r.seen[0]!.path).toBe('/api/skills/review?id=acme%2Fskills%2Fmarket-brief');
    const d = fake(200, { version: 5 });
    expect(await d.a.remove(AGENT_ID, 'pdf', 4)).toEqual({ ok: true, data: { version: 5 } });
    expect(d.seen[0]).toEqual({ path: `/api/agents/${AGENT_ID}/skills/pdf?version=4`, o: { token: 'tok', method: 'DELETE' } });
    const none = fake(200, {});
    expect((await none.a.review('../etc/passwd')).ok).toBe(false);
    expect((await none.a.remove(AGENT_ID, '../x', 1)).ok).toBe(false);
    expect((await none.a.approve('not-a-uuid', { id: review.id, commit: C1, contentHash: H1, version: 1, acceptRisk: false })).ok).toBe(false);
    expect(none.seen).toEqual([]);
  });
  test('signed out says so without calling', async () => {
    const seen: string[] = [];
    const a = createSkillActions({ api: async (p) => (seen.push(p), { status: 200, json: {} }), token: async () => undefined });
    expect(await a.suggest(AGENT_ID)).toEqual({ ok: false, message: errorCopy('unauthorized') });
    expect(seen).toEqual([]);
  });
});

describe('the card on the agent page', () => {
  test('shows only while no skill came from skills.sh; any failure is no card', async () => {
    expect(showSkillsCard(asHeld({ version: 1, skills: [] }))).toBe(true);
    expect(showSkillsCard(held)).toBe(false);
    expect(showSkillsCard(null)).toBe(false);
    const hint = (status: number, json: unknown) => createLoadSkillsHint({ token: async () => 't', api: async () => ({ status, json }) })(AGENT_ID);
    expect(await hint(200, { version: 1, skills: [heldJson.skills[1]] })).toBe(true);
    expect(await hint(200, heldJson)).toBe(false);
    expect(await hint(503, null)).toBe(false);
    expect(await createLoadSkillsHint({ token: async () => 't', api: async () => Promise.reject(new Error('x')) })(AGENT_ID)).toBe(false);
  });
  test('links to the Skills tab; the slot draws nothing when there is nothing to say', async () => {
    const html = renderToStaticMarkup(createElement(SkillsCardView, { agentId: AGENT_ID }));
    expect(text(html)).toContain(copy.skills.cardBanner);
    expect(html).toContain(`href="/dashboard/${AGENT_ID}?tab=skills"`);
    expect(renderToStaticMarkup(createElement(SkillsCardView, { agentId: AGENT_ID, hidden: true }))).toBe('');
    expect(await SkillsSlot({ agentId: AGENT_ID, load: async () => false })).toBeNull();
    expect(await SkillsSlot({ agentId: AGENT_ID, load: async () => true })).not.toBeNull();
  });
  test('"Not now" hides it for 7 days; broken storage just shows it', () => {
    const m = new Map<string, string>();
    const store = { getItem: (k: string) => m.get(k) ?? null, setItem: (k: string, v: string) => void m.set(k, v) };
    expect(skillsHiddenNow(store, AGENT_ID, NOW)).toBe(false);
    hideSkillsForAWeek(store, AGENT_ID, NOW);
    expect(skillsHiddenNow(store, AGENT_ID, NOW + (SKILLS_HIDE_DAYS * 86_400_000 - 1))).toBe(true);
    expect(skillsHiddenNow(store, AGENT_ID, NOW + SKILLS_HIDE_DAYS * 86_400_000)).toBe(false);
    const broken = { getItem: () => { throw new Error('x'); }, setItem: () => { throw new Error('x'); } };
    expect(skillsHiddenNow(broken, AGENT_ID, NOW)).toBe(false);
    expect(() => hideSkillsForAWeek(broken, AGENT_ID, NOW)).not.toThrow();
  });
});
