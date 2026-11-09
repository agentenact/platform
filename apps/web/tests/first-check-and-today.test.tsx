import { describe, expect, test } from 'bun:test';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { AgentView } from '../src/components/agent-screen';
import { FirstCheck } from '../src/components/first-check';
import { MorningNoteView } from '../src/components/morning-note';
import { Instruments } from '../src/components/agent-header';
import { TodayCard } from '../src/components/today-card';
import { copy } from '../src/copy';
import { daysWatching, momentOf, refreshSeconds } from '../src/lib/agent-moment';
import { asOverview, type FeedItem } from '../src/lib/agent-types';
import { runMorningNote } from '../src/lib/morning-note';
import { createAgentActions } from '../src/server/agent-actions';
import { createLoadAgent, type AgentLoad } from '../src/server/agent-data';
import type { ApiResult } from '../src/server/api';
import { AGENT_ID, NOW, overview } from './support/agent';
import { sampleDraft } from './support/draft';
import { textOf } from './support/screens';

const text = (el: React.ReactElement) => textOf(renderToStaticMarkup(el)).replace(/\s+/g, ' ').trim();
const ago = (ms: number) => new Date(NOW - ms).toISOString();
const MIN = 60_000;
/** An agent seconds old that has not been checked yet. */
const brandNew = (o = {}) => overview({ checksToday: 0, checksTotal: 0, alertsThisWeek: 0, lastAlertAt: null, salesCount: 0, earnedUsdc: '0', budgetUsedPct: 0, latestCheck: null, watchingSince: ago(20_000), ...o });
const firstDone = (o = {}) =>
  overview({ checksToday: 1, checksTotal: 1, alertsThisWeek: 0, lastAlertAt: null, watchingSince: ago(2 * MIN), latestCheck: { at: ago(30_000), held: false, reading: { symbol: 'XLM', changePct: -0.4, from: 0.1045, to: 0.1041 } }, ...o });

describe('the overview from an older api', () => {
  const old = { name: 'A', status: 'watching', nextCheckAt: null, lastAlertAt: null, checksToday: 2, alertsThisWeek: 0, earnedUsdc: '0', salesCount: 0, budgetUsedPct: 0 };
  test('still parses, with the new fields at their quiet defaults', () => {
    const o = asOverview(old)!;
    expect(o).toMatchObject({ checksTotal: 2, watchesCondition: false, latestCheck: null, morningNote: null });
    expect(o.watchingSince).toBeNull();
  });
  test('reads the new fields when they are there and drops a latest check that does not look right', () => {
    const ok = asOverview({ ...old, watchingSince: '2026-10-10T00:00:00Z', checksTotal: 9, watchesCondition: true, morningNote: false, latestCheck: { at: '2026-10-13T11:00:00Z', held: null, reading: null } })!;
    expect(ok).toMatchObject({ checksTotal: 9, watchesCondition: true, morningNote: false, latestCheck: { held: null, reading: null } });
    expect(asOverview({ ...old, latestCheck: { at: 'nope', held: false, reading: null } })!.latestCheck).toBeNull();
    expect(asOverview({ ...old, latestCheck: { at: '2026-10-13T11:00:00Z', held: 'x', reading: null } })!.latestCheck).toBeNull();
    expect(asOverview({ ...old, latestCheck: { at: '2026-10-13T11:00:00Z', held: false, reading: { a: { b: 1 } } } })!.latestCheck!.reading).toBeNull();
  });
});

