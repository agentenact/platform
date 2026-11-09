import { describe, expect, test } from 'bun:test';
import { createElement } from 'react';
import { AppRouterContext } from 'next/dist/shared/lib/app-router-context.shared-runtime';
import { renderToStaticMarkup } from 'react-dom/server';
import { ActivityFeed } from '../src/components/activity-feed';
import { AgentHeader, Instruments } from '../src/components/agent-header';
import { liveLine } from '../src/components/agent-live';
import { ChatView } from '../src/components/chat';
import { initialChat } from '../src/lib/chat';
import { AgentError, AgentScreen, AgentView } from '../src/components/agent-screen';
import { LiveRefresh } from '../src/components/live-refresh';
import { ERROR_RETRY_SECONDS } from '../src/lib/agent-moment';
import { AgentTabs } from '../src/components/agent-tabs';
import { PauseButton } from '../src/components/pause-button';
import { deleteFailure } from '../src/components/delete-agent';
import { copy, statusWord } from '../src/copy';
import { ago, dayWord, formatUsdc, safeUrl, untilNext } from '../src/lib/agent-format';
import { asFeed, asOverview } from '../src/lib/agent-types';
import { runPause } from '../src/lib/pause';
import { createAgentActions } from '../src/server/agent-actions';
import { createLoadAgent, type AgentLoad } from '../src/server/agent-data';
import type { ApiCall, ApiResult } from '../src/server/api';
import { AGENT_ID, feed, NOW, overview } from './support/agent';
import { textOf } from './support/screens';

const header = (o = overview()) => renderToStaticMarkup(createElement(AgentHeader, { agentId: AGENT_ID, o, now: NOW }));
const instruments = (o = overview()) => renderToStaticMarkup(createElement(Instruments, { o, now: NOW }));
const text = (html: string) => textOf(html).replace(/\s+/g, ' ').trim();

describe('header', () => {
  test('shows the status word for each status', () => {
    for (const status of ['watching', 'paused', 'stopped_today', 'stopped'] as const) expect(text(header(overview({ status })))).toContain(statusWord(status));
  });
  test('the instruments count down to the next check and say when the last alert was', () => {
    const t = text(instruments());
    expect(t).toContain('Next check 3:00');
    expect(t).toContain('last yesterday');
    expect(text(header())).toContain('XLM drop watcher');
  });
  test('no alert yet, and a due check, are plain', () => {
    const t = text(instruments(overview({ lastAlertAt: null, nextCheckAt: '2026-10-13T11:59:59Z' })));
    expect(t).toContain('Next check due now');
    expect(t).toContain('none yet');
  });
  test('a paused agent shows Resume and no countdown; a stopped one has no button', () => {
    const paused = overview({ status: 'paused' });
    expect(text(header(paused))).toContain('Resume');
    expect(text(instruments(paused))).toContain('Next check paused');
    expect(header(overview({ status: 'stopped' }))).not.toContain('data-pause');
  });
  test('an agent getting ready (waiting for its first USDC) has no Run, Resume or Reschedule, and says it starts on its own', () => {
    const ready = overview({ status: 'getting_ready', nextCheckAt: null });
    const h = header(ready);
    expect(text(h)).toContain(statusWord('getting_ready'));
    expect(text(h)).toContain(copy.agent.live.gettingReady);
    expect(text(h)).toContain(copy.agent.live.nextReady);
    expect(h).not.toContain('data-pause');
    expect(h).not.toContain('data-run-now');
    expect(text(h)).not.toContain('Resume');
    expect(text(instruments(ready))).toContain(`Next check ${copy.agent.instruments.gettingReady}`);
  });
  test('stopped for today says when it starts again', () => {
    const t = text(header(overview({ status: 'stopped_today' })));
    expect(t).toContain(copy.agent.live.resting);
    expect(t).toContain('Next check tomorrow');
  });
});

