import { describe, expect, test } from 'bun:test';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { createElement } from 'react';
import { BUILDER_FAILED_CODES, copy, errorCopy, HANDLED_ERRORS, statusWord, type AgentStatus } from '../src/copy';
import { ADDRESS_PATTERNS, API_BANNED, BANNED, bannedWord } from '../src/lib/words';
import { CreateFlowView } from '../src/components/create-flow';
import { initialCreateUi } from '../src/lib/creation';
import { DraftFlowView } from '../src/components/draft-flow';
import { MyAgentsView } from '../src/components/my-agents';
import { SignInView } from '../src/components/sign-in';
import { ConnectPanel } from '../src/components/connect-panel';
import { draftReducer, initialState } from '../src/lib/draft-state';
import { AgentError, AgentView } from '../src/components/agent-screen';
import { ChatView } from '../src/components/chat';
import { EarningsList } from '../src/components/earnings-list';
import { EditView } from '../src/components/edit-description';
import { SellCardView } from '../src/components/sell-card';
import { asSellSuggestion } from '../src/lib/agent-types';
import { chatReducer, initialChat } from '../src/lib/chat';
import { editReducer, initialEdit } from '../src/lib/edit';
import type { AgentLoad } from '../src/server/agent-data';
import { feed as agentFeed, NOW as AGENT_NOW, overview as agentOverview, AGENT_ID } from './support/agent';
import { G, sampleDraft } from './support/draft';
import { registerScreen, renderScreens, stripAdvanced, textOf } from './support/screens';

const root = join(import.meta.dir, '..');
const API_WORDS = join(root, '../api/src/builder/words.ts');

function walk(dir: string): string[] {
  return readdirSync(dir).flatMap((n) => {
    const p = join(dir, n);
    return statSync(p).isDirectory() ? walk(p) : [p];
  });
}

/** Every string in a copy subtree; functions are called with sample arguments. */
function strings(node: unknown, out: string[] = []): string[] {
  if (typeof node === 'string') out.push(node);
  else if (typeof node === 'function') {
    for (const args of [[], [0], [1], [7], ['x'], ['a', 2]]) {
      try {
        const r = (node as (...a: unknown[]) => unknown)(...args);
        if (typeof r === 'string') out.push(r);
      } catch {
        /* wrong sample arguments */
      }
    }
  } else if (Array.isArray(node)) node.forEach((n) => strings(n, out));
  else if (node && typeof node === 'object') Object.values(node).forEach((n) => strings(n, out));
  return out;
}

for (const phase of ['idle', 'sending', 'sent'] as const) registerScreen(`sign-in-${phase}`, createElement(SignInView, { phase }));
const agentScreen = (name: string, o = agentOverview(), feed = agentFeed()) =>
  registerScreen(name, createElement(AgentView, { load: { kind: 'ready', id: AGENT_ID, overview: o, feed } as Extract<AgentLoad, { kind: 'ready' }>, now: AGENT_NOW }));
agentScreen('agent-active');
agentScreen('agent-paused', agentOverview({ status: 'paused', nextCheckAt: null }));
agentScreen('agent-stopped-today', agentOverview({ status: 'stopped_today', budgetUsedPct: 100 }));
agentScreen('agent-empty', agentOverview({ checksToday: 0, alertsThisWeek: 0, lastAlertAt: null, salesCount: 0, earnedUsdc: '0' }), []);
const MIN = 60_000;
const fresh = { checksToday: 0, checksTotal: 0, alertsThisWeek: 0, lastAlertAt: null, salesCount: 0, earnedUsdc: '0', budgetUsedPct: 0, watchingSince: new Date(AGENT_NOW - 20_000).toISOString(), latestCheck: null };
const landed = { ...fresh, checksToday: 1, checksTotal: 1, latestCheck: { at: new Date(AGENT_NOW - 30_000).toISOString(), held: false, reading: { symbol: 'XLM', changePct: -0.4, from: 0.1045, to: 0.1041 } } };
const withDraft = (name: string, o: ReturnType<typeof agentOverview>, feed = agentFeed()) =>
  registerScreen(name, createElement(AgentView, { load: { kind: 'ready', id: AGENT_ID, overview: o, feed, draft: sampleDraft() } as Extract<AgentLoad, { kind: 'ready' }>, now: AGENT_NOW }));