describe('which moment the page is in', () => {
  test('a new agent that watches a condition is waiting for its first check', () => {
    expect(momentOf(brandNew(), NOW)).toBe('waiting');
  });
  test('it keeps waiting only while the agent is young; after that the page is plain', () => {
    expect(momentOf(brandNew({ watchingSince: ago(9 * MIN) }), NOW)).toBe('waiting');
    expect(momentOf(brandNew({ watchingSince: ago(11 * MIN) }), NOW)).toBe('plain');
  });
  test('an agent with no condition to watch, a paused or a stopped one never claims to be checking', () => {
    expect(momentOf(brandNew({ watchesCondition: false }), NOW)).toBe('plain');
    expect(momentOf(brandNew({ status: 'paused' }), NOW)).toBe('plain');
    expect(momentOf(brandNew({ status: 'stopped_today' }), NOW)).toBe('plain');
  });
  test('a check that could not finish is "failed" and the page keeps waiting', () => {
    expect(momentOf(brandNew({ latestCheck: { at: ago(5000), held: null, reading: null } }), NOW)).toBe('failed');
  });
  test('one real check is the first check; two or more with checks today is the day', () => {
    expect(momentOf(firstDone(), NOW)).toBe('first');
    expect(momentOf(firstDone({ checksTotal: 2, checksToday: 2 }), NOW)).toBe('today');
    expect(momentOf(overview(), NOW)).toBe('today');
  });
  test('a day with no checks yet is plain, whatever came before', () => {
    expect(momentOf(overview({ checksToday: 0 }), NOW)).toBe('plain');
  });
  test('it polls every 5 s only while it waits for the first check, otherwise every 30 s', () => {
    expect([refreshSeconds('waiting'), refreshSeconds('failed'), refreshSeconds('first'), refreshSeconds('today'), refreshSeconds('plain')]).toEqual([5, 5, 30, 30, 30]);
  });
  test('days watching counts whole days and never goes below zero', () => {
    expect(daysWatching(ago(3 * 86_400_000 + MIN), NOW)).toBe(3);
    expect(daysWatching(ago(MIN), NOW)).toBe(0);
    expect(daysWatching('2099-01-01T00:00:00Z', NOW)).toBe(0);
    expect(daysWatching(null, NOW)).toBeNull();
  });
});

describe('the first check card', () => {
  test('while waiting it says in plain words that the agent is checking now, with a working ring', () => {
    const html = renderToStaticMarkup(createElement(FirstCheck, { o: brandNew(), now: NOW, moment: 'waiting' }));
    expect(textOf(html)).toContain('First check');
    expect(textOf(html)).toContain(copy.firstCheck.looking);
    expect(html).toContain('data-ring="working"');
    expect(html).not.toMatch(/0 checks|0 alerts/);
  });
  test('a check that failed says so honestly and promises another try, never a success', () => {
    const t = text(createElement(FirstCheck, { o: brandNew({ latestCheck: { at: ago(5000), held: null, reading: null } }), now: NOW, moment: 'failed' }));
    expect(t).toContain(copy.firstCheck.failed);
    expect(t).not.toContain('All quiet');
  });
  test('when it lands it shows only the real reading: verdict, the line, the cells', () => {
    const html = renderToStaticMarkup(createElement(FirstCheck, { o: firstDone(), now: NOW, moment: 'first', draft: sampleDraft() }));
    const t = textOf(html).replace(/\s+/g, ' ');
    expect(t).toContain('First check · just now');
    expect(t).toContain('All quiet. I am staying quiet.');
    expect(t).toContain('XLM moved −0.40%. Your limit is 5%.');
    expect(t).toContain('Change');
    expect(t).toContain('−0.40%');
    expect(t).toContain('Your limit');
    expect(t).toContain('$0.1041');
    expect(html).toContain('data-ring="done"');
  });
  test('without the draft there is no limit sentence and no limit cell, and nothing is invented', () => {
    const t = text(createElement(FirstCheck, { o: firstDone(), now: NOW, moment: 'first' }));
    expect(t).toContain('XLM moved −0.40%.');
    expect(t).not.toContain('limit');
  });
  test('a check that found something says so', () => {
    const t = text(createElement(FirstCheck, { o: firstDone({ latestCheck: { at: ago(1000), held: true, reading: { symbol: 'XLM', changePct: -6, from: 1, to: 0.94 } } }), now: NOW, moment: 'first' }));
    expect(t).toContain(copy.firstCheck.attention);
    expect(t).not.toContain('All quiet');
  });
  test('a reading with a stale price is not shown as a current move', () => {
    const t = text(createElement(FirstCheck, { o: firstDone({ latestCheck: { at: ago(1000), held: false, reading: { symbol: 'XLM', changePct: -0.4, from: 1, to: 1, stale: 1 } } }), now: NOW, moment: 'first' }));
    expect(t).not.toContain('moved');
  });
});

describe('the instruments on a new agent', () => {
  const cells = (o = overview()) => {
    const html = renderToStaticMarkup(createElement(Instruments, { o, now: NOW }));
    return Object.fromEntries([...html.matchAll(/data-instrument="(\w+)"(.*?)<\/dd>/gs)].map((m) => [m[1], { text: text(createElement('div', { dangerouslySetInnerHTML: { __html: m[2]!.replace(/^[^>]*>/, '') } })), dim: m[2]!.includes('text-fg-3 ') || /tabular-nums text-fg-3/.test(m[2]!) }]));
  };
  test('every instrument is always there, in the same place', () => {
    for (const o of [brandNew(), firstDone(), overview()]) expect(Object.keys(cells(o))).toEqual(['next', 'reading', 'checks', 'alerts', 'earned', 'budget']);
  });
  test('nothing read yet is a dim dash, never a made-up reading', () => {
    const c = cells(brandNew());
    expect(c.reading!.text).toContain('—');
    expect(c.reading!.dim).toBe(true);
    expect(c.checks!.dim).toBe(true);
  });
  test('the first reading shows as it arrives', () => {
    const c = cells(firstDone());
    expect(c.reading!.text).toContain('XLM −0.40%');
    expect(c.reading!.dim).toBe(false);
    expect(c.checks!.text).toContain('1');
  });
  test('a stale price is never shown as the last reading', () => {
    expect(cells(firstDone({ latestCheck: { at: ago(1000), held: false, reading: { symbol: 'XLM', changePct: -0.4, stale: 1 } } })).reading!.text).toContain('—');
  });
});