describe('live line', () => {
  const L = copy.agent.live;
  test('watching: waiting, a countdown, and how the last check went', () => {
    const t = text(header());
    expect(t).toContain(`Now ${L.waiting}`);
    expect(t).toContain('Next check in 3:00');
    expect(t).toContain('Last check 3 min ago, all quiet');
  });
  test('the server never shows a wall-clock time; the browser adds one in its own zone', () => {
    expect(liveLine(overview(), NOW, false).at).toBeNull();
    expect(liveLine(overview(), NOW, true, 'Europe/Istanbul').at).toBe('15:03');
    expect(liveLine(overview({ nextCheckAt: '2026-10-14T05:00:00Z' }), NOW, true, 'Europe/Istanbul').at).toBe('Wed 08:00');
  });
  test('a due check is "Checking now"', () => {
    const l = liveLine(overview({ nextCheckAt: '2026-10-13T11:59:00Z' }), NOW, true);
    expect([l.now, l.next, l.busy]).toEqual([L.checking, L.nextSoon, true]);
  });
  test('paused, stopped and no check yet are plain', () => {
    expect(liveLine(overview({ status: 'paused', nextCheckAt: null }), NOW, true)).toMatchObject({ now: L.paused, next: L.nextResume, at: null });
    expect(liveLine(overview({ status: 'stopped' }), NOW, true)).toMatchObject({ now: L.stopped, next: L.none });
    expect(liveLine(overview({ latestCheck: null }), NOW, true).last).toBe(L.noCheck);
    expect(liveLine(overview({ latestCheck: { at: '2026-10-13T11:59:30Z', held: true, reading: null } }), NOW, true).last).toBe(`just now, ${L.worth}`);
    expect(liveLine(overview({ latestCheck: { at: '2026-10-13T11:59:30Z', held: null, reading: null } }), NOW, true).last).toBe(`just now, ${L.failed}`);
  });
});

describe('paused chat', () => {
  test('offers a real Resume button and a plain placeholder, never "Resume to chat"', () => {
    const html = renderToStaticMarkup(createElement(ChatView, { state: initialChat, paused: true }));
    expect(html).toMatch(/<button[^>]*data-chat-resume[^>]*>Resume the agent<\/button>/);
    expect(html).not.toMatch(/<button[^>]*disabled=""[^>]*data-chat-resume/);
    expect(html).toContain(`placeholder="${copy.chat.pausedPlaceholder}"`);
    expect(html).not.toContain('Resume to chat');
    expect(html).not.toContain('data-send');
  });
  test('a failed resume says so; a running agent has Send', () => {
    expect(text(renderToStaticMarkup(createElement(ChatView, { state: initialChat, paused: true, resumeFailed: true })))).toContain(copy.agent.resumeFailed);
    // Getting ready: its own placeholder, and no Resume button (it starts on its own).
    const ready = renderToStaticMarkup(createElement(ChatView, { state: initialChat, paused: true, gettingReady: true }));
    expect(ready).toContain(copy.chat.gettingReadyPlaceholder);
    expect(ready).not.toContain('data-chat-resume');
    const html = renderToStaticMarkup(createElement(ChatView, { state: initialChat, paused: false }));
    expect(html).toContain('data-send');
    expect(html).not.toContain('data-chat-resume');
  });
});

describe('header panel', () => {
  test('is one sand panel: eyebrow, name, a green Watching pill, Pause as a quiet button', () => {
    const html = header();
    expect(html.match(/panel-sand/g)).toHaveLength(1);
    expect(text(html)).toContain('Your agent');
    expect(html).toMatch(/<h1[^>]*>XLM drop watcher<\/h1>/);
    expect(html).toMatch(/data-status="watching"[^>]*>(?:(?!<\/p>|<\/span><\/span>).)*dot-green/s);
    expect(text(html)).toContain('Watching');
    expect(html).toMatch(/<button[^>]*data-variant="quiet"[^>]*data-pause|<button[^>]*data-pause[^>]*data-variant="quiet"/);
  });
  test('a long sentence is clamped to three lines', () => {
    expect(renderToStaticMarkup(createElement(AgentHeader, { agentId: AGENT_ID, o: overview(), now: NOW, sentence: 'x' }))).toContain('line-clamp-3');
  });
  test('a paused agent has a Paused pill without the green dot', () => {
    const html = header(overview({ status: 'paused' }));
    expect(text(html)).toContain('Paused');
    expect(html).not.toContain('dot-green');
  });
  test('it carries the plain sentence of what it does when given one', () => {
    const html = renderToStaticMarkup(createElement(AgentHeader, { agentId: AGENT_ID, o: overview(), now: NOW, sentence: 'Every 5 minutes I look at XLM.' }));
    expect(text(html)).toContain('Every 5 minutes I look at XLM.');
    expect(text(header())).not.toContain('Every 5 minutes');
  });
});

describe('the instrument row', () => {
  const row = (o = overview()) => text(instruments(o));
  test('reads checks today with the running total, and alerts this week', () => {
    expect(row()).toContain('Checks today 288');
    expect(row()).toContain('Alerts, 7 days 1');
  });
  test('earned names testnet, and the sale count once there is one', () => {
    expect(row()).toContain('Earned, testnet USDC 0.003 3 proven sales, testnet');
    expect(row(overview({ salesCount: 0, earnedUsdc: '0' }))).toContain('Earned, testnet USDC 0 no sale yet');
  });
  test('the free budget is a number with a meter', () => {
    expect(row(overview({ budgetUsedPct: 4 }))).toContain('Free budget today 4%');
    expect(instruments(overview({ budgetUsedPct: 100, status: 'stopped_today' }))).toContain('width:100%');
  });
});