withDraft('agent-first-check-waiting', agentOverview(fresh), []);
withDraft('agent-first-check-failed', agentOverview({ ...fresh, latestCheck: { at: new Date(AGENT_NOW - 5000).toISOString(), held: null, reading: null } }), []);
withDraft('agent-first-check-landed', agentOverview(landed), []);
withDraft('agent-first-check-found-something', agentOverview({ ...landed, latestCheck: { ...landed.latestCheck, held: true } }), []);
withDraft('agent-today', agentOverview({ checksToday: 62 }), [{ type: 'quiet', at: new Date(AGENT_NOW - MIN).toISOString(), day: '2026-10-13', count: 16, range: 'XLM between −0.2% and −1.1%', since: new Date(AGENT_NOW - 4 * 60 * MIN).toISOString() }]);
withDraft('agent-today-note-on', agentOverview({ checksToday: 62, morningNote: true }), []);
withDraft('agent-today-note-off', agentOverview({ checksToday: 62, morningNote: false }), []);
registerScreen('agent-error', createElement(AgentError));
{
  const key = { id: '00000000-0000-4000-8000-000000000001', name: 'Claude Code on my laptop', hint: 'ae_pat_abcd', createdAt: '2026-10-28T10:00:00Z', expiresAt: '2027-01-26T10:00:00Z', lastUsedAt: null };
  registerScreen('connect-empty', createElement(ConnectPanel, { keys: [] }));
  registerScreen('connect-fresh', createElement(ConnectPanel, { keys: [key], fresh: `ae_pat_${'A'.repeat(43)}` }));
}
{
  const chatted = chatReducer(chatReducer(initialChat, { t: 'sent', text: 'hi' }), { t: 'delta', text: 'Hello' });
  registerScreen('chat-empty', createElement(ChatView, { state: initialChat, paused: false }));
  registerScreen('chat-paused', createElement(ChatView, { state: initialChat, paused: true }));
  registerScreen('chat-answering', createElement(ChatView, { state: chatted, paused: false }));
  registerScreen('chat-failed', createElement(ChatView, { state: chatReducer(chatted, { t: 'failed', message: copy.chat.failed }), paused: false }));
  registerScreen('chat-busy', createElement(ChatView, { state: chatReducer(initialChat, { t: 'failed', message: copy.errors.chatBusy }), paused: false }));
  const ed = initialEdit(sampleDraft(), null, 'Also watch USDC');
  registerScreen('edit-ready', createElement(EditView, { state: ed }));
  registerScreen('edit-saved', createElement(EditView, { state: editReducer(editReducer(ed, { t: 'busy', busy: 'save' }), { t: 'saved' }) }));
  registerScreen('edit-tap-refused', createElement(EditView, { state: editReducer(editReducer(ed, { t: 'busy', busy: 'tap' }), { t: 'failed', message: copy.errors.badEdit }) }));
  registerScreen('edit-revise-refused', createElement(EditView, { state: editReducer(editReducer(ed, { t: 'busy', busy: 'revise' }), { t: 'failed', message: copy.errors.dailyLimit }) }));
  registerScreen('edit-pending', createElement(EditView, { state: initialEdit(sampleDraft(), { version: 3, draft: sampleDraft({ name: 'Revised' }) }) }));
  registerScreen('edit-pending-failed', createElement(EditView, { state: editReducer(editReducer(initialEdit(sampleDraft(), { version: 3, draft: sampleDraft() }), { t: 'busy', busy: 'update' }), { t: 'failed', message: copy.errors.status5xx }) }));
  const sale = { type: 'sale' as const, at: '2026-10-13T08:05:00Z', usdc: '0.0010000', proofUrl: 'https://agentenact.io/verify?agent=a&tx=b' };
  registerScreen('earnings-list', createElement(EarningsList, { overview: { earnedUsdc: '0.0010000', salesCount: 1 }, sales: [sale], now: AGENT_NOW }));
  registerScreen('earnings-empty', createElement(EarningsList, { overview: { earnedUsdc: '0', salesCount: 0 }, sales: [], now: AGENT_NOW }));
  registerScreen('chat-section', createElement(AgentView, { load: { kind: 'ready', id: AGENT_ID, overview: agentOverview(), feed: [] } as Extract<AgentLoad, { kind: 'ready' }>, now: AGENT_NOW, tab: 'chat' }));
}
{
  const offer = asSellSuggestion({ eligible: true, suggestion: { version: 4, label: 'Sell my XLM price checks to other agents', service: { price_usdc: '0.0100000' } } })!;
  const card = (state: Parameters<typeof SellCardView>[0]['state']) => createElement(SellCardView, { suggestion: offer, ...(state ? { state } : {}) });
  registerScreen('sell-card', card(undefined));
  registerScreen('sell-card-busy', card({ phase: 'card', busy: true, message: null }));
  registerScreen('sell-card-failed', card({ phase: 'card', busy: false, message: copy.errors.status5xx }));
  registerScreen('sell-card-done', card({ phase: 'done' }));
  registerScreen('sell-card-stale', card({ phase: 'stale' }));
  registerScreen('agent-with-sell-card', createElement(AgentView, { load: { kind: 'ready', id: AGENT_ID, overview: agentOverview(), feed: agentFeed() } as Extract<AgentLoad, { kind: 'ready' }>, now: AGENT_NOW, sell: card(undefined) }));
}
registerScreen('sign-in-error', createElement(SignInView, { phase: 'idle', error: copy.signIn.badEmail }));

