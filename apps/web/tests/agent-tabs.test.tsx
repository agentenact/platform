import { describe, expect, test } from 'bun:test';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { EarningsSlot, EditSlot, SkillsTabSlot, type PanelLoaders } from '../src/components/agent-panels';
import { AgentScreen } from '../src/components/agent-screen';
import LegacyEditTab from '../src/app/dashboard/[id]/edit/page';
import LegacySkillsTab from '../src/app/dashboard/[id]/skills/page';
import { agentHref, tabOf } from '../src/lib/agent-href';
import { createLoadPanel } from '../src/server/panel-data';
import { ChatView } from '../src/components/chat';
import { EarningsList } from '../src/components/earnings-list';
import { EditDescription, EditView } from '../src/components/edit-description';
import { copy } from '../src/copy';
import { chatReducer, createChatController, initialChat, threadOf, toApiMessages, type ChatMessage, type ChatOpen, type ChatState, type ChatTransport } from '../src/lib/chat';
import { asSales } from '../src/lib/agent-types';
import { createEditController, editReducer, initialEdit, type EditActions, type EditOut, type EditState } from '../src/lib/edit';
import { asSpecShown } from '../src/lib/spec-types';
import { createAgentEditActions } from '../src/server/agent-edit-actions';
import type { LoadAgent } from '../src/server/agent-data';
import type { ApiCall, ApiResult } from '../src/server/api';
import { AGENT_ID, NOW, overview } from './support/agent';
import { sampleDraft } from './support/draft';
import { textOf } from './support/screens';

const enc = new TextEncoder();
const text = (html: string) => textOf(html).replace(/\s+/g, ' ').trim();
const redirectOf = (p: Promise<unknown>) => p.then(() => null, (e: { digest?: string }) => e.digest ?? String(e));

// --- chat ---------------------------------------------------------------------------------------

async function* sse(...frames: string[]): AsyncGenerator<Uint8Array> {
  for (const f of frames) yield enc.encode(f);
}
const delta = (t: string) => `event: delta\ndata: ${JSON.stringify({ text: t })}\n\n`;
const done = (status: string, stop = 'end') => `event: done\ndata: ${JSON.stringify({ runId: 'r1', status, stop })}\n\n`;

/** A chat with a scripted transport; `sent` records every request the api would have received. */
function chat(open: (n: number) => ChatOpen) {
  let state = initialChat;
  const sent: { role: string; content: string }[][] = [];
  const transport: ChatTransport = {
    async open(_id, messages) {
      sent.push(messages);
      return open(sent.length);
    },
  };
  const ctl = createChatController({ agentId: AGENT_ID, transport, getState: () => state, dispatch: (a) => (state = chatReducer(state, a)) });
  return { ctl, get: () => state, sent };
}