describe('activity feed', () => {
  const quietRow = (extra: Record<string, unknown>) =>
    text(renderToStaticMarkup(createElement(ActivityFeed, { agentId: AGENT_ID, now: NOW, items: [{ type: 'quiet', at: '2026-10-13T11:55:00Z', day: '2026-10-13', count: 16, ...extra } as never] })));
  test('a quiet row with a range says when it started, how many checks and what the price did', () => {
    expect(quietRow({ since: '2026-10-13T09:15:00Z', range: 'XLM between −0.2% and −1.1%' })).toContain('Quiet since 09:15: 16 checks, XLM between −0.2% and −1.1%');
    expect(quietRow({ since: '2026-10-13T09:15:00Z', range: 'XLM between $0.1901 and $0.1934' })).toContain('Quiet since 09:15: 16 checks, XLM between $0.1901 and $0.1934');
  });
  test('without a range, or with one that is not plain, it is the old quiet line', () => {
    expect(quietRow({})).toContain('Checked 16 times today. All quiet, spent nothing.');
    expect(quietRow({ since: '2026-10-13T09:15:00Z', range: 'the settlement hash moved' })).toContain('Checked 16 times today. All quiet, spent nothing.');
    expect(quietRow({ since: 'soon', range: 'XLM at $0.19' })).toContain('Checked 16 times today.');
  });
  test('a quiet row of an earlier day names the day', () => {
    expect(quietRow({ day: '2026-10-12', since: '2026-10-12T09:15:00Z', range: '3 payments seen' })).toContain('Quiet yesterday from 09:15: 16 checks, 3 payments seen');
  });
  test('asFeed keeps a good range and since, and drops a bad one', () => {
    const base = { type: 'quiet' as const, at: '2026-10-13T11:55:00Z', day: '2026-10-13', count: 2 };
    expect(asFeed([{ ...base, range: 'XLM at $0.19', since: '2026-10-13T09:15:00Z' }])![0]).toEqual({ ...base, range: 'XLM at $0.19', since: '2026-10-13T09:15:00Z' });
    expect(asFeed([{ ...base, range: 5, since: 'x' }])![0]).toEqual(base);
    expect(asFeed([{ ...base, range: 'a'.repeat(300), since: '2026-10-13T09:15:00Z' }])![0]).toEqual(base);
  });

  test('twenty quiet checks are one line; an alert is danger-red text; a sale is green with a proof link to the proofUrl', () => {
    const html = renderToStaticMarkup(
      createElement(ActivityFeed, { agentId: AGENT_ID,
        now: NOW,
        items: [
          { type: 'quiet', at: '2026-10-13T11:55:00Z', day: '2026-10-13', count: 20 },
          { type: 'alert', at: '2026-10-12T09:14:00Z', text: 'XLM fell 5.8% in an hour.' },
          { type: 'sale', at: '2026-10-13T08:05:00Z', usdc: '0.0010000', proofUrl: 'https://agentenact.io/verify?agent=a&tx=b' },
        ],
      }),
    );
    expect(html.match(/data-item="quiet"/g)).toHaveLength(1);
    expect(text(html)).toContain('Checked 20 times today. All quiet, spent nothing.');
    const alert = html.slice(html.indexOf('data-item="alert"'), html.indexOf('data-item="sale"'));
    expect(alert).toContain('text-danger');
    expect(alert).toContain('XLM fell 5.8% in an hour.');
    const sale = html.slice(html.indexOf('data-item="sale"'));
    expect(sale).toContain('text-proven');
    expect(sale).toContain('Sold for 0.001 USDC on testnet');
    expect(sale).toMatch(/<a href="https:\/\/agentenact\.io\/verify\?agent=a&amp;tx=b" target="_blank" rel="noopener noreferrer"[^>]*>proof ↗<\/a>/);
  });
  test('a sale without proofUrl shows no link, and an unsafe address is never linked', () => {
    const one = (proofUrl?: string) =>
      renderToStaticMarkup(createElement(ActivityFeed, { agentId: AGENT_ID, now: NOW, items: [{ type: 'sale', at: '2026-10-13T08:05:00Z', usdc: '0.001', ...(proofUrl ? { proofUrl } : {}) }] }));
    expect(one()).not.toContain('<a ');
    expect(one('javascript:alert(1)')).not.toContain('<a ');
    expect(one('http://agentenact.io/verify?agent=a&tx=b')).not.toContain('<a '); // https only
    expect(one('https://agentenact.io/verify?agent=a&tx=b')).toContain('<a ');
    expect(one()).toContain('Sold for 0.001 USDC on testnet');
  });
  test('a problem is one plain line, and an alert text is escaped', () => {
    const html = renderToStaticMarkup(
      createElement(ActivityFeed, { agentId: AGENT_ID, now: NOW, items: [{ type: 'problem', at: '2026-10-13T08:05:00Z' }, { type: 'alert', at: '2026-10-13T08:00:00Z', text: '<img src=x onerror=1>' }] }),
    );
    expect(text(html)).toContain('A check could not finish.');
    expect(html).not.toContain('<img');
  });
  test('the feed is one white card, rows separated by hairlines, each row one element', () => {
    const html = renderToStaticMarkup(createElement(ActivityFeed, { agentId: AGENT_ID, now: NOW, items: feed() }));
    expect(html.match(/data-feed=""/g)).toHaveLength(1);
    expect(html).toMatch(/class="card[^"]*"[^>]*data-feed|data-feed=""[^>]*class="card/);
    expect(html).toContain('divide-y');
    expect(html.match(/<li /g)).toHaveLength(4);
    expect(html).not.toContain('bg-accent/15'); // no tinted boxes inside the card
  });
  test('rows that come from a run carry its id for the run details; others do not', () => {
    const html = renderToStaticMarkup(
      createElement(ActivityFeed, { agentId: AGENT_ID,
        now: NOW,
        items: [
          { type: 'alert', at: '2026-10-12T09:14:00Z', runId: 'run-a', text: 'x' },
          { type: 'sale', at: '2026-10-13T08:05:00Z', runId: 'run-b', usdc: '0.001' },
          { type: 'problem', at: '2026-10-12T07:00:00Z', runId: 'run-c' },
          { type: 'quiet', at: '2026-10-13T11:55:00Z', day: '2026-10-13', count: 2 },
        ],
      }),
    );
    for (const id of ['run-a', 'run-b', 'run-c']) expect(html).toContain(`data-run-id="${id}"`);
    expect(html.match(/data-run-id/g)).toHaveLength(3);
  });
  test('empty state', () => {
    expect(text(renderToStaticMarkup(createElement(ActivityFeed, { agentId: AGENT_ID, now: NOW, items: [] })))).toContain('Nothing yet. Your first check runs within a minute.');
  });
  test('keeps the api order (newest first)', () => {
    const html = renderToStaticMarkup(createElement(ActivityFeed, { agentId: AGENT_ID, now: NOW, items: feed() }));
    expect([...html.matchAll(/data-item="(\w+)"/g)].map((m) => m[1])).toEqual(['sale', 'quiet', 'alert', 'problem']);
  });
});

