import { describe, expect, test } from 'bun:test';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { ActivityFeed } from '../src/components/activity-feed';
import { AgentHeader, Instruments } from '../src/components/agent-header';
import { liveLine } from '../src/components/agent-live';
import { Reschedule } from '../src/components/reschedule';
import { openRunRow, RunNowButton, runNowNote } from '../src/components/run-now';
import { copy } from '../src/copy';
import { asOverview, type RunNowOut } from '../src/lib/agent-types';
import type { DraftData } from '../src/lib/draft-types';
import { okZone, reschedule, timeParams } from '../src/lib/reschedule';
import { createAgentActions } from '../src/server/agent-actions';
import type { ApiResult } from '../src/server/api';
import { AGENT_ID, NOW, overview } from './support/agent';
import { sampleDraft } from './support/draft';
import { textOf } from './support/screens';

const R = copy.agent.run;
const text = (html: string) => textOf(html).replace(/\s+/g, ' ').trim();
const when = { id: 'when', label: 'When', kind: 'time' as const, presets: [{ label: 'morning', value: '0 8 * * *' }, { label: 'evening', value: '0 18 * * *' }], value: '0 18 * * *' };
const timed = (): DraftData =>
  sampleDraft({ sentence: ['Every ', { param: 'when' }, ' I write a digest.'], params: [when], bindings: [{ param: 'when', path: '/triggers/0/cron' }], spec: { ...sampleDraft().spec, triggers: [{ kind: 'cron', cron: '0 18 * * *', mission: 'm', tz: 'Europe/Istanbul' }] } });
const header = (o = overview(), draft?: DraftData) => renderToStaticMarkup(createElement(AgentHeader, { agentId: AGENT_ID, o, now: NOW, ...(draft ? { draft } : {}) }));

describe('Run now and Reschedule in the header', () => {
  test('a watching agent shows Run now; a paused one Resume and run; a resting one neither', () => {
    expect(header()).toContain('data-run-now="idle"');
    expect(text(header())).toContain(R.label);
    expect(header(overview({ status: 'paused' }))).toContain('data-run-now="paused"');
    expect(text(header(overview({ status: 'paused' })))).toContain(R.resumeAndRun);
    expect(header(overview({ status: 'paused', running: true }))).toContain('data-run-now="paused"');
    expect(header(overview({ status: 'stopped_today' }))).not.toContain('data-run-now');
  });

  test('while a check is running the button says so and cannot be pressed', () => {
    const h = header(overview({ running: true }));
    expect(h).toContain('data-run-now="running"');
    expect(text(h)).toContain(R.running);
    expect(h).toMatch(/<button[^>]*disabled[^>]*data-run-now="running"|<button[^>]*data-run-now="running"[^>]*disabled/);
  });

  test('Reschedule only for an agent that runs on a clock, paused or not', () => {
    expect(header(overview(), timed())).toContain('data-reschedule');
    expect(header(overview({ status: 'paused' }), timed())).toContain('data-reschedule');
    expect(header(overview(), sampleDraft())).not.toContain('data-reschedule');
    expect(header(overview())).not.toContain('data-reschedule');
    expect(renderToStaticMarkup(createElement(Reschedule, { agentId: AGENT_ID, draft: timed() }))).toContain(copy.agent.reschedule.label);
  });

  test('the live line and the instruments say checking now, and never show the claim lease as the next time', () => {
    const lone = liveLine(overview({ running: true, nextCheckAt: null }), NOW, true, 'UTC');
    expect([lone.now, lone.next, lone.busy]).toEqual([copy.agent.live.checking, copy.agent.live.nextAfter, true]);
    const other = liveLine(overview({ running: true, nextCheckAt: '2026-10-13T18:00:00Z' }), NOW, true, 'UTC');
    expect([other.now, other.at]).toEqual([copy.agent.live.checking, '18:00']);
    expect(text(renderToStaticMarkup(createElement(Instruments, { o: overview({ running: true }), now: NOW })))).toContain(copy.agent.instruments.running);
  });

  test('an older api answer without running reads as not running', () => {
    const { running: _, ...old } = overview();
    expect(asOverview(old)?.running).toBe(false);
    expect(asOverview({ ...old, running: true })?.running).toBe(true);
  });
});

describe('what a press leads to', () => {
  const at = () => '14:20';
  test('queued and running hand over to the header; a cooldown names its end; refusals are plain lines', () => {
    expect(runNowNote({ ok: true, state: 'queued' }, at)).toEqual({ running: true, note: null, error: false });
    expect(runNowNote({ ok: true, state: 'running' }, at)).toEqual({ running: true, note: null, error: false });
    expect(runNowNote({ ok: true, state: 'cooling_down', until: '2026-10-13T14:20:00Z' }, at)).toEqual({ running: false, note: R.cooling('14:20'), error: false });
    const msg = (o: RunNowOut) => runNowNote(o, at).note;
    expect(msg({ ok: false, status: 409, code: 'agent_paused' })).toBe(R.paused);
    expect(msg({ ok: false, status: 429, code: 'daily_limit' })).toBe(R.spent);
    expect(msg({ ok: false, status: 429, code: 'rate_limited' })).toBe(R.tooMany);
    expect(msg({ ok: false, status: 409, code: 'no_checks' })).toBe(R.noChecks);
    expect(msg({ ok: false, status: 503 })).toBe(R.failed);
  });

  test('the button can be rendered with a test runner', () => {
    expect(renderToStaticMarkup(createElement(RunNowButton, { agentId: AGENT_ID, running: false, run: async (): Promise<RunNowOut> => ({ ok: true, state: 'queued' }) }))).toContain(R.label);
  });
});