describe('the Today card', () => {
  const quiet = (range?: string) => [{ type: 'quiet' as const, at: ago(60_000), day: '2026-10-13', count: 16, ...(range ? { range, since: ago(4 * 3600_000) } : {}) }];
  const card = (o = overview({ checksToday: 62, alertsThisWeek: 0 }), feed: FeedItem[] = quiet('XLM between −0.2% and −1.1%'), draft: ReturnType<typeof sampleDraft> | null = sampleDraft()) =>
    createElement(TodayCard, { agentId: AGENT_ID, o, feed, draft, now: NOW });
  test('counts the checks and says the quiet was the service', () => {
    expect(text(card())).toContain('62 checks. Nothing worth your time.');
  });
  test('shows the range the price stayed in against the owner\'s line', () => {
    expect(text(card())).toContain('XLM stayed between −0.2% and −1.1%. Your limit is 5%.');
  });
  test('leaves out the limit when it cannot be known, and the range when the day left no readings', () => {
    expect(text(card(undefined, undefined, null))).toContain('XLM stayed between −0.2% and −1.1%.');
    expect(text(card(undefined, undefined, null))).not.toContain('limit');
    expect(text(card(undefined, quiet()))).not.toContain('stayed');
  });
  test('a price range uses the dollar limit, not the percent one', () => {
    const d = sampleDraft({ params: [{ id: 'level', label: 'Level', kind: 'number', value: 2, min: 1, max: 9, unit: '$' }], bindings: [{ param: 'level', path: '/triggers/0/params/level' }] });
    expect(text(card(undefined, quiet('XLM between $0.1901 and $0.1934'), d))).toContain('Your limit is $2.');
  });
  test('says how long it has been watching, and how many alerts this week', () => {
    const t = text(card(overview({ checksToday: 62, alertsThisWeek: 1, watchingSince: ago(3 * 86_400_000 + MIN) })));
    expect(t).toContain('3 days watching');
    expect(t).toContain('1 alert this week');
  });
  test('an alert sent today is said, not hidden behind "nothing worth your time"', () => {
    const t = text(card(overview({ checksToday: 62 }), [{ type: 'alert', at: ago(MIN), text: 'XLM fell 5.4% in an hour.' }, ...quiet()]));
    expect(t).toContain('62 checks. 1 alert sent today.');
    expect(t).not.toContain('Nothing worth your time');
  });
  test('asks about the morning note once, and not in italics', () => {
    const html = renderToStaticMarkup(card());
    expect(textOf(html)).toContain('Want a short note each morning?');
    expect(html).not.toMatch(/italic|<em/);
  });
});