describe('tabs', () => {
  test('are pills that scroll sideways instead of wrapping; the current one is ink', () => {
    const html = renderToStaticMarkup(createElement(AgentTabs, { agentId: AGENT_ID, active: 'chat' }));
    expect(html).toContain('overflow-x-auto');
    expect(html).not.toContain('flex-wrap');
    expect(html).toContain('whitespace-nowrap');
    expect(html).toContain('motion-safe:transition-colors');
    expect(html).not.toMatch(/(?<!motion-safe:)transition-colors/);
    expect(html.match(/rounded-full/g)?.length).toBeGreaterThanOrEqual(4);
    expect(html.match(/\bh-11\b/g)).toHaveLength(5); // 44px tap targets
    const current = html.slice(html.indexOf('aria-current="page"'));
    expect(current.slice(0, current.indexOf('</a>'))).toContain('bg-fg');
    expect(current.slice(0, current.indexOf('</a>'))).toContain('Chat');
  });
  test('link to the five tabs and mark the current one', () => {
    const html = renderToStaticMarkup(createElement(AgentTabs, { agentId: AGENT_ID, active: 'activity' }));
    for (const tab of ['', '?tab=chat', '?tab=edit', '?tab=skills', '?tab=earnings']) expect(html).toContain(`href="/dashboard/${AGENT_ID}${tab}"`);
    expect(html.match(/aria-current="page"/g)).toHaveLength(1);
    expect(text(html)).toBe('Activity Chat What it does Skills Earnings');
  });
});