{
  const drafting = draftReducer(initialState, { t: 'drafting', prompt: 'x' });
  const ready = draftReducer(drafting, { t: 'drafted', draft: sampleDraft() });
  const screen = (state: typeof ready, signedIn = false) => createElement(DraftFlowView, { state, signedIn });
  registerScreen('draft-drafting', screen(drafting));
  registerScreen('draft-ready', screen(ready));
  registerScreen('draft-waiting', screen(draftReducer(initialState, { t: 'wait', handoff: 'a'.repeat(22) }), true));
  registerScreen('draft-limit', screen(draftReducer(drafting, { t: 'draft-failed', kind: 'sign_in', message: copy.errors.signInToKeepDrafting })));
  registerScreen('draft-failed', screen(draftReducer(drafting, { t: 'draft-failed', kind: 'failed', message: copy.errors.status5xx })));
  registerScreen('draft-daily', screen(draftReducer(drafting, { t: 'draft-failed', kind: 'daily', message: copy.errors.dailyLimit })));
  registerScreen('draft-edit-refused', screen(draftReducer(ready, { t: 'edit-failed', message: copy.errors.badEdit, signIn: true })));
  const tried = draftReducer(ready, { t: 'trial-start' });
  registerScreen('draft-trial-running', screen(tried));
  registerScreen(
    'draft-trial-result',
    screen(draftReducer(tried, { t: 'trial-done', spec: tried.draft!.spec, result: { status: 'done', condition: { held: true, data: '' }, text: `Watching ${G}`, wouldHave: [{ kind: 'email', summary: 'XLM fell' }, { kind: 'hire', summary: 'a helper' }], steps: [{ n: 1, tools: ['stellar_price'] }, { n: 2, tools: ['send_email'] }] } })),
  );
  registerScreen('draft-trial-limit', screen(draftReducer(tried, { t: 'trial-failed', spec: tried.draft!.spec, kind: 'sign_in', message: copy.errors.signInToKeepDrafting })));
  registerScreen('draft-trial-failed', screen(draftReducer(tried, { t: 'trial-failed', spec: tried.draft!.spec, kind: 'failed', message: copy.errors.status5xx })));
  registerScreen('draft-create-signed-out', screen(draftReducer(ready, { t: 'create' })));
  registerScreen('draft-create-signed-in', screen(draftReducer(ready, { t: 'create' }), true));
  registerScreen('draft-add-to-agent', createElement(DraftFlowView, { state: draftReducer(ready, { t: 'create' }), signedIn: true, full: true }));
  registerScreen('draft-has-agents', createElement(DraftFlowView, { state: ready, signedIn: true, hasAgents: true }));
  registerScreen('my-agents', createElement(MyAgentsView, { agents: [{ id: '3f2b8c1e-5a4d-4e6f-9b7a-1c2d3e4f5a6b', name: 'XLM drop alert', status: 'active' }, { id: '4f2b8c1e-5a4d-4e6f-9b7a-1c2d3e4f5a6b', name: 'USDC watcher', status: 'provisioning' }], limit: 3 }));
  registerScreen('draft-finish-agent', createElement(DraftFlowView, { state: draftReducer(ready, { t: 'create' }), signedIn: true, full: true, unfinished: true }));
  const ui = (steps: Record<string, string>, extra = {}) => ({ steps: { account_key: 'idle', identity: 'idle', ready: 'idle', ...steps }, ...extra }) as never;
  registerScreen('create-start', createElement(CreateFlowView, { name: 'XLM drop alert', ui: initialCreateUi }));
  registerScreen('create-key', createElement(CreateFlowView, { name: 'XLM drop alert', ui: ui({ account_key: 'asking' }) }));
  registerScreen('create-identity-asking', createElement(CreateFlowView, { name: 'XLM drop alert', ui: ui({ account_key: 'done', identity: 'asking' }), ask: { kind: 'register', summary: 'Create a new agent identity owned by your wallet, described at https://agentenact.io/a/x/agent.json.' } }));
  registerScreen('create-identity-time-left', createElement(CreateFlowView, { name: 'XLM drop alert', ui: ui({ account_key: 'done', identity: 'asking' }, { approveBy: 300_000 }), now: 0, ask: { kind: 'register', summary: 'Create a new agent identity.' } }));
  registerScreen('create-bind-asking', createElement(CreateFlowView, { name: 'XLM drop alert', ui: ui({ account_key: 'done', identity: 'done', ready: 'asking' }), ask: { kind: 'bind', summary: `Let agent #42 act with its own wallet ${G}.` } }));
  registerScreen('create-working', createElement(CreateFlowView, { name: 'XLM drop alert', ui: ui({ account_key: 'done', identity: 'done', ready: 'working' }) }));
  registerScreen('create-done', createElement(CreateFlowView, { name: 'XLM drop alert', ui: ui({ account_key: 'done', identity: 'done', ready: 'done' }, { done: { agentId: 'x' } }) }));
  for (const failed of ['cancelled', 'stopped', 'refused', 'expired', 'chain', 'operator', 'unknown'] as const)
    registerScreen(`create-failed-${failed}`, createElement(CreateFlowView, { name: 'XLM drop alert', ui: ui({ account_key: 'done' }, { failure: { failed, retryable: failed !== 'operator' && failed !== 'refused' } }) }));
}