describe('the run now call', () => {
  const actions = (res: Partial<ApiResult>, seen: string[] = []) =>
    createAgentActions({ api: async (path, o) => (seen.push(`${o?.method} ${path}`), { status: 200, json: null, ...res } as ApiResult), token: async () => 'tok' });

  test('posts to the agent and reads the state', async () => {
    const seen: string[] = [];
    expect(await actions({ json: { state: 'queued', at: '2026-10-13T12:00:00Z' } }, seen).runNow(AGENT_ID)).toEqual({ ok: true, state: 'queued' });
    expect(seen).toEqual([`POST /api/agents/${AGENT_ID}/run`]);
    expect(await actions({ json: { state: 'cooling_down', until: '2026-10-13T14:20:00Z' } }).runNow(AGENT_ID)).toEqual({ ok: true, state: 'cooling_down', until: '2026-10-13T14:20:00Z' });
  });

  test('an error keeps its code; an odd body or a bad id is a failure, never a run', async () => {
    expect(await actions({ status: 429, json: { error: 'daily_limit' } }).runNow(AGENT_ID)).toEqual({ ok: false, status: 429, code: 'daily_limit' });
    expect(await actions({ status: 404, json: '<html>' as never }).runNow(AGENT_ID)).toEqual({ ok: false, status: 404 });
    expect(await actions({ json: { state: 'whatever' } }).runNow(AGENT_ID)).toEqual({ ok: false, status: 502 });
    expect(await actions({ json: { state: 'cooling_down' } }).runNow(AGENT_ID)).toEqual({ ok: false, status: 502 });
    expect(await actions({}).runNow('not-a-uuid')).toEqual({ ok: false, status: 400 });
  });
});

describe('reschedule', () => {
  test('taps the time, then saves exactly what came back with the person\'s zone', async () => {
    const saved: DraftData[] = [];
    const next = { ...timed(), params: [{ ...when, value: '30 19 * * *' }], spec: { ...timed().spec, triggers: [{ kind: 'cron', cron: '30 19 * * *', mission: 'm' }] } };
    const out = await reschedule({ tap: async () => ({ ok: true, draft: next }), save: async (d) => (saved.push(d), { ok: true }) }, 'when', '30 19 * * *', 'Europe/Istanbul');
    expect(out).toEqual({ ok: true });
    expect((saved[0]!.spec as unknown as { triggers: { tz?: string; cron: string }[] }).triggers[0]).toEqual({ kind: 'cron', cron: '30 19 * * *', mission: 'm', tz: 'Europe/Istanbul' } as never);
  });

  test('a refused tap saves nothing; a failed save says so; a throw is a plain failure', async () => {
    let saves = 0;
    const save = async () => (saves++, { ok: true });
    expect(await reschedule({ tap: async () => ({ ok: false, message: 'nope' }), save }, 'when', 'x', undefined)).toEqual({ ok: false, message: 'nope' });
    expect(await reschedule({ tap: async () => ({ ok: true, draft: { odd: 1 } }), save }, 'when', 'x', undefined)).toEqual({ ok: false, message: copy.agent.reschedule.failed });
    expect(saves).toBe(0);
    expect(await reschedule({ tap: async () => ({ ok: true, draft: timed() }), save: async () => ({ ok: false, message: 'later' }) }, 'when', 'x', undefined)).toEqual({ ok: false, message: 'later' });
    expect(await reschedule({ tap: async () => { throw new Error('x'); }, save }, 'when', 'x', undefined)).toEqual({ ok: false, message: copy.agent.reschedule.failed });
  });

  test('only clock knobs count, and only zone names pass', () => {
    expect(timeParams(timed()).map((p) => p.id)).toEqual(['when']);
    expect(timeParams(sampleDraft())).toEqual([]);
    expect([okZone('Europe/Istanbul'), okZone('UTC'), okZone('America/Argentina/Buenos_Aires'), okZone('Etc/GMT+3')]).toEqual(['Europe/Istanbul', 'UTC', 'America/Argentina/Buenos_Aires', 'Etc/GMT+3']);
    expect([okZone('../x'), okZone(''), okZone(42), okZone('a'.repeat(65))]).toEqual([undefined, undefined, undefined, undefined]);
  });
});