describe('pause', () => {
  test('Pause posts pause and the state becomes Resume only after the server answers', async () => {
    const calls: boolean[] = [];
    let release!: (v: { ok: boolean }) => void;
    const pending = new Promise<{ ok: boolean }>((r) => (release = r));
    const p = runPause({ paused: false, busy: true, message: null }, (want) => (calls.push(want), pending));
    let settled = false;
    void p.then(() => (settled = true));
    await Promise.resolve();
    expect(settled).toBe(false);
    expect(calls).toEqual([true]);
    release({ ok: true });
    expect(await p).toEqual({ paused: true, busy: false, message: null });
  });
  test('a failed pause keeps the button and says so plainly; a throw too', async () => {
    expect(await runPause({ paused: false, busy: true, message: null }, async () => ({ ok: false }))).toEqual({ paused: false, busy: false, message: copy.agent.pauseFailed });
    expect(await runPause({ paused: true, busy: true, message: null }, async () => Promise.reject(new Error('x')))).toEqual({ paused: true, busy: false, message: copy.agent.resumeFailed });
  });
  test('a resume refused with 409 (still getting ready) says it starts on its own, not "try again"', async () => {
    expect(await runPause({ paused: true, busy: true, message: null }, async () => ({ ok: false, status: 409 }))).toEqual({ paused: true, busy: false, message: copy.agent.resumeGettingReady });
    expect(await runPause({ paused: true, busy: true, message: null }, async () => ({ ok: false, status: 503 }))).toEqual({ paused: true, busy: false, message: copy.agent.resumeFailed });
    // A pause is never "getting ready".
    expect(await runPause({ paused: false, busy: true, message: null }, async () => ({ ok: false, status: 409 }))).toEqual({ paused: false, busy: false, message: copy.agent.pauseFailed });
  });
  test('the button renders its current label', () => {
    expect(text(renderToStaticMarkup(createElement(PauseButton, { agentId: AGENT_ID, paused: false, run: async () => ({ ok: true }) })))).toBe('Pause');
    expect(text(renderToStaticMarkup(createElement(PauseButton, { agentId: AGENT_ID, paused: true, run: async () => ({ ok: true }) })))).toBe('Resume');
  });
  test('the server action is ok only on 204, posts to the right route with the token', async () => {
    const seen: { path: string; method?: string; token?: string }[] = [];
    const mk = (status: number): ApiCall => async (path, o) => (seen.push({ path, ...(o?.method ? { method: o.method } : {}), ...(o?.token ? { token: o.token } : {}) }), { status, json: null });
    const act = (status: number) => createAgentActions({ api: mk(status), token: async () => 'tok' });
    expect(await act(204).setPaused(AGENT_ID, true)).toEqual({ ok: true });
    expect(await act(204).setPaused(AGENT_ID, false)).toEqual({ ok: true });
    expect(seen).toEqual([
      { path: `/api/agents/${AGENT_ID}/pause`, method: 'POST', token: 'tok' },
      { path: `/api/agents/${AGENT_ID}/resume`, method: 'POST', token: 'tok' },
    ]);
    expect(await act(200).setPaused(AGENT_ID, true)).toEqual({ ok: false, status: 200 });
    expect(await act(409).setPaused(AGENT_ID, true)).toEqual({ ok: false, status: 409 });
    expect(await act(503).setPaused(AGENT_ID, true)).toEqual({ ok: false, status: 503 });
  });
  test('delete is ok only on 202, sends DELETE to the agent, and names a refusal plainly', async () => {
    const seen: { path: string; method?: string }[] = [];
    const mk = (status: number): ApiCall => async (path, o) => (seen.push({ path, ...(o?.method ? { method: o.method } : {}) }), { status, json: null });
    const act = (status: number) => createAgentActions({ api: mk(status), token: async () => 'tok' });
    expect(await act(202).remove(AGENT_ID)).toEqual({ ok: true });
    expect(seen).toEqual([{ path: `/api/agents/${AGENT_ID}`, method: 'DELETE' }]);
    expect(await act(204).remove(AGENT_ID)).toEqual({ ok: false, status: 204 });
    expect(await act(202).remove('nope')).toEqual({ ok: false, status: 400 });
    expect(deleteFailure({ ok: false, status: 409 })).toBe(copy.agent.remove.settingUp);
    expect(deleteFailure({ ok: false, status: 503 })).toBe(copy.agent.remove.failed);
    expect(deleteFailure({ ok: true })).toBeNull();
  });
  test('no session, a bad id and a thrown call are failures, never a throw', async () => {
    const api: ApiCall = async () => Promise.reject(new Error('boom'));
    expect(await createAgentActions({ api, token: async () => undefined }).setPaused(AGENT_ID, true)).toEqual({ ok: false, status: 401 });
    expect(await createAgentActions({ api, token: async () => 't' }).setPaused('nope', true)).toEqual({ ok: false, status: 400 });
    expect(await createAgentActions({ api, token: async () => 't' }).setPaused(AGENT_ID, true)).toEqual({ ok: false, status: 503 });
  });
});

const ME: ApiResult = { status: 200, json: { agent: { id: AGENT_ID, name: 'XLM drop watcher', status: 'active' } } };
const router = (routes: Record<string, ApiResult>): ApiCall => async (path) => routes[path.replace(AGENT_ID, ':id')] ?? { status: 404, json: null };
const loader = (routes: Record<string, ApiResult>, token: string | null = 'tok') => createLoadAgent({ token: async () => token ?? undefined, api: router(routes) });
const GOOD = {
  '/api/me': ME,
  '/api/agents/:id/overview': { status: 200, json: overview() },
  '/api/agents/:id/activity?days=7': { status: 200, json: feed() },
};