// The plain-words rule is for customers: the scan covers src/copy.ts.
const NOT_ADVANCED =Object.entries(copy).filter(([k]) => k !== 'advanced');

describe('BANNED', () => {
  test('is exactly the api list plus the panel-only address patterns', () => {
    const src = readFileSync(API_WORDS, 'utf8');
    const body = src.slice(src.indexOf('export const BANNED'));
    const list = body.slice(body.indexOf('['), body.indexOf('\n];'));
    const apiLiterals = [...list.matchAll(/^\s*(\/.+\/[a-z]*),\s*$/gm)].map((m) => m[1]);
    expect(apiLiterals.length).toBeGreaterThan(10);
    expect(API_BANNED.map(String)).toEqual(apiLiterals as string[]);
    expect(BANNED.map(String)).toEqual([...apiLiterals, ...ADDRESS_PATTERNS.map(String)]);
    expect(ADDRESS_PATTERNS.map(String)).toEqual(['/\\bG[A-Z2-7]{55}\\b/', '/\\bC[A-Z2-7]{55}\\b/', '/0x[0-9a-f]{8,}/i']);
  });
  test('wallet is allowed; smart wallet and passkey are banned', () => {
    expect(bannedWord('watch this wallet')).toBeNull();
    expect(bannedWord('your smart wallet')).not.toBeNull();
    expect(bannedWord('a Passkey')).not.toBeNull();
  });
  test("'free budget' is allowed, a bare budget is not", () => {
    expect(bannedWord("today's free budget")).toBeNull();
    expect(bannedWord('your budget')).not.toBeNull();
  });
  test('shortened addresses pass, full 56-character ones are banned', () => {
    const full = `G${'A'.repeat(55)}`;
    expect(bannedWord('GABC…WXYZ')).toBeNull();
    expect(bannedWord('GABC...WXYZ')).toBeNull();
    expect(bannedWord(`watching ${full}`)).toBe(full);
    expect(bannedWord(`C${'B'.repeat(55)}`)).not.toBeNull();
    expect(bannedWord('0xdeadbeef01')).not.toBeNull();
  });
});