describe('the empty feed', () => {
  const empty = (firstRunAt: string | null) => text(renderToStaticMarkup(createElement(ActivityFeed, { agentId: AGENT_ID, now: NOW, items: [], firstRunAt })));
  test('a first run hours away is not "within a minute"', () => {
    expect(empty('2026-10-13T18:00:00Z')).toBe(copy.activity.emptyAt(null));
    expect(empty('2026-10-13T12:00:40Z')).toBe(copy.activity.empty);
    expect(empty(null)).toBe(copy.activity.empty);
  });
});

describe('where the result shows', () => {
  const RUN = '0b6e1d2c-3a4f-4b5c-8d9e-0f1a2b3c4d5e';
  const ran = { at: '2026-10-13T11:58:00Z', runId: RUN, ok: true };

  test('the overview carries the last run; an odd one is none', () => {
    expect(asOverview({ ...overview(), lastRun: ran })?.lastRun).toEqual(ran);
    expect(asOverview({ ...overview(), lastRun: { ...ran, runId: 'x' } })?.lastRun).toBeNull();
    expect(asOverview({ ...overview(), lastRun: undefined })?.lastRun).toBeNull();
  });

  test('a clock-driven agent\'s last run is its last check; the newer of run and check speaks', () => {
    const L = copy.agent.live;
    expect(liveLine(overview({ watchesCondition: false, latestCheck: null, lastRun: ran }), NOW, true, 'UTC').last).toBe(`2 min ago, ${L.ran}`);
    expect(liveLine(overview({ watchesCondition: false, latestCheck: null, lastRun: { ...ran, ok: false } }), NOW, true, 'UTC').last).toContain(L.failed);
    // The fixture's check (11:57) is older than the run (11:58): the run speaks. A newer check speaks over an older run.
    expect(liveLine(overview({ lastRun: ran }), NOW, true, 'UTC').last).toContain(L.ran);
    expect(liveLine(overview({ lastRun: { ...ran, at: '2026-10-13T10:00:00Z' } }), NOW, true, 'UTC').last).toContain(L.quiet);
  });

  test('a scheduled agent\'s finished run reads "Done", plainly; a watcher\'s still reads as an alert', () => {
    const item = { type: 'alert' as const, at: '2026-10-13T11:58:00Z', runId: RUN, text: 'Digest sent: TVL up 3%.' };
    const feed = (scheduled: boolean) => renderToStaticMarkup(createElement(ActivityFeed, { agentId: AGENT_ID, now: NOW, items: [item], scheduled }));
    expect(feed(true)).toContain('data-ran');
    expect(text(feed(true))).toContain(`${copy.activity.ran} Digest sent: TVL up 3%.`);
    expect(feed(true)).not.toContain('text-danger');
    expect(text(feed(false))).toContain(copy.activity.alert);
    const cells = (o: ReturnType<typeof overview>) => text(renderToStaticMarkup(createElement(Instruments, { o, now: NOW })));
    expect(cells(overview({ watchesCondition: false }))).toContain(copy.agent.instruments.runs);
    expect(cells(overview())).toContain(copy.agent.instruments.alerts);
  });

  test('"See the result" opens the row in place when it is on screen, else it is a plain link', () => {
    const clicks: string[] = [];
    const button = { getAttribute: () => 'false', click: () => clicks.push('open') };
    const row = { offsetParent: {}, querySelector: () => button, getBoundingClientRect: () => ({ top: 200, bottom: 300 }), scrollIntoView: () => clicks.push('scroll') };
    const g = globalThis as unknown as { window?: unknown; document?: unknown };
    const [w, d] = [g.window, g.document];
    g.window = { innerHeight: 800, matchMedia: () => ({ matches: false }) };
    g.document = { querySelector: () => null };
    try {
      expect(openRunRow(RUN, { querySelector: ((sel: string) => (sel === `[data-run-id="${RUN}"]` ? row : null)) as never })).toBe(true);
      expect(clicks).toEqual(['open']);
      expect(openRunRow(RUN, { querySelector: (() => ({ ...row, offsetParent: null })) as never })).toBe(false);
      expect(openRunRow(RUN, { querySelector: (() => null) as never })).toBe(false);
    } finally {
      g.window = w;
      g.document = d;
    }
  });

  test('the button takes the last run without showing it before a press', () => {
    expect(renderToStaticMarkup(createElement(RunNowButton, { agentId: AGENT_ID, running: false, lastRun: ran }))).not.toContain('data-run-result');
  });
});

describe('header buttons answer at once', () => {
  test('a paused run that cannot resume says why', () => {
    expect(runNowNote({ ok: false, status: 409, code: 'not_resumed' }, String)).toEqual({ running: false, note: R.notResumed, error: true });
  });

  test('Pause shows "Pausing…" with the seal while the server answers', async () => {
    const { PauseButton } = await import('../src/components/pause-button');
    const { renderToStaticMarkup } = await import('react-dom/server');
    const h = renderToStaticMarkup(createElement(PauseButton, { agentId: AGENT_ID, paused: false }));
    expect(h).toContain('data-pause=""');
    expect(copy.agent.pausing).toBe('Pausing…');
    expect(copy.agent.resuming).toBe('Resuming…');
  });
});