describe('loading', () => {
  test('reads me, overview and activity with the visitor token', async () => {
    const seen: string[] = [];
    const api: ApiCall = async (path, o) => (seen.push(`${path}|${o?.token}`), router(GOOD)(path, o));
    const out = await createLoadAgent({ token: async () => 'tok', api })(AGENT_ID);
    expect(out.kind).toBe('ready');
    expect(seen).toEqual([`/api/me|tok`, `/api/agents/${AGENT_ID}/spec|tok`, `/api/agents/${AGENT_ID}/overview|tok`, `/api/agents/${AGENT_ID}/activity?days=7|tok`]);
  });
  test('the header sentence is read alongside the feed; a failed read leaves it out and the page still loads', async () => {
    const spec = { active: { version: 1, spec: { persona: '', system_prompt: '', skills: [] }, view: { sentence: ['Every ', { param: 'n' }, ' minutes I look.'], params: [{ id: 'n', kind: 'number', label: 'N', value: 5, min: 1, max: 60, step: 1 }], bindings: [] } }, draft: null };
    const ok = await loader({ ...GOOD, '/api/agents/:id/spec': { status: 200, json: spec } })(AGENT_ID);
    expect(ok.kind === 'ready' && ok.sentence).toBe('Every 5 minutes I look.');
    for (const bad of [{ status: 503, json: null }, { status: 200, json: { x: 1 } }]) {
      const out = await loader({ ...GOOD, '/api/agents/:id/spec': bad })(AGENT_ID);
      expect(out.kind).toBe('ready');
      expect(out.kind === 'ready' && out.sentence).toBeUndefined();
    }
    const throwing: ApiCall = async (path, o) => (path.endsWith('/spec') ? Promise.reject(new Error('x')) : router(GOOD)(path, o));
    expect((await createLoadAgent({ token: async () => 't', api: throwing })(AGENT_ID)).kind).toBe('ready');
  });
  test('a spec read that never answers does not hold the page', async () => {
    const hang: ApiCall = (path, o) => (path.endsWith('/spec') ? new Promise<ApiResult>(() => {}) : router(GOOD)(path, o));
    const out = await createLoadAgent({ token: async () => 't', api: hang, sentenceTimeoutMs: 20 })(AGENT_ID);
    expect(out.kind).toBe('ready');
    expect(out.kind === 'ready' && out.sentence).toBeUndefined();
  });
  test('the spec read starts together with the overview, not after it', async () => {
    const started: string[] = [];
    const api: ApiCall = (path, o) => (started.push(path.split('/').pop()!), router(GOOD)(path, o));
    await createLoadAgent({ token: async () => 't', api })(AGENT_ID);
    expect(started.indexOf('spec')).toBeLessThan(started.indexOf('overview') + 2);
    expect(started.indexOf('spec')).toBeLessThan(started.indexOf('activity?days=7'));
  });
  test('the page header shows the sentence when there is one', () => {
    const load = { ...ready(), sentence: 'Every 5 minutes I look at XLM.' } as Extract<AgentLoad, { kind: 'ready' }>;
    expect(text(renderToStaticMarkup(createElement(AgentView, { load, now: NOW })))).toContain('Every 5 minutes I look at XLM.');
  });
  test('no session and no agent are redirects', async () => {
    expect((await loader(GOOD, null)(AGENT_ID)).kind).toBe('signed_out');
    expect((await loader({ '/api/me': { status: 401, json: { error: 'unauthorized' } } })(AGENT_ID)).kind).toBe('signed_out');
    expect((await loader({ '/api/me': { status: 200, json: { agent: null } } })(AGENT_ID)).kind).toBe('no_agent');
  });
  test('a 503 with an HTML body renders the plain error state', async () => {
    const api: ApiCall = async () => ({ status: 503, json: null });
    expect((await createLoadAgent({ token: async () => 't', api })(AGENT_ID)).kind).toBe('error');
    for (const status of [404, 500, 502, 504]) expect((await loader({ ...GOOD, '/api/agents/:id/overview': { status, json: null } })(AGENT_ID)).kind).toBe('error');
    expect((await loader({ ...GOOD, '/api/agents/:id/activity?days=7': { status: 503, json: null } })(AGENT_ID)).kind).toBe('error');
    const throwing = createLoadAgent({ token: async () => 't', api: async () => Promise.reject(new Error('<html>Bad Gateway</html>')) });
    expect((await throwing(AGENT_ID)).kind).toBe('error');
    const html = renderToStaticMarkup(createElement(AgentError));
    expect(text(html)).toContain("We can't load this right now. Try again in a minute.");
    expect(html).toContain('href="/dashboard"');
    expect(html).not.toContain('html>');
    // it retries on its own: one failed first read must not leave the page stuck until a manual reload
    const found: unknown[] = [];
    const walk = (n: unknown): void => {
      if (!n || typeof n !== 'object') return;
      const el = n as { type?: unknown; props?: { seconds?: number; children?: unknown } };
      if (el.type === LiveRefresh) found.push(el.props?.seconds);
      const c = el.props?.children;
      (Array.isArray(c) ? c : [c]).forEach(walk);
    };
    walk(AgentError());
    expect(found).toEqual([ERROR_RETRY_SECONDS]);
  });
  test('a malformed answer is an error, not a crash', async () => {
    expect((await loader({ ...GOOD, '/api/agents/:id/overview': { status: 200, json: { name: 1 } } })(AGENT_ID)).kind).toBe('error');
    expect((await loader({ ...GOOD, '/api/agents/:id/activity?days=7': { status: 200, json: { not: 'a list' } } })(AGENT_ID)).kind).toBe('error');
    // A malformed agent entry is dropped: the wanted agent is then not one of theirs.
    expect((await loader({ ...GOOD, '/api/me': { status: 200, json: { agent: { id: 'not-a-uuid' } } } })(AGENT_ID)).kind).toBe('no_agent');
  });
  test('setting_up skips the feed', async () => {
    const out = await loader({ '/api/me': ME, '/api/agents/:id/overview': { status: 200, json: overview({ status: 'setting_up' }) } })(AGENT_ID);
    expect(out.kind === 'ready' && out.feed).toEqual([]);
  });
});