describe('chat', () => {
  test('chat streams deltas into one message and handles done error', async () => {
    const c = chat((n) => ({ status: 200, chunks: n === 1 ? sse(': keepalive\n\n', delta('Hel'), delta('lo '), delta('there'), done('done')) : sse(delta('Half'), done('error', 'error')) }));
    await c.ctl.send('hi');
    expect(threadOf(c.get()).messages).toEqual([
      { role: 'user', content: 'hi' },
      { role: 'assistant', content: 'Hello there' },
    ]);
    expect([(c.get().streaming !== null), threadOf(c.get()).note]).toEqual([false, null]);
    await c.ctl.send('and now');
    expect((c.get().streaming !== null)).toBe(false);
    expect(threadOf(c.get()).note).toBe("I couldn't finish that. Try again.");
    expect(threadOf(c.get()).messages.at(-1)).toEqual({ role: 'assistant', content: 'Half', failed: true });
    expect(threadOf(c.get()).messages.filter((m) => m.role === 'assistant')).toHaveLength(2); // still one assistant message per answer
  });

  test('an answer that fails before any text leaves no empty bubble', async () => {
    const c = chat(() => ({ status: 200, chunks: sse(done('error', 'error')) }));
    await c.ctl.send('hi');
    // The question stays, marked, so it can be sent again.
    expect(threadOf(c.get()).messages).toEqual([{ role: 'user', content: 'hi', failed: true }]);
    expect(threadOf(c.get()).note).toBe(copy.chat.failed);
  });

  test('a stream that closes without its last frame is a failure, not a hang', async () => {
    const c = chat(() => ({ status: 200, chunks: sse(delta('par')) }));
    await c.ctl.send('hi');
    expect([(c.get().streaming !== null), threadOf(c.get()).note]).toEqual([false, copy.chat.failed]);
  });

  test('a transport that throws is a plain failure', async () => {
    let state = initialChat;
    const ctl = createChatController({ agentId: AGENT_ID, transport: { open: () => Promise.reject(new Error('secret detail')) }, getState: () => state, dispatch: (a) => (state = chatReducer(state, a)) });
    await ctl.send('hi');
    expect(threadOf(state).note).toBe(copy.chat.failed);
    expect(JSON.stringify(state)).not.toContain('secret detail');
  });

  test('429 chat_busy and 409 agent_not_active become plain sentences; other statuses are read by status', async () => {
    const run = async (open: ChatOpen) => {
      const c = chat(() => open);
      await c.ctl.send('hi');
      return threadOf(c.get()).note;
    };
    expect(await run({ status: 429, code: 'chat_busy' })).toBe(copy.errors.chatBusy);
    expect(await run({ status: 409, code: 'agent_not_active' })).toBe(copy.errors.notActive);
    expect(await run({ status: 401 })).toBe(copy.errors.unauthorized);
    expect(await run({ status: 429 })).toBe(copy.errors.status429);
    for (const status of [404, 502, 503]) expect(await run({ status })).not.toBe(copy.errors.generic);
    expect(await run({ status: 503 })).toBe(copy.errors.status5xx);
  });

  test('an answer that ends on the free budget says so, and is kept', async () => {
    const c = chat(() => ({ status: 200, chunks: sse(delta('Some'), done('budget', 'budget')) }));
    await c.ctl.send('hi');
    expect(threadOf(c.get()).note).toBe(copy.agent.stoppedToday);
    expect(threadOf(c.get()).messages.at(-1)).toEqual({ role: 'assistant', content: 'Some' });
  });

  test('one turn at a time, and a blank or too long message is not sent', async () => {
    const c = chat(() => ({ status: 200, chunks: sse(delta('a'), done('done')) }));
    await c.ctl.send('   ');
    await c.ctl.send('x'.repeat(3001));
    expect(c.sent).toEqual([]);
    const first = c.ctl.send('one');
    await c.ctl.send('two'); // busy: ignored
    await first;
    expect(c.sent).toHaveLength(1);
  });

  test('the request carries the finished turns, most recent 20, starting with a question', async () => {
    const c = chat(() => ({ status: 200, chunks: sse(delta('ok'), done('done')) }));
    for (let i = 0; i < 12; i++) await c.ctl.send(`q${i}`);
    const last = c.sent.at(-1)!;
    expect(last.length).toBeLessThanOrEqual(20);
    expect(last[0]!.role).toBe('user');
    expect(last.at(-1)).toEqual({ role: 'user', content: 'q11' });
  });

  test('a failed answer and the question it belongs to are not sent again', () => {
    const history: ChatMessage[] = [
      { role: 'user', content: 'first' },
      { role: 'assistant', content: 'fine' },
      { role: 'user', content: 'lost' },
      { role: 'assistant', content: 'part', failed: true },
    ];
    expect(toApiMessages(history, 'next')).toEqual([
      { role: 'user', content: 'first' },
      { role: 'assistant', content: 'fine' },
      { role: 'user', content: 'next' },
    ]);
  });

  test('chat is disabled while paused: the input says so and the button resumes the agent', () => {
    const html = renderToStaticMarkup(createElement(ChatView, { state: initialChat, paused: true }));
    expect(html).toMatch(/<textarea[^>]*disabled=""/);
    expect(html).not.toContain('data-send');
    expect(html).toContain(`placeholder="${copy.chat.pausedPlaceholder}"`);
    expect(text(html)).toContain(copy.chat.resume);
    const live = renderToStaticMarkup(createElement(ChatView, { state: initialChat, paused: false, draft: 'hello' }));
    expect(live).not.toMatch(/<textarea[^>]*disabled=""/);
    expect(live).not.toMatch(/<button[^>]*disabled=""[^>]*data-send/);
    expect(text(live)).toContain(copy.chat.empty);
  });

  test('the empty state offers two suggested questions as chips; they are off while paused', () => {
    const html = renderToStaticMarkup(createElement(ChatView, { state: initialChat, paused: false }));
    expect(html.match(/data-suggest=""/g)).toHaveLength(2);
    expect(text(html)).toContain('What did you do today?');
    expect(text(html)).toContain('What would you do next?');
    expect(renderToStaticMarkup(createElement(ChatView, { state: initialChat, paused: true }))).toMatch(/<button[^>]*data-suggest=""[^>]*disabled=""/);
    const talking = renderToStaticMarkup(createElement(ChatView, { state: { ...initialChat, threads: { '': { messages: [{ role: 'user', content: 'hi' }], note: null } } }, paused: false }));
    expect(talking).not.toContain('data-suggest');
  });

  test('the owner in a bubble on the right; the agent as plain prose with its markdown drawn, no box and no raw markers', () => {
    const state: ChatState = { ...initialChat, threads: { '': { messages: [{ role: 'user', content: 'hi' }, { role: 'assistant', content: 'Hello **there**.\n\n- one' }], note: null } } };
    const html = renderToStaticMarkup(createElement(ChatView, { state, paused: false }));
    const user = html.slice(html.indexOf('data-role="user"'), html.indexOf('data-role="assistant"'));
    const agent = html.slice(html.indexOf('data-role="assistant"'), html.indexOf('chat-composer-bar'));
    expect(user).toContain('justify-end');
    expect(agent).toContain('<strong');
    expect(agent).toContain('<li');
    expect(agent).not.toContain('**');
    expect(agent).not.toContain('border border-line');
  });

  test('the conversation and a note render; message text is escaped', () => {
    const state: ChatState = { ...initialChat, threads: { '': { messages: [{ role: 'user', content: '<img src=x onerror=1>' }, { role: 'assistant', content: 'Fine.' }], note: copy.chat.failed } } };
    const html = renderToStaticMarkup(createElement(ChatView, { state, paused: false }));
    expect(html).not.toContain('<img');
    expect(html).toContain('data-role="user"');
    expect(html).toContain('data-role="assistant"');
    expect(text(html)).toContain("I couldn't finish that. Try again.");
  });

  test('chat never logs: no console call while sending', async () => {
    const calls: unknown[][] = [];
    const orig = { log: console.log, info: console.info, warn: console.warn, error: console.error };
    for (const k of Object.keys(orig) as (keyof typeof orig)[]) console[k] = (...a: unknown[]) => void calls.push(a);
    try {
      const c = chat(() => ({ status: 200, chunks: sse(delta('private answer'), done('error', 'error')) }));
      await c.ctl.send('private question');
    } finally {
      Object.assign(console, orig);
    }
    expect(calls).toEqual([]);
  });
});