describe('copy', () => {
  test('no string matches BANNED, except under copy.advanced', () => {
    const bad = NOT_ADVANCED.flatMap(([, v]) => strings(v)).filter((s) => bannedWord(s));
    expect(bad).toEqual([]);
  });
  test('copy.advanced does hold technical terms (so the scan above is meaningful)', () => {
    expect(strings(copy.advanced).some((s) => bannedWord(s))).toBe(true);
  });
  test('no exclamation marks', () => {
    expect(strings(copy).filter((s) => s.includes('!'))).toEqual([]);
  });
  test('copy.advanced is only used inside an element with data-advanced', () => {
    const offenders = walk(join(root, 'src'))
      .filter((f) => /\.(ts|tsx)$/.test(f) && !f.endsWith(join('src', 'copy.ts')))
      .filter((f) => {
        const s = readFileSync(f, 'utf8');
        return /\bcopy\.advanced\b/.test(s) && !/data-advanced/.test(s);
      })
      .map((f) => relative(root, f));
    expect(offenders).toEqual([]);
  });
  test('testnet is named wherever creation or money is mentioned', () => {
    for (const section of ['create', 'earnings', 'sell'] as const) {
      const all = strings(copy[section]);
      expect(all.some((s) => /testnet/i.test(s))).toBe(true);
      // Creation says it in its fine line (create.fine); earnings and sell lead with it in their title.
      if (section !== 'create') expect(/testnet/i.test((copy[section] as { title: string }).title)).toBe(true);
      // Earnings and sell repeat it in their note; the creation flow says it once, in its fine line.
      if (section !== 'create') expect(/testnet/i.test((copy[section] as { note: string }).note)).toBe(true);
    }
    expect(/testnet/i.test(copy.agent.earned('1', 1))).toBe(true);
    for (const s of strings(copy).filter((s) => /USDC/.test(s))) expect(s).toMatch(/testnet/i);
  });
  test("the table's replacements exist", () => {
    const want: [AgentStatus, string][] = [
      ['watching', 'Watching'],
      ['paused', 'Paused'],
      ['stopped_today', 'Stopped for today'],
      ['setting_up', 'Setting up'],
      ['stopped', 'Stopped'],
    ];
    for (const [k, v] of want) expect(statusWord(k)).toBe(v);
    expect(copy.activity.proof).toBe('proof ↗');
    expect(copy.earnings.proof).toBe('proof ↗');
    expect(copy.agent.budgetUsed(40)).toBe('Free budget used today: 40%');
    expect(copy.errors.signInToKeepDrafting).toContain('Sign in to keep drafting');
  });
});