const redirectOf = (p: Promise<unknown>) => p.then(() => null, (e: { digest?: string }) => e.digest ?? String(e));
const ready = (o = overview()): AgentLoad => ({ kind: 'ready', id: AGENT_ID, overview: o, feed: feed() });

describe('AgentScreen (server)', () => {
  test('no session redirects to the first screen; an agent that is not theirs goes to My agents', async () => {
    expect(await redirectOf(AgentScreen({ id: AGENT_ID, load: async () => ({ kind: 'signed_out' }) }))).toMatch(/^NEXT_REDIRECT;[a-z]+;\/;/);
    expect(await redirectOf(AgentScreen({ id: AGENT_ID, load: async () => ({ kind: 'no_agent' }) }))).toMatch(/^NEXT_REDIRECT;[a-z]+;\/dashboard;/);
  });
  test('an error shows the plain state', async () => {
    expect(renderToStaticMarkup(await AgentScreen({ id: AGENT_ID, load: async () => ({ kind: 'error' }) }))).toContain('data-agent-error');
  });
  test('the offer sits below the feed as a banner, never above the tabs', async () => {
    const html = renderToStaticMarkup(createElement(AgentView, { load: ready() as Extract<AgentLoad, { kind: 'ready' }>, now: NOW, sell: createElement('p', { 'data-sell': '' }, 'OFFER') }));
    expect(html.indexOf('data-feed')).toBeLessThan(html.indexOf('OFFER'));
    expect(html.indexOf('data-pause')).toBeLessThan(html.indexOf('data-instruments'));
    expect(html.indexOf('data-instruments')).toBeLessThan(html.indexOf('data-tab="activity"'));
  });
  test('an active agent shows header, numbers, tabs and the feed', async () => {
    const html = renderToStaticMarkup(await AgentScreen({ id: AGENT_ID, load: async () => ready(), now: NOW }));
    const t = text(html);
    expect(t).toContain('XLM drop watcher');
    expect(t).toContain('Watching');
    expect(t).toContain('288 checks. Nothing worth your time.');
    expect(t).toContain('Activity Chat What it does Skills Earnings');
    expect(t).toContain('Checked 24 times today. All quiet, spent nothing.');
    expect(html).toContain('proof ↗');
    expect(html).toContain('max-w-[1400px]'); // the cockpit: rail, feed, side panel
  });
  test('setting_up renders the creation flow', async () => {
    const seen: string[] = [];
    const stub = await AgentScreen({ id: AGENT_ID, load: async () => ({ ...ready(overview({ status: 'setting_up' })), feed: [] }), createFlow: ({ name }) => (seen.push(name), createElement('p', null, 'flow')) });
    expect(renderToStaticMarkup(stub)).toContain('flow');
    expect(seen).toEqual(['XLM drop watcher']);
    // The real flow reads the app router (test-only provider; the page has the real one).
    const real = renderToStaticMarkup(createElement(AppRouterContext.Provider, { value: {} as never }, await AgentScreen({ id: AGENT_ID, load: async () => ({ ...ready(overview({ status: 'setting_up' })), feed: [] }) })));
    expect(real).toContain('data-create="flow"');
    expect(real).not.toContain('data-pause');
  });
  test('?prompt= is taken off the address and handed to the editor, never run here', async () => {
    const d = await redirectOf(AgentScreen({ id: AGENT_ID, load: async () => ready(), searchParams: { prompt: 'Also tell me about USDC & more' } }));
    expect(d).toContain(`/dashboard/${AGENT_ID}?tab=edit&prompt=Also+tell+me+about+USDC+%26+more;`);
    // Not signed in: the prompt does not matter, the visitor goes to the first screen.
    expect(await redirectOf(AgentScreen({ id: AGENT_ID, load: async () => ({ kind: 'signed_out' }), searchParams: { prompt: 'x' } }))).toMatch(/;\/;/);
    // A blank prompt is ignored.
    expect(text(renderToStaticMarkup(await AgentScreen({ id: AGENT_ID, load: async () => ready(), searchParams: { prompt: '   ' }, now: NOW })))).toContain('288 checks. Nothing worth your time.');
  });
  test('AgentView is layout-safe: no fixed widths, long text breaks', () => {
    const html = renderToStaticMarkup(createElement(AgentView, { load: ready() as Extract<AgentLoad, { kind: 'ready' }>, now: NOW }));
    expect(html).not.toMatch(/(?<!max-)\bw-\[\d+px\]|\bmin-w-\[/);
    expect(html).toContain('break-words');
  });
});

describe('format and guards', () => {
  test('usdc, ago, untilNext, dayWord, safeUrl', () => {
    expect(formatUsdc('0.0030000')).toBe('0.003');
    expect(formatUsdc('1.5000000')).toBe('1.5');
    expect(formatUsdc('2.0000000')).toBe('2');
    expect(formatUsdc('0')).toBe('0');
    expect(ago('2026-10-13T11:59:30Z', NOW)).toBe('just now');
    expect(ago('2026-10-13T11:55:00Z', NOW)).toBe('5 min ago');
    expect(ago('2026-10-13T09:00:00Z', NOW)).toBe('3 hours ago');
    expect(ago('2026-10-12T09:00:00Z', NOW)).toBe('yesterday');
    expect(ago('2026-10-09T12:00:00Z', NOW)).toBe('4 days ago');
    expect(untilNext('2026-10-13T12:00:10Z', NOW)).toBeNull();
    expect(untilNext('2026-10-13T12:05:00Z', NOW)).toBe('5 min from now');
    expect(untilNext('2026-10-13T14:00:00Z', NOW)).toBe('2 hours from now');
    expect(dayWord('2026-10-13', NOW)).toBe('today');
    expect(dayWord('2026-10-12', NOW)).toBe('yesterday');
    expect(dayWord('2026-10-09', NOW)).toBe('on Oct 9');
    expect(safeUrl('https://a.b/c?d=1')).toBe('https://a.b/c?d=1');
    expect(safeUrl('javascript:alert(1)')).toBeNull();
    expect(safeUrl('http://a.b/c')).toBeNull(); // https only
    expect(safeUrl('data:text/html,x')).toBeNull();
    expect(safeUrl('not a url')).toBeNull();
    expect(safeUrl(undefined)).toBeNull();
  });
  test('asOverview and asFeed drop what they cannot draw', () => {
    expect(asOverview(overview())).not.toBeNull();
    expect(asOverview({ ...overview(), status: 'weird' })).toBeNull();
    // Paused for want of its first USDC reads as getting ready; the owner's own pause stays paused; a stale flag on a live
    // agent says nothing.
    expect(asOverview({ ...overview(), status: 'paused', awaitingFunds: true })?.status).toBe('getting_ready');
    expect(asOverview({ ...overview(), status: 'paused', awaitingFunds: false })?.status).toBe('paused');
    expect(asOverview({ ...overview(), status: 'paused' })?.status).toBe('paused');
    expect(asOverview({ ...overview(), status: 'watching', awaitingFunds: true })?.status).toBe('watching');
    expect(asOverview({ ...overview(), earnedUsdc: 'lots' })).toBeNull();
    expect(asOverview({ ...overview(), budgetUsedPct: 250 })?.budgetUsedPct).toBe(100);
    expect(asFeed([{ type: 'alert', at: 'nope', text: 'x' }, { type: 'mystery', at: '2026-10-13T08:00:00Z' }, { type: 'problem', at: '2026-10-13T08:00:00Z' }])).toEqual([{ type: 'problem', at: '2026-10-13T08:00:00Z' }]);
    expect(asFeed([{ type: 'alert', at: '2026-10-13T08:00:00Z', text: 'x', runId: 'r1' }, { type: 'sale', at: '2026-10-13T08:00:00Z', usdc: '1', runId: 7 }])).toEqual([
      { type: 'alert', at: '2026-10-13T08:00:00Z', text: 'x', runId: 'r1' },
      { type: 'sale', at: '2026-10-13T08:00:00Z', usdc: '1' },
    ]);
    expect(asFeed(null)).toBeNull();
  });
});