// --- What it does ---------------------------------------------------------------------------------

type Call = { name: string; args: unknown[] };
/** Fake server actions that answer from a script and record every call, in order. */
function fakes(over: Partial<EditActions> = {}) {
  const calls: Call[] = [];
  const rec =
    <A extends unknown[], R>(name: string, f: (...a: A) => R) =>
    (...a: A): R => (calls.push({ name, args: a }), f(...a));
  const actions: EditActions = {
    edit: rec('edit', async (param, value): Promise<EditOut<{ draft: unknown }>> => ({ ok: true, draft: sampleDraft({ params: sampleDraft().params.map((p) => (p.id === param ? ({ ...p, value } as typeof p) : p)) }) })),
    save: rec('save', async () => ({ ok: true }) as EditOut),
    revise: rec('revise', async () => ({ ok: true, version: 5, draft: sampleDraft({ name: 'Revised' }) }) as EditOut<{ version: number; draft: unknown }>),
    approve: rec('approve', async () => ({ ok: true }) as EditOut),
    discard: rec('discard', async () => ({ ok: true }) as EditOut),
    ...over,
  };
  return { actions, calls };
}
function screen(actions: EditActions, init: EditState = initialEdit(sampleDraft(), null)) {
  let state = init;
  const ctl = createEditController(actions, { getState: () => state, dispatch: (a) => (state = editReducer(state, a)) });
  return { ctl, get: () => state };
}