describe('errorCopy', () => {
  test('covers every handled code with its own plain sentence', () => {
    const seen = new Set<string>();
    for (const code of HANDLED_ERRORS) {
      const s = errorCopy(code);
      expect(s).not.toBe(copy.errors.generic);
      expect(bannedWord(s)).toBeNull();
      if (code !== 'client_closed' && code !== 'aborted') seen.add(s);
    }
    expect(seen.size).toBe(HANDLED_ERRORS.length - 2);
  });
  test('the required codes are all handled', () => {
    for (const c of ['sign_in_to_keep_drafting', 'daily_limit', 'bad_view', 'not_eligible', 'client_closed', 'rate_limited', 'aborted', 'builder_failed'])
      expect(HANDLED_ERRORS as readonly string[]).toContain(c);
  });
  test('builder_failed answers each of its codes', () => {
    for (const c of BUILDER_FAILED_CODES) expect(bannedWord(errorCopy('builder_failed', 502, c))).toBeNull();
    expect(errorCopy('builder_failed', 502, 'budget')).not.toBe(errorCopy('builder_failed', 502, 'unreadable'));
  });
  test('bare 404, 429 and 5xx (Traefik, no body) get plain sentences', () => {
    expect(errorCopy(undefined, 404)).toBe(copy.errors.status404);
    expect(errorCopy(undefined, 429)).toBe(copy.errors.status429);
    for (const st of [500, 502, 503, 504]) expect(errorCopy(undefined, st)).toBe(copy.errors.status5xx);
    expect(errorCopy('internal', 500)).toBe(copy.errors.status5xx);
    expect(errorCopy(undefined, 418)).toBe(copy.errors.generic);
    expect(errorCopy('toString', 400)).toBe(copy.errors.generic);
  });
});

describe('screen scan helpers', () => {
  test('stripAdvanced removes data-advanced subtrees only', () => {
    const html = '<div><p>keep</p><div data-advanced=""><span>prompt<br/></span><div>inner</div></div><p>after</p><img src="x"></div>';
    const out = textOf(stripAdvanced(html));
    expect(out).toContain('keep');
    expect(out).toContain('after');
    expect(out).not.toContain('prompt');
    expect(out).not.toContain('inner');
  });
  test('a leaked term outside data-advanced is caught, inside is not', () => {
    registerScreen('selftest-leak', createElement('p', null, 'your passkey'));
    registerScreen('selftest-ok', createElement('div', { 'data-advanced': '' }, createElement('p', null, 'your passkey')));
    const screens = renderScreens();
    const leak = screens.find((s) => s.name === 'selftest-leak')!;
    const ok = screens.find((s) => s.name === 'selftest-ok')!;
    expect(bannedWord(textOf(stripAdvanced(leak.html)))).not.toBeNull();
    expect(bannedWord(textOf(stripAdvanced(ok.html)))).toBeNull();
  });
  test('every screen registered renders text with no BANNED match outside [data-advanced]', () => {
    const real = renderScreens().filter((s) => !s.name.startsWith('selftest-'));
    expect(real.map((s) => s.name)).toEqual(expect.arrayContaining(['agent-active', 'agent-paused', 'agent-stopped-today', 'agent-empty', 'agent-error', 'draft-ready', 'draft-limit', 'draft-drafting', 'draft-failed', 'draft-trial-result', 'chat-paused', 'edit-pending', 'earnings-list']));
    for (const { name, html } of real)
      expect({ name, word: bannedWord(textOf(stripAdvanced(html))) }).toEqual({ name, word: null });
  });
});