describe('the morning note question', () => {
  const view = (answer: boolean | null, message: string | null = null) => text(createElement(MorningNoteView, { answer, busy: false, message, onChoose: () => {} }));
  test('is asked while unanswered, with two plain choices', () => {
    const t = view(null);
    expect(t).toContain('Want a short note each morning?');
    expect(t).toContain('Yes, please');
    expect(t).toContain('No thanks');
  });
  test('after yes it does not claim a note is coming today, and offers to turn it off', () => {
    const t = view(true);
    expect(t).toContain(copy.morningNote.on);
    expect(t).toContain('Turn off');
    expect(t).not.toContain('Want a short note');
  });
  test('after no it stays out of the way and offers to turn it on', () => {
    const t = view(false);
    expect(t).toContain(copy.morningNote.off);
    expect(t).toContain('Turn on');
  });
  test('a failed save says so in one plain line', () => {
    expect(view(null, copy.morningNote.failed)).toContain(copy.morningNote.failed);
  });
  test('the answer changes only after the server said ok', async () => {
    expect(await runMorningNote({ answer: null, busy: true, message: null }, true, async () => ({ ok: true }))).toEqual({ answer: true, busy: false, message: null });
    expect(await runMorningNote({ answer: null, busy: true, message: null }, true, async () => ({ ok: false }))).toEqual({ answer: null, busy: false, message: copy.morningNote.failed });
    expect(await runMorningNote({ answer: false, busy: true, message: null }, true, async () => { throw new Error('boom'); })).toEqual({ answer: false, busy: false, message: copy.morningNote.failed });
  });
  test('the action posts the yes or no to the owner api and nothing else', async () => {
    const calls: { path: string; method?: string; body?: unknown }[] = [];
    const api = async (path: string, o: { method?: string; body?: unknown }) => (calls.push({ path, ...o }), { status: 204, json: null } as ApiResult);
    const out = await createAgentActions({ api: api as never, token: async () => 't' }).setMorningNote(AGENT_ID, true);
    expect(out).toEqual({ ok: true });
    expect(calls).toEqual([{ path: `/api/agents/${AGENT_ID}/morning-note`, token: 't', method: 'POST', body: { on: true } } as never]);
    expect(await createAgentActions({ api: (async () => ({ status: 404, json: null })) as never, token: async () => 't' }).setMorningNote(AGENT_ID, false)).toEqual({ ok: false, status: 404 });
    expect(await createAgentActions({ api: api as never, token: async () => undefined }).setMorningNote(AGENT_ID, false)).toEqual({ ok: false, status: 401 });
    expect(await createAgentActions({ api: api as never, token: async () => 't' }).setMorningNote('nope', true)).toEqual({ ok: false, status: 400 });
  });
});

describe('the agent page puts it together', () => {
  const load = (o: ReturnType<typeof overview>, feed: AgentLoad extends infer _ ? never[] | unknown[] : never = [], draft = sampleDraft()) =>
    ({ kind: 'ready', id: AGENT_ID, overview: o, feed, draft }) as unknown as Extract<AgentLoad, { kind: 'ready' }>;
  const page = (l: Extract<AgentLoad, { kind: 'ready' }>) => renderToStaticMarkup(createElement(AgentView, { load: l, now: NOW }));
  test('a brand-new agent: the first check card, no zeros, no "Nothing yet", no Today card', () => {
    const html = page(load(brandNew()));
    const t = textOf(html).replace(/\s+/g, ' ');
    expect(t).toContain(copy.firstCheck.looking);
    expect(t).not.toMatch(/\b0 (checks|alerts)/);
    expect(t).not.toContain('Nothing yet');
    expect(html).not.toContain('data-today');
  });
  test('the first reading: the card leads, the feed follows', () => {
    const html = page(load(firstDone(), [{ type: 'quiet', at: ago(30_000), day: '2026-10-13', count: 1 }]));
    expect(html.indexOf('data-first-check')).toBeGreaterThan(-1);
    expect(html.indexOf('data-first-check')).toBeLessThan(html.indexOf('data-feed'));
  });
  test('a normal day: the Today card leads the feed and the strip no longer repeats the counts', () => {
    const html = page(load(overview({ checksToday: 62 }), [{ type: 'quiet', at: ago(60_000), day: '2026-10-13', count: 16 }]));
    expect(html.indexOf('data-today')).toBeGreaterThan(-1);
    expect(html.indexOf('data-today')).toBeLessThan(html.indexOf('data-feed'));
    expect(textOf(html)).not.toContain('62 checks today');
  });
  test('a paused agent with a long history shows no Today card', () => {
    expect(page(load(overview({ status: 'paused', checksToday: 0 })))).not.toContain('data-today');
  });
});

describe('loading the agent', () => {
  const UUID = AGENT_ID;
  const res = (json: unknown, status = 200): ApiResult => ({ status, json }) as ApiResult;
  test('the description\'s draft rides along so the card can name the owner\'s limit', async () => {
    const d = sampleDraft();
    const active = { version: 1, spec: d.spec, view: { sentence: d.sentence, params: d.params, bindings: d.bindings }, createdAt: '2026-10-10T00:00:00Z' };
    const load = createLoadAgent({
      token: async () => 't',
      api: (async (path: string) =>
        path.endsWith('/api/me') ? res({ agent: { id: UUID, name: 'n', status: 'active' } })
        : path.endsWith('/overview') ? res({ ...overview(), nextCheckAt: null })
        : path.includes('/activity') ? res([])
        : res({ active, draft: null })) as never,
    });
    const out = await load(UUID);
    expect(out.kind).toBe('ready');
    if (out.kind === 'ready') expect(out.draft?.params.find((p) => p.id === 'drop')?.value).toBe(5);
  });
});