describe('What it does', () => {
  test('the system prompt can be changed under Edit the details and is saved with Save changes', async () => {
    const f = fakes();
    const s = screen(f.actions);
    s.ctl.setSpec({ system_prompt: 'Only alert below 0.09.' });
    expect(s.get().specEdited).toBe(true);
    expect(await s.ctl.onEdit('drop', 7)).toBe(false); // a tap would rebuild the words from the stored copy
    s.ctl.setPrompt('more');
    await s.ctl.onAdd(); // nothing is written while raw words are unsaved
    await s.ctl.onSave();
    expect(f.calls.map((c) => c.name)).toEqual(['save']);
    const saved = f.calls[0]!.args[0] as ReturnType<typeof sampleDraft>;
    expect(saved.spec.system_prompt).toBe('Only alert below 0.09.');
    expect(saved.spec.persona).toBe(sampleDraft().spec.persona);
    expect([s.get().specEdited, s.get().notice]).toEqual([false, 'Updated']);
    const html = renderToStaticMarkup(createElement(EditView, { state: s.get() }));
    expect(html).toContain('Only alert below 0.09.');
  });

  test('raw words are read-only while taps are unsaved, and taps are off while raw words are unsaved', () => {
    const tapped = { ...initialEdit(sampleDraft(), null), edits: [{ param: 'drop', value: 7 }] };
    const a = renderToStaticMarkup(createElement(EditView, { state: tapped, on: { onSpec: () => {}, onEdit: async () => true } }));
    expect(a.slice(a.indexOf('data-advanced=""'), a.indexOf('for="edit-add"')).match(/<textarea[^>]*readOnly=""/gi)?.length).toBeGreaterThan(0);
    const worded = { ...initialEdit(sampleDraft(), null), specEdited: true };
    const b = renderToStaticMarkup(createElement(EditView, { state: worded, on: { onSpec: () => {}, onEdit: async () => true } }));
    expect(b).toMatch(/<button[^>]*data-save/);
    expect(b).not.toMatch(/<button[^>]*disabled=""[^>]*data-save/); // something to save
    expect(b.slice(b.indexOf('data-advanced=""'), b.indexOf('for="edit-add"'))).not.toMatch(/readOnly=""/i);
  });

  test('Add this to your agent saves a draft version and does not approve until Update', async () => {
    const f = fakes();
    const s = screen(f.actions);
    s.ctl.setPrompt('also tell me about USDC');
    await s.ctl.onAdd();
    expect(f.calls.map((c) => c.name)).toEqual(['revise']);
    expect(f.calls[0]!.args).toEqual(['also tell me about USDC']);
    expect(s.get().pending).toMatchObject({ version: 5 });
    expect(s.get().prompt).toBe('');
    expect(s.get().draft.name).toBe('XLM watcher'); // the active sentence is untouched
    expect(f.calls.some((c) => c.name === 'approve')).toBe(false);
  });

  test('Update approves exactly that version', async () => {
    const f = fakes();
    const s = screen(f.actions, initialEdit(sampleDraft(), { version: 9, draft: sampleDraft({ name: 'Pending nine' }) }));
    await s.ctl.onUpdate();
    expect(f.calls).toEqual([{ name: 'approve', args: [9] }]);
    expect(s.get().pending).toBeNull();
    expect(s.get().draft.name).toBe('Pending nine');
    expect(s.get().notice).toBe('Updated');
  });

  test('Update sends the createdAt of the draft on screen, and a replaced draft is refused with a plain sentence', async () => {
    const sent: unknown[][] = [];
    const f = fakes({ approve: async (...a) => (sent.push(a), { ok: false, message: copy.errors.versionChanged }) });
    const s = screen(f.actions, initialEdit(sampleDraft(), { version: 9, draft: sampleDraft({ name: 'Pending nine' }), createdAt: '2026-10-13T09:00:00.123Z' }));
    await s.ctl.onUpdate();
    expect(sent).toEqual([[9, '2026-10-13T09:00:00.123Z']]);
    expect([s.get().pending?.version, s.get().message]).toEqual([9, copy.errors.versionChanged]); // still pending, nothing approved
  });

  test('a request written into a pending change keeps the createdAt the api stored', async () => {
    const f = fakes({ revise: async () => ({ ok: true, version: 5, createdAt: '2026-10-13T09:00:00.123Z', draft: sampleDraft({ name: 'Revised' }) }) });
    const s = screen(f.actions);
    s.ctl.setPrompt('more');
    await s.ctl.onAdd();
    expect(s.get().pending).toMatchObject({ version: 5, createdAt: '2026-10-13T09:00:00.123Z' });
    await s.ctl.onUpdate();
    expect(f.calls.at(-1)).toEqual({ name: 'approve', args: [5, '2026-10-13T09:00:00.123Z'] });
  });

  test('Discard leaves the active version', async () => {
    const f = fakes();
    const s = screen(f.actions, initialEdit(sampleDraft(), { version: 9, draft: sampleDraft({ name: 'Pending nine' }) }));
    await s.ctl.onDiscard();
    expect(f.calls).toEqual([{ name: 'discard', args: [9] }]);
    expect(s.get().pending).toBeNull();
    expect(s.get().draft.name).toBe('XLM watcher');
    expect(f.calls.some((c) => c.name === 'approve')).toBe(false);
  });

  test('a failed discard or update keeps the pending change and says why', async () => {
    const f = fakes({ discard: async () => ({ ok: false, message: copy.errors.status5xx }), approve: async () => ({ ok: false, message: copy.errors.status5xx }) });
    const s = screen(f.actions, initialEdit(sampleDraft(), { version: 9, draft: sampleDraft({ name: 'P' }) }));
    await s.ctl.onDiscard();
    expect([s.get().pending?.version, s.get().message]).toEqual([9, copy.errors.status5xx]);
    await s.ctl.onUpdate();
    expect([s.get().pending?.version, s.get().draft.name]).toEqual([9, 'XLM watcher']);
  });

  test('a refused request writes nothing and shows the plain sentence', async () => {
    const f = fakes({ revise: async () => ({ ok: false, message: copy.errors.dailyLimit }) });
    const s = screen(f.actions);
    s.ctl.setPrompt('x');
    await s.ctl.onAdd();
    expect([s.get().pending, s.get().message, s.get().messageFrom, s.get().prompt]).toEqual([null, copy.errors.dailyLimit, 'revise', 'x']);
  });

  test('taps replay the earlier ones; a refused tap leaves the sentence as it was', async () => {
    const f = fakes();
    const s = screen(f.actions);
    expect(await s.ctl.onEdit('drop', 7)).toBe(true);
    expect(await s.ctl.onEdit('how', 'sms')).toBe(true);
    expect(f.calls.map((c) => c.args)).toEqual([
      ['drop', 7, []],
      ['how', 'sms', [{ param: 'drop', value: 7 }]],
    ]);
    expect(s.get().edits).toEqual([{ param: 'drop', value: 7 }, { param: 'how', value: 'sms' }]);
    await s.ctl.onEdit('drop', 9); // the latest value of a parameter replaces its earlier tap
    expect(s.get().edits).toEqual([{ param: 'how', value: 'sms' }, { param: 'drop', value: 9 }]);
    const before = s.get().draft;
    const refuse = screen(fakes({ edit: async () => ({ ok: false, message: copy.errors.badEdit }) }).actions);
    expect(await refuse.ctl.onEdit('drop', 99)).toBe(false);
    expect([refuse.get().draft === before || refuse.get().draft.params[1]!.kind, refuse.get().message]).toEqual([expect.anything(), copy.errors.badEdit]);
    expect(refuse.get().edits).toEqual([]);
  });

  test('Save changes needs a tap first, then stores and approves; nothing runs twice at once', async () => {
    const f = fakes();
    const s = screen(f.actions);
    await s.ctl.onSave();
    expect(f.calls).toEqual([]);
    await s.ctl.onEdit('drop', 7);
    await Promise.all([s.ctl.onSave(), s.ctl.onSave()]);
    expect(f.calls.filter((c) => c.name === 'save')).toHaveLength(1);
    expect(s.get().edits).toEqual([]);
    expect(s.get().notice).toBe('Updated');
  });

  test('stored but not approved becomes a pending change that Update can finish', async () => {
    const f = fakes({ save: async () => ({ ok: false, message: copy.errors.status5xx, version: 4 }) });
    const s = screen(f.actions);
    await s.ctl.onEdit('drop', 7);
    await s.ctl.onSave();
    expect(s.get().pending).toMatchObject({ version: 4 });
    expect(s.get().message).toBe(copy.errors.status5xx);
    await s.ctl.onUpdate();
    expect(f.calls.at(-1)).toEqual({ name: 'approve', args: [4] });
  });

  test('the box is closed to a new request while there are unsaved taps', async () => {
    const f = fakes();
    const s = screen(f.actions);
    await s.ctl.onEdit('drop', 7);
    s.ctl.setPrompt('more');
    await s.ctl.onAdd();
    expect(f.calls.some((c) => c.name === 'revise')).toBe(false);
  });

  test('Save changes sends PUT with view then approve, in that order', async () => {
    const seen: { path: string; method?: string | undefined; body?: unknown; token?: string | undefined }[] = [];
    const api: ApiCall = async (path, o) => {
      seen.push({ path, method: o?.method, body: o?.body, token: o?.token });
      return path.endsWith('/spec') ? { status: 201, json: { version: 7 } } : { status: 204, json: null };
    };
    const a = createAgentEditActions({ api, token: async () => 'tok' });
    const draft = sampleDraft();
    expect(await a.save(AGENT_ID, draft)).toEqual({ ok: true });
    expect(seen.map((s) => `${s.method} ${s.path}`)).toEqual([`PUT /api/agents/${AGENT_ID}/spec`, `POST /api/agents/${AGENT_ID}/spec/7/approve`]);
    expect(seen[0]!.body).toEqual({ spec: draft.spec, view: { sentence: draft.sentence, params: draft.params, bindings: draft.bindings } });
    expect(seen.every((s) => s.token === 'tok')).toBe(true);
  });

  test('a failed PUT never approves; a failed approve hands back the stored version', async () => {
    const seen: string[] = [];
    const mk = (put: number, approve: number): ApiCall => async (path, o) => {
      seen.push(`${o?.method} ${path.replace(AGENT_ID, ':id')}`);
      return path.endsWith('/spec') ? { status: put, json: put === 201 ? { version: 3 } : { error: 'bad_view' } } : { status: approve, json: null };
    };
    const bad = await createAgentEditActions({ api: mk(400, 204), token: async () => 't' }).save(AGENT_ID, sampleDraft());
    expect(bad).toEqual({ ok: false, message: copy.errors.badView });
    expect(seen).toEqual(['PUT /api/agents/:id/spec']);
    seen.length = 0;
    const half = await createAgentEditActions({ api: mk(201, 503), token: async () => 't' }).save(AGENT_ID, sampleDraft());
    expect(half).toEqual({ ok: false, message: copy.errors.status5xx, version: 3 });
    expect(seen).toEqual(['PUT /api/agents/:id/spec', 'POST /api/agents/:id/spec/3/approve']);
  });

  test('the server actions call the owner routes: edit, revise, approve, discard', async () => {
    const seen: { path: string; method?: string | undefined; body?: unknown }[] = [];
    const api: ApiCall = async (path, o) => {
      seen.push({ path: path.replace(AGENT_ID, ':id'), method: o?.method, body: o?.body });
      if (path.endsWith('/builder/edit')) return { status: 200, json: { draft: sampleDraft() } };
      if (path.endsWith('/builder/draft')) return { status: 200, json: { version: 6, draft: sampleDraft() } };
      return { status: 204, json: null };
    };
    const a = createAgentEditActions({ api, token: async () => 't' });
    expect((await a.edit(AGENT_ID, 'drop', 7, [{ param: 'every', value: 3600 }])).ok).toBe(true);
    expect(await a.revise(AGENT_ID, 'more')).toMatchObject({ ok: true, version: 6 });
    expect(await a.approve(AGENT_ID, 6)).toEqual({ ok: true });
    expect(await a.approve(AGENT_ID, 6, '2026-10-13T09:00:00.123Z')).toEqual({ ok: true });
    expect(await a.discard(AGENT_ID, 6)).toEqual({ ok: true });
    expect(seen).toEqual([
      { path: '/api/agents/:id/builder/edit', method: 'POST', body: { param: 'drop', value: 7, earlier: [{ param: 'every', value: 3600 }] } },
      { path: '/api/agents/:id/builder/draft', method: 'POST', body: { prompt: 'more' } },
      { path: '/api/agents/:id/spec/6/approve', method: 'POST', body: {} },
      { path: '/api/agents/:id/spec/6/approve', method: 'POST', body: { createdAt: '2026-10-13T09:00:00.123Z' } },
      { path: '/api/agents/:id/spec/6', method: 'DELETE', body: undefined },
    ]);
    // the anonymous Builder route is never used for an owner's tap
    expect(seen.some((s) => s.path === '/api/builder/edit')).toBe(false);
  });

  test('refusals are plain sentences by code and status; Traefik bodies are never read', async () => {
    const act = (res: ApiResult) => createAgentEditActions({ api: async () => res, token: async () => 't' });
    expect(await act({ status: 429, json: { error: 'daily_limit' } }).revise(AGENT_ID, 'x')).toEqual({ ok: false, message: copy.errors.dailyLimit });
    expect(await act({ status: 409, json: { error: 'agent_not_active' } }).revise(AGENT_ID, 'x')).toEqual({ ok: false, message: copy.errors.notActive });
    expect(await act({ status: 400, json: { error: 'bad_edit', problem: 'drop: 9999 is outside 1..50' } }).edit(AGENT_ID, 'drop', 9999, [])).toEqual({ ok: false, message: copy.errors.badEdit });
    expect(await act({ status: 409, json: { error: 'not_discardable' } }).discard(AGENT_ID, 1)).toEqual({ ok: false, message: copy.errors.notFound });
    expect(await act({ status: 502, json: null }).revise(AGENT_ID, 'x')).toEqual({ ok: false, message: copy.errors.status5xx });
    expect(await act({ status: 401, json: { error: 'unauthorized' } }).approve(AGENT_ID, 1)).toEqual({ ok: false, message: copy.errors.unauthorized });
    const none = createAgentEditActions({ api: async () => Promise.reject(new Error('boom')), token: async () => undefined });
    expect(await none.approve(AGENT_ID, 1)).toEqual({ ok: false, message: copy.errors.unauthorized });
    expect(await none.approve('nope', 1)).toEqual({ ok: false, message: copy.errors.notFound });
    const throws = createAgentEditActions({ api: async () => Promise.reject(new Error('boom')), token: async () => 't' });
    expect(JSON.stringify(await throws.discard(AGENT_ID, 1))).not.toContain('boom');
  });

  test('the screen: the sentence, Save changes, and the "Add this to your agent" box', () => {
    const html = renderToStaticMarkup(createElement(EditView, { state: initialEdit(sampleDraft(), null) }));
    const t = text(html);
    expect(t).toContain('Every 5 minutes I check the price');
    expect(t).toContain('Save changes');
    expect(t).toContain('Change something else');
    expect(html).toMatch(/<button[^>]*disabled=""[^>]*data-save/); // nothing to save yet
    expect(html.match(/<button[^>]*data-(?:save|add)/g)).toHaveLength(1); // one primary button
    // One visible box; the raw words sit in the closed "Edit the details" region.
    const advanced = html.slice(html.indexOf('data-advanced=""'), html.indexOf('for="edit-add"'));
    expect(advanced).toContain('hidden=""');
    expect(advanced).toContain('Watch the price.');
    expect(advanced.match(/<textarea/g)).toHaveLength(3); // persona, system prompt, one skill
    expect(html.match(/<textarea/g)).toHaveLength(4);
    expect(html).toContain('Edit the details');
    expect(html.match(/class="card/g)).toHaveLength(1); // one panel
    expect(html).toContain('data-param="drop"');
  });

  test('a pending change shows its sentence with Update and Discard, and no editor under it', () => {
    const html = renderToStaticMarkup(createElement(EditView, { state: initialEdit(sampleDraft(), { version: 5, draft: sampleDraft({ name: 'x' }) }) }));
    expect(html).toContain('data-pending="5"');
    expect(text(html)).toContain('A change is waiting for your approval');
    expect(html).toContain('data-update');
    expect(html).toContain('data-discard');
    expect(html).not.toContain('data-save');
    expect(html).not.toContain('data-add');
    expect(text(html)).toContain(copy.draft.addNote); // the approval explanation lives in this card
  });
  test('the approval explanation is not on the editor', () => {
    expect(text(renderToStaticMarkup(createElement(EditView, { state: initialEdit(sampleDraft(), null) })))).not.toContain(copy.draft.addNote);
  });

  test('unsaved taps enable Save and close the box', async () => {
    const f = fakes();
    const s = screen(f.actions);
    await s.ctl.onEdit('drop', 7);
    const html = renderToStaticMarkup(createElement(EditView, { state: { ...s.get(), prompt: 'more' } }));
    expect(html).not.toMatch(/<button[^>]*disabled=""[^>]*data-save/);
    expect(html).not.toContain('data-add'); // the one button is Save while there are unsaved taps
    expect(html).toMatch(/<textarea[^>]*disabled=""/);
    expect(text(html)).toContain(copy.edit.saveFirst);
    // and the other way round: text typed, nothing tapped -> the one button writes the change
    const typed = renderToStaticMarkup(createElement(EditView, { state: initialEdit(sampleDraft(), null, 'more') }));
    expect(typed).not.toContain('data-save');
    expect(typed).toMatch(/<button[^>]*data-add/);
    expect(typed.slice(typed.indexOf('data-add') - 40, typed.indexOf('data-add') + 12)).not.toContain('disabled=""');
    expect(text(typed)).toContain('Write the change');
  });

  test('?prompt= fills the box and nothing is run; the paid step needs the button', () => {
    const f = fakes();
    const html = renderToStaticMarkup(createElement(EditDescription, { agentId: AGENT_ID, active: { version: 2, draft: sampleDraft() }, pending: null, initialPrompt: 'Also watch USDC', actions: f.actions }));
    expect(html).toContain('Also watch USDC');
    expect(f.calls).toEqual([]);
    const state = initialEdit(sampleDraft(), null, 'Also watch USDC');
    const view = renderToStaticMarkup(createElement(EditView, { state }));
    expect(view).not.toMatch(/<button[^>]*disabled=""[^>]*data-add/); // ready to press
    expect(view).toContain('data-add');
  });

  test('the spec answer becomes the active sentence and the pending change; no view means the name alone', () => {
    const d = sampleDraft();
    const view = { sentence: d.sentence, params: d.params, bindings: d.bindings };
    const shown = asSpecShown({ active: { version: 2, status: 'approved', spec: d.spec, view }, draft: { version: 3, status: 'draft', spec: d.spec, view } }, 'Agent');
    expect(shown?.active?.version).toBe(2);
    expect(shown?.pending?.version).toBe(3);
    expect(shown?.pending?.createdAt).toBeUndefined();
    expect(asSpecShown({ active: null, draft: { version: 3, spec: d.spec, view, createdAt: '2026-10-13T09:00:00.123Z' } }, 'Agent')?.pending?.createdAt).toBe('2026-10-13T09:00:00.123Z');
    expect(shown?.active?.draft.name).toBe('Agent');
    const bare = asSpecShown({ active: { version: 1, spec: d.spec, view: null }, draft: null }, 'Agent');
    expect(bare?.active?.draft.sentence).toEqual(['Agent']);
    expect(bare?.pending).toBeNull();
    expect(asSpecShown({ active: { version: 'x' } }, 'A')).toBeNull();
    expect(asSpecShown('nope', 'A')).toBeNull();
  });
});

// --- earnings ---------------------------------------------------------------------------------------

describe('Earnings', () => {
  const sales = [
    { type: 'sale' as const, at: '2026-10-13T08:05:00Z', usdc: '0.0010000', proofUrl: 'https://agentenact.io/verify?agent=a&tx=b' },
    { type: 'sale' as const, at: '2026-10-12T08:05:00Z', usdc: '0.0020000' },
  ];
  test('earnings lists sales with proof links and the total', () => {
    const html = renderToStaticMarkup(createElement(EarningsList, { overview: { earnedUsdc: '0.0030000', salesCount: 2 }, sales, now: NOW }));
    const t = text(html);
    expect(t).toContain('0.003 USDC on testnet');
    expect(t).toContain('2 proven sales on testnet');
    expect(t).toContain('Sold for 0.001 USDC on testnet');
    expect(html.match(/data-item="sale"/g)).toHaveLength(2);
    expect(html).toContain('divide-y');
    expect(html).toMatch(/<a href="https:\/\/agentenact\.io\/verify\?agent=a&amp;tx=b" target="_blank" rel="noopener noreferrer"[^>]*>proof ↗<\/a>/);
    expect(html.match(/proof ↗/g)).toHaveLength(1); // a sale without a record has no link
  });
  test('empty state', () => {
    const t = text(renderToStaticMarkup(createElement(EarningsList, { overview: { earnedUsdc: '0', salesCount: 0 }, sales: [], now: NOW })));
    expect(t).toContain('Nothing sold yet. Selling is optional.');
    expect(t).toContain('Testnet');
  });
  test('an unsafe proof address is never linked', () => {
    const html = renderToStaticMarkup(createElement(EarningsList, { overview: { earnedUsdc: '0.001', salesCount: 1 }, sales: [{ type: 'sale', at: '2026-10-13T08:05:00Z', usdc: '0.001', proofUrl: 'javascript:alert(1)' }], now: NOW }));
    expect(html).not.toContain('<a ');
    const plain = renderToStaticMarkup(createElement(EarningsList, { overview: { earnedUsdc: '0.001', salesCount: 1 }, sales: [{ type: 'sale', at: '2026-10-13T08:05:00Z', usdc: '0.001', proofUrl: 'http://agentenact.io/verify?agent=a&tx=b' }], now: NOW }));
    expect(plain).not.toContain('<a '); // https only
  });
  test('asSales keeps only sales', () => {
    expect(asSales([{ type: 'sale', at: '2026-10-13T08:05:00Z', usdc: '0.001' }, { type: 'problem', at: '2026-10-13T08:05:00Z' }])).toHaveLength(1);
    expect(asSales({ not: 'a list' })).toBeNull();
  });
});

// --- the pages ------------------------------------------------------------------------------------------

const ME: ApiResult = { status: 200, json: { agent: { id: AGENT_ID, name: 'XLM drop watcher', status: 'active' } } };
const routes = (r: Record<string, ApiResult>): ApiCall => async (path) => r[path.replace(AGENT_ID, ':id')] ?? { status: 404, json: null };
const base = { '/api/me': ME, '/api/agents/:id/overview': { status: 200, json: overview() } } as Record<string, ApiResult>;

describe('panel loading', () => {
  const d = sampleDraft();
  const SPEC = { status: 200, json: { active: { version: 2, spec: d.spec, view: { sentence: d.sentence, params: d.params, bindings: d.bindings } }, draft: null } } as ApiResult;

  test('reads its own route with the token, and only that', async () => {
    const seen: string[] = [];
    const api: ApiCall = async (path, o) => (seen.push(`${path}|${o?.token}`), { status: 200, json: [] });
    const out = await createLoadPanel({ token: async () => 'tok', api }, (id) => `/api/agents/${id}/earnings`, (j) => asSales(j))(AGENT_ID, 'x');
    expect(out).toEqual([]);
    expect(seen).toEqual([`/api/agents/${AGENT_ID}/earnings|tok`]);
  });

  test('the edit panel reads the description with the agent name', async () => {
    const out = await createLoadPanel({ token: async () => 't', api: async () => SPEC }, (id) => `/api/agents/${id}/spec`, (j, name) => asSpecShown(j, name))(AGENT_ID, 'XLM drop watcher');
    expect(out?.active?.version).toBe(2);
  });

  test('no session, a refusal, a Traefik 503, a bad body and a throw are all null, never a throw', async () => {
    const mk = (api: ApiCall, token: string | null = 't') => createLoadPanel({ token: async () => token ?? undefined, api }, (id) => `/api/agents/${id}/earnings`, (j) => asSales(j))(AGENT_ID, 'x');
    expect(await mk(async () => ({ status: 200, json: [] }), null)).toBeNull();
    for (const r of [{ status: 401, json: null }, { status: 503, json: null }, { status: 200, json: { no: 'list' } }] as ApiResult[]) expect(await mk(async () => r)).toBeNull();
    expect(await mk(async () => Promise.reject(new Error('boom')))).toBeNull();
  });

  test('each slot draws its body, or one plain line when its read failed', async () => {
    const o = overview();
    const edit = renderToStaticMarkup(await EditSlot({ id: AGENT_ID, name: o.name, prompt: 'Also watch USDC', load: async () => asSpecShown(SPEC.json, o.name) }));
    expect(edit).toContain('Also watch USDC');
    const earnings = renderToStaticMarkup(await EarningsSlot({ id: AGENT_ID, o, now: NOW, load: async () => [] }));
    expect(earnings).toContain('data-earnings');
    for (const html of [
      renderToStaticMarkup(await EditSlot({ id: AGENT_ID, name: o.name, prompt: '', load: async () => null })),
      renderToStaticMarkup(await SkillsTabSlot({ id: AGENT_ID, name: o.name, now: NOW, load: async () => null })),
      renderToStaticMarkup(await EarningsSlot({ id: AGENT_ID, o, now: NOW, load: async () => null })),
    ]) {
      expect(html).toContain('data-panel-error');
      expect(text(html)).toBe(copy.agent.panelError);
    }
  });
});

describe('tab addresses', () => {
  test('the tab is a query value; Activity has none; extra values ride along', () => {
    expect(agentHref(AGENT_ID)).toBe(`/dashboard/${AGENT_ID}`);
    expect(agentHref(AGENT_ID, 'skills')).toBe(`/dashboard/${AGENT_ID}?tab=skills`);
    expect(agentHref(AGENT_ID, 'whatItDoes', { prompt: 'a b&c', tab: 'chat', run: ['x', 'y'] })).toBe(`/dashboard/${AGENT_ID}?tab=edit&prompt=a+b%26c`);
  });
  test('tabOf reads it back; anything else is Activity', () => {
    for (const t of ['chat', 'whatItDoes', 'skills', 'earnings', 'activity'] as const) expect(tabOf(new URL(`https://x${agentHref(AGENT_ID, t)}`).searchParams.get('tab'))).toBe(t);
    for (const q of [null, undefined, '', 'nope', 'whatItDoes', ['chat', 'skills']]) expect(tabOf(q)).toBe('activity');
  });
  test('the old tab paths go to the same tab on the one page, query kept', async () => {
    const params = Promise.resolve({ id: AGENT_ID });
    expect(await redirectOf(LegacySkillsTab({ params, searchParams: Promise.resolve({}) }))).toContain(`;/dashboard/${AGENT_ID}?tab=skills;`);
    expect(await redirectOf(LegacyEditTab({ params, searchParams: Promise.resolve({ prompt: 'more' }) }))).toContain(`;/dashboard/${AGENT_ID}?tab=edit&prompt=more;`);
  });
});

describe('the one page', () => {
  const ready = (o = overview()): LoadAgent => async () => ({ kind: 'ready', id: AGENT_ID, overview: o, feed: [] });
  const loaders: PanelLoaders = { edit: async () => null, skills: async () => null, earnings: async () => null };

  test('every tab is on the page; the address names the one that shows and the rail marks it', async () => {
    for (const [q, tab, label] of [[undefined, 'activity', 'Activity'], ['chat', 'chat', 'Chat'], ['edit', 'whatItDoes', 'What it does'], ['skills', 'skills', 'Skills'], ['earnings', 'earnings', 'Earnings']] as const) {
      const html = renderToStaticMarkup(await AgentScreen({ load: ready(), id: AGENT_ID, now: NOW, panelLoaders: loaders, searchParams: q ? { tab: q } : {} }));
      expect(text(html)).toContain('XLM drop watcher');
      expect(html.match(/aria-current="page"/g)).toHaveLength(1);
      expect(html.slice(html.indexOf('aria-current="page"'))).toContain(`>${label.replace("'", '&#x27;')}<`);
      for (const t of ['activity', 'chat', 'whatItDoes', 'skills', 'earnings']) expect(html).toContain(`data-panel="${t}"`);
      expect(html.match(/data-panel="[a-zA-Z]+"(?! hidden)/g)).toEqual([`data-panel="${tab}"`]);
    }
  });

  test('tabs are plain links to their address, so a new browser tab works too', async () => {
    const html = renderToStaticMarkup(await AgentScreen({ load: ready(), id: AGENT_ID, now: NOW, searchParams: {} }));
    expect(html).toContain(`href="/dashboard/${AGENT_ID}?tab=skills"`);
    expect(html).toContain(`href="/dashboard/${AGENT_ID}"`);
  });

  test('there is only ever one agent here: no create button on any tab', async () => {
    const html = renderToStaticMarkup(await AgentScreen({ load: ready(), id: AGENT_ID, now: NOW, panelLoaders: loaders, searchParams: {} }));
    expect(text(html)).not.toMatch(/create an agent|new agent|another agent/i);
    expect(html).not.toContain('data-create');
  });

  test('an idea from the draft screen opens What it does with it; already there, it stays', async () => {
    expect(await redirectOf(AgentScreen({ load: ready(), id: AGENT_ID, now: NOW, searchParams: { prompt: 'Also watch USDC' } }))).toContain(`;/dashboard/${AGENT_ID}?tab=edit&prompt=Also+watch+USDC;`);
    expect(await redirectOf(AgentScreen({ load: ready(), id: AGENT_ID, now: NOW, searchParams: { tab: 'edit', prompt: 'Also watch USDC' } }))).toBeNull();
  });
});
