import { describe, expect, test } from 'bun:test';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { ChatView, enterSends } from '../src/components/chat';
import { copy } from '../src/copy';
import { chatReducer, createChatController, DRAFT, initialChat, nextTab, tabsOf, threadOf, turnsToMessages, type ChatSessionInfo, type ChatState, type ChatTransport, type StoredTurn } from '../src/lib/chat';
import { parseMarkdown, tidyPartial } from '../src/lib/markdown';

const AGENT = '11111111-2222-4333-8444-555555555555';
const S1 = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeee1';
const S2 = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeee2';
const S3 = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeee3';
const TX = 'ab'.repeat(32);
const enc = new TextEncoder();
async function* sse(...frames: string[]): AsyncGenerator<Uint8Array> {
  for (const f of frames) yield enc.encode(f);
}
const delta = (text: string) => `event: delta\ndata: ${JSON.stringify({ text })}\n\n`;
const done = (status = 'done') => `event: done\ndata: {"status":"${status}"}\n\n`;
const info = (id: string, turns: number, over: Partial<ChatSessionInfo> = {}): ChatSessionInfo => ({ id, title: turns ? 'How is XLM?' : null, turns, updatedAt: '2026-10-30T19:00:00.000Z', sealed: null, ...over });
const words = (s: ChatState) => threadOf(s).messages.map((m) => m.content);

/** A chat over a fake api that keeps conversations; `bodies` records what each turn sent. */
function kept(store: Record<string, StoredTurn[]>, o: { sealEach?: boolean; open?: ChatTransport['open']; refuse?: boolean; archived?: string[] } = {}) {
  let state: ChatState = initialChat;
  let sealEach = o.sealEach ?? true;
  const bodies: { sessionId: string | undefined; messages: unknown[] }[] = [];
  const archived = new Set<string>(o.archived);
  const log: string[] = [];
  let made = 0;
  const transport: ChatTransport = {
    open:
      o.open ??
      (async (_id, messages, _signal, sessionId) => {
        bodies.push({ sessionId, messages });
        if (sessionId) store[sessionId]!.push({ question: messages.at(-1)!.content, answer: 'Calm.', status: 'done', seal: { status: 'pending', tx: null }, decision: null });
        return { status: 200, chunks: sse(delta('Calm.'), done()) };
      }),
    sessions: {
      list: async (_a, l) => ({ sessions: Object.entries(store).filter(([id]) => archived.has(id) === (l?.archived === true)).map(([id, t]) => info(id, t.length, { createdAt: id })).reverse(), sealEach }),
      create: async () => {
        const id = made++ === 0 ? S2 : S3;
        store[id] ??= [];
        return info(id, 0, { createdAt: id });
      },
      turns: async (_a, id) => store[id] ?? null,
      setSealEach: async (_a, on) => ((sealEach = on), on),
      update: async (_a, id, c) => {
        log.push(`update ${id} ${JSON.stringify(c)}`);
        if (o.refuse) return false;
        if (c.archived === true) archived.add(id);
        if (c.archived === false) archived.delete(id);
        return true;
      },
      remove: async (_a, id) => {
        log.push(`remove ${id}`);
        if (o.refuse) return null;
        delete store[id];
        return { kept: false };
      },
    },
  };
  // Words are drawn as soon as they arrive here; a browser draws them once a frame.
  const ctl = createChatController({ agentId: AGENT, transport, getState: () => state, dispatch: (a) => (state = chatReducer(state, a)), schedule: (f) => queueMicrotask(f) });
  return { ctl, get: () => state, set: (a: Parameters<typeof chatReducer>[1]) => (state = chatReducer(state, a)), bodies, log };
}

/** A stream the test feeds by hand. */
function liveStream() {
  const q: string[] = [];
  let wake: (() => void) | null = null;
  let ended = false;
  const push = (f: string) => {
    q.push(f);
    wake?.();
  };
  async function* chunks(): AsyncGenerator<Uint8Array> {
    for (;;) {
      while (q.length) yield enc.encode(q.shift()!);
      if (ended) return;
      await new Promise<void>((r) => (wake = r));
    }
  }
  return { chunks: chunks(), push, end: () => ((ended = true), wake?.()) };
}
const tick = () => new Promise((r) => setTimeout(r, 0));

describe('sending', () => {
  test('the question and the typing mark are on screen before anything leaves the tab, on a new chat too', async () => {
    let release!: (v: ChatSessionInfo | null) => void;
    const c = kept({});
    const t = c.ctl;
    await t.load();
    // A slow create: the first message of a chat used to wait here with nothing to show.
    const slow = createChatController({
      agentId: AGENT,
      transport: {
        open: async () => ({ status: 200, chunks: sse(done()) }),
        sessions: { list: async () => null, create: () => new Promise((r) => (release = r)), turns: async () => [], setSealEach: async () => null, update: async () => true, remove: async () => null },
      },
      getState: () => c.get(),
      dispatch: c.set,
    });
    const sending = slow.send('hi');
    expect(words(c.get())).toEqual(['hi', '']); // synchronously, with no await in between
    expect(c.get().streaming).toBe(DRAFT);
    expect(renderToStaticMarkup(createElement(ChatView, { state: c.get(), paused: false }))).toContain('data-chat-typing');
    release(info(S1, 0));
    await sending;
    // It moved onto its conversation with the bubble intact.
    expect(c.get().active).toBe(S1);
    expect(words(c.get())[0]).toBe('hi');
  });

  test('a failure keeps the question with a Retry, and Retry sends it again', async () => {
    let n = 0;
    const c = kept({}, { open: async () => (n++ === 0 ? { status: 503 } : { status: 200, chunks: sse(delta('Back.'), done()) }) });
    await c.ctl.load();
    await c.ctl.send('still here?');
    expect(threadOf(c.get()).messages).toEqual([{ role: 'user', content: 'still here?', failed: true }]);
    expect(threadOf(c.get()).note).toBe(copy.errors.status5xx);
    expect(renderToStaticMarkup(createElement(ChatView, { state: c.get(), paused: false }))).toContain('data-chat-retry');
    await c.ctl.retry();
    expect(words(c.get())).toEqual(['still here?', 'Back.']);
    expect(threadOf(c.get()).note).toBeNull();
  });

  test('a new chat that cannot be opened fails the same way, and the words are not lost', async () => {
    const c = kept({});
    const refused = createChatController({
      agentId: AGENT,
      transport: { open: async () => ({ status: 200 }), sessions: { list: async () => null, create: async () => null, turns: async () => [], setSealEach: async () => null, update: async () => true, remove: async () => null } },
      getState: () => c.get(),
      dispatch: c.set,
    });
    await refused.send('my long question');
    expect(threadOf(c.get()).messages[0]).toEqual({ role: 'user', content: 'my long question', failed: true });
  });

  test('words arrive as they are written, and tool calls show as they happen', async () => {
    const live = liveStream();
    const c = kept({ [S1]: [] }, { open: async () => ({ status: 200, chunks: live.chunks }) });
    c.set({ t: 'sessions', sessions: { sessions: [info(S1, 0)], sealEach: true } });
    await c.ctl.open(S1);
    const sending = c.ctl.send('price?');
    await tick();
    live.push(delta('Let me check.'));
    await tick();
    expect(words(c.get())[1]).toBe('Let me check.');
    live.push('event: tool\ndata: {"id":1,"name":"stellar_price","state":"running"}\n\n');
    await tick();
    expect(threadOf(c.get()).messages[1]!.tools).toEqual([{ id: 1, name: 'stellar_price', state: 'running' }]);
    const during = renderToStaticMarkup(createElement(ChatView, { state: c.get(), paused: false }));
    expect(during).toContain('data-tool="stellar_price"');
    expect(during).toContain('Reading the price');
    expect(during).toContain('data-chat-stop');
    live.push('event: tool\ndata: {"id":1,"name":"stellar_price","state":"done"}\n\n');
    live.push(delta('It is **0.12**'));
    await tick();
    // After a tool call the words start a new paragraph on screen; bold still being written is already bold.
    expect(words(c.get())[1]).toBe('Let me check.\n\nIt is **0.12**');
    live.push(done());
    live.end();
    await sending;
    expect(c.get().streaming).toBeNull();
    expect(renderToStaticMarkup(createElement(ChatView, { state: c.get(), paused: false }))).toContain('Read the price');
    c.ctl.stop();
  });

  test('Stop ends the turn at once, keeps what was written, and frees the chat', async () => {
    const live = liveStream();
    const c = kept({ [S1]: [] }, {
      open: async (_a, _m, signal) => {
        signal.addEventListener('abort', () => live.end());
        return { status: 200, chunks: live.chunks };
      },
    });
    c.set({ t: 'sessions', sessions: { sessions: [info(S1, 0)], sealEach: true } });
    await c.ctl.open(S1);
    const sending = c.ctl.send('go on');
    await tick();
    live.push(delta('Half an'));
    await tick();
    c.ctl.stopAnswer();
    expect(c.get().streaming).toBeNull();
    await sending;
    expect(threadOf(c.get()).messages[1]).toMatchObject({ content: 'Half an', stopped: true });
    expect(threadOf(c.get()).note).toBeNull();
    expect(renderToStaticMarkup(createElement(ChatView, { state: c.get(), paused: false }))).toContain(copy.chat.stopped);
    c.ctl.stop();
  });

  test('Enter sends on a keyboard only', () => {
    const key = { key: 'Enter', shiftKey: false, isComposing: false };
    expect(enterSends(key, false)).toBe(true);
    expect(enterSends(key, true)).toBe(false);
    expect(enterSends({ ...key, shiftKey: true }, false)).toBe(false);
    expect(enterSends({ ...key, isComposing: true }, false)).toBe(false);
  });
});

describe('tabs', () => {
  test('the newest conversation opens with the page, and a turn sends only the new message with its conversation', async () => {
    const store: Record<string, StoredTurn[]> = { [S1]: [{ question: 'How is XLM?', answer: 'Up a bit.', status: 'done', seal: { status: 'sent', tx: TX }, decision: null }] };
    const c = kept(store);
    await c.ctl.load();
    expect(c.get().active).toBe(S1);
    expect(words(c.get())).toEqual(['How is XLM?', 'Up a bit.']);
    expect(threadOf(c.get()).messages[1]!.seal).toEqual({ status: 'sent', tx: TX });
    await c.ctl.send('And now?');
    expect(c.bodies[0]!.sessionId).toBe(S1);
    expect(words(c.get())).toEqual(['How is XLM?', 'Up a bit.', 'And now?', 'Calm.']);
    await Bun.sleep(0);
    expect(threadOf(c.get()).messages[3]!.seal).toEqual({ status: 'pending', tx: null });
    c.ctl.stop();
  });

  test('the address can name the chat to open; one that cannot be read gives way to the newest', async () => {
    const store: Record<string, StoredTurn[]> = { [S1]: [{ question: 'a', answer: 'b', status: 'done' }], [S2]: [{ question: 'c', answer: 'd', status: 'done' }] };
    const c = kept(store);
    await c.ctl.load(S1);
    expect(c.get().active).toBe(S1);
    const gone = kept(store);
    await gone.ctl.load(S3);
    expect(gone.get().active).toBe(S2);
  });

  test('+ asks nothing of the server; the first message opens the conversation, and the one left behind is sealed by the api', async () => {
    const store: Record<string, StoredTurn[]> = { [S1]: [{ question: 'q', answer: 'a', status: 'done' }] };
    const c = kept(store);
    await c.ctl.load();
    c.ctl.fresh();
    expect(c.get().active).toBe(DRAFT);
    expect(store[S2]).toBeUndefined();
    expect(tabsOf(c.get()).map((t) => t.key)).toEqual([S1, DRAFT]);
    await c.ctl.send('new one');
    expect(c.get().active).toBe(S2);
    expect(c.bodies[0]!.sessionId).toBe(S2);
    expect(tabsOf(c.get()).map((t) => t.key)).toEqual([S1, S2]);
    await c.ctl.open(S1);
    expect(words(c.get())).toEqual(['q', 'a']);
    c.ctl.stop();
  });

  test('an answer keeps being written in its own tab while another is open; sending elsewhere waits, the api takes one turn per agent', async () => {
    const live = liveStream();
    const store: Record<string, StoredTurn[]> = { [S1]: [{ question: 'q', answer: 'a', status: 'done' }], [S2]: [{ question: 'r', answer: 'b', status: 'done' }] };
    const c = kept(store, { open: async () => ({ status: 200, chunks: live.chunks }) });
    await c.ctl.load(S1);
    const sending = c.ctl.send('more');
    await tick();
    await c.ctl.open(S2);
    expect(c.get().active).toBe(S2);
    live.push(delta('still going'));
    await tick();
    expect(threadOf(c.get(), S1).messages.at(-1)!.content).toBe('still going');
    expect(words(c.get())).toEqual(['r', 'b']);
    const html = renderToStaticMarkup(createElement(ChatView, { state: c.get(), paused: false, onNew: () => undefined, onOpen: () => undefined }));
    expect(html).toContain('data-chat-elsewhere');
    expect(html).not.toContain('data-chat-stop');
    await c.ctl.send('not now');
    expect(words(c.get())).toEqual(['r', 'b']);
    live.push(done());
    live.end();
    await sending;
    c.ctl.stop();
  });

  test('tabs keep their order when a chat moves up the list', () => {
    const s: ChatState = { ...initialChat, active: S1, sessions: [info(S2, 2, { createdAt: '2026-10-02T00:00:00.000Z' }), info(S1, 1, { createdAt: '2026-10-01T00:00:00.000Z' })] };
    expect(tabsOf(s).map((t) => t.key)).toEqual([S1, S2]);
    expect(nextTab(s, S1)).toBe(S2);
    expect(nextTab(s, S2)).toBe(S1);
    expect(nextTab({ ...s, sessions: [info(S1, 1)] }, S1)).toBe(DRAFT);
  });

  test('archive leaves the tabs at once and reads back in the archive; unarchive returns it; a refusal puts it back', async () => {
    const store: Record<string, StoredTurn[]> = { [S1]: [{ question: 'q', answer: 'a', status: 'done' }], [S2]: [{ question: 'r', answer: 'b', status: 'done' }] };
    const c = kept(store);
    await c.ctl.load(S1);
    expect(await c.ctl.archive(S1)).toBe(true);
    expect(c.get().active).toBe(S2);
    expect(tabsOf(c.get()).map((t) => t.key)).toEqual([S2]);
    await c.ctl.listArchived();
    expect(c.get().archived?.map((x) => x.id)).toEqual([S1]);
    // Opened from the archive it can be read, and the bar says how to carry on.
    await c.ctl.open(S1);
    const reading = renderToStaticMarkup(createElement(ChatView, { state: c.get(), paused: false, onNew: () => undefined, onOpen: () => undefined }));
    expect(reading).toContain('data-chat-archived-note');
    expect(reading).not.toContain('data-send');
    expect(await c.ctl.unarchive(S1)).toBe(true);
    expect(tabsOf(c.get()).map((t) => t.key).sort()).toEqual([S1, S2]);

    const refused = kept({ [S1]: [{ question: 'q', answer: 'a', status: 'done' }] }, { refuse: true });
    await refused.ctl.load(S1);
    expect(await refused.ctl.archive(S1)).toBe(false);
    expect(refused.get().sessions.map((x) => x.id)).toEqual([S1]);
  });

  test('a link to an archived chat opens it as archived, with no composer', async () => {
    const store: Record<string, StoredTurn[]> = { [S1]: [{ question: 'q', answer: 'a', status: 'done' }], [S2]: [{ question: 'r', answer: 'b', status: 'done' }] };
    const c = kept(store);
    await c.ctl.load(S1);
    await c.ctl.archive(S1);
    const again = kept(store, { archived: [S1] });
    await again.ctl.load(S1);
    expect(again.get().active).toBe(S1);
    const html = renderToStaticMarkup(createElement(ChatView, { state: again.get(), paused: false, onNew: () => undefined, onOpen: () => undefined }));
    expect(html).toContain('data-chat-archived-note');
    expect(html).not.toContain('data-send');
  });

  test('delete takes the tab and its thread; a refusal changes nothing', async () => {
    const store: Record<string, StoredTurn[]> = { [S1]: [{ question: 'q', answer: 'a', status: 'done' }], [S2]: [{ question: 'r', answer: 'b', status: 'done' }] };
    const c = kept(store);
    await c.ctl.load(S1);
    expect(await c.ctl.remove(S1)).toBe(true);
    expect(c.get().active).toBe(S2);
    expect(c.get().threads[S1]).toBeUndefined();
    expect(c.log).toContain(`remove ${S1}`);
    const refused = kept({ [S1]: [{ question: 'q', answer: 'a', status: 'done' }] }, { refuse: true });
    await refused.ctl.load(S1);
    expect(await refused.ctl.remove(S1)).toBe(false);
    expect(refused.get().active).toBe(S1);
  });

  test('rename updates the tab', async () => {
    const c = kept({ [S1]: [{ question: 'q', answer: 'a', status: 'done' }] });
    await c.ctl.load();
    expect(await c.ctl.rename(S1, '  Prices   today ')).toBe(true);
    expect(tabsOf(c.get())[0]!.title).toBe('Prices today');
    expect(await c.ctl.rename(S1, '   ')).toBe(false);
  });

  test('an api without kept chats falls back to sending the history', async () => {
    let state: ChatState = initialChat;
    const seen: (string | undefined)[] = [];
    const transport: ChatTransport = { open: async (_a, _m, _s, sessionId) => (seen.push(sessionId), { status: 200, chunks: sse(done()) }) };
    const ctl = createChatController({ agentId: AGENT, transport, getState: () => state, dispatch: (a) => (state = chatReducer(state, a)) });
    await ctl.load();
    await ctl.send('hi');
    expect(seen).toEqual([undefined]);
  });

  test('the seal-each switch moves at once and goes back when the api refuses', async () => {
    const c = kept({});
    await c.ctl.load();
    expect(c.get().sealEach).toBe(true);
    await c.ctl.sealEach(false);
    expect(c.get().sealEach).toBe(false);
  });

  test('stored turns read back like live ones: the tools, and a failed turn that can be tried again', () => {
    expect(turnsToMessages([{ question: 'q', answer: '', status: 'error' }])).toEqual([{ role: 'user', content: 'q', failed: true }]);
    expect(turnsToMessages([{ question: 'q', answer: 'par', status: 'error' }])[1]).toMatchObject({ failed: true });
    expect(turnsToMessages([{ question: 'q', answer: 'a', status: 'done', tools: ['web_search'] }])[1]!.tools).toEqual([{ id: 1, name: 'web_search', state: 'done' }]);
  });

  test('the view: tabs, quiet seal links under answers; without kept chats no strip', () => {
    const state: ChatState = {
      ...initialChat,
      active: S1,
      sessions: [info(S1, 1, { sealed: { turns: 1, tx: TX } }), info(S2, 2)],
      threads: {
        [S1]: {
          note: null,
          messages: [
            { role: 'user', content: 'q' },
            { role: 'assistant', content: 'a', seal: { status: 'sent', tx: TX }, decision: { status: 'pending', tx: null } },
          ],
        },
      },
    };
    const html = renderToStaticMarkup(createElement(ChatView, { state, paused: false, onNew: () => undefined, onOpen: () => undefined, onSealEach: () => undefined }));
    expect(html).toContain('data-chat-new');
    expect(html).toContain(`data-chat-tab="${S1}"`);
    expect(html).toContain(`data-chat-tab="${S2}"`);
    expect(html).toContain('aria-selected="true"');
    expect(html).not.toContain('<select');
    expect(html).toContain(`https://stellar.expert/explorer/testnet/tx/${TX}`);
    expect(html).toContain(copy.chat.turnSealed);
    expect(html).toContain(copy.chat.turnSealing);
    expect(html).toContain(copy.chat.sealed(1, 1));
    expect(html).toContain('data-chat-settings');
    const plain = renderToStaticMarkup(createElement(ChatView, { state: initialChat, paused: false }));
    expect(plain).not.toContain('data-chat-new');
    expect(plain).not.toContain('data-chat-settings');
  });

  test('the copy for a sealed delete talks about words and fingerprints, in plain words', () => {
    expect(copy.chat.deleteSealed).toContain('fingerprints');
    expect(copy.chat.deleteSealed).not.toMatch(/\b(tx|hash|transaction|merkle)\b/i);
  });
});

describe('markdown while it is being written', () => {
  const drawn = (md: string) => JSON.stringify(parseMarkdown(tidyPartial(md)));
  test('an unclosed marker is closed, so bold is bold from its first word and asterisks never flash', () => {
    expect(tidyPartial('This is **bo')).toBe('This is **bo**');
    expect(tidyPartial('This is **bo*')).toBe('This is **bo**');
    expect(tidyPartial('This is **bold**')).toBe('This is **bold**');
    expect(tidyPartial('so *it')).toBe('so *it*');
    expect(tidyPartial('use `code')).toBe('use `code`');
    expect(drawn('This is **bo')).toContain('"strong"');
  });
  test('a marker with nothing after it stays hidden until a word comes', () => {
    expect(tidyPartial('Fine **')).toBe('Fine ');
    expect(tidyPartial('Fine *')).toBe('Fine ');
    expect(tidyPartial('one\n-')).toBe('one');
    expect(tidyPartial('one\n##')).toBe('one');
  });
  test('a list line keeps its marker, a link still arriving shows its words, and earlier lines are left alone', () => {
    expect(tidyPartial('- **a')).toBe('- **a**');
    expect(tidyPartial('* item')).toBe('* item');
    expect(tidyPartial('see [the docs](https://ex')).toBe('see the docs');
    expect(tidyPartial('**done**\nnext **a')).toBe('**done**\nnext **a**');
  });
  test('an open code fence is a code block to the end, and its text is left alone', () => {
    expect(tidyPartial('```\nconst a = **b')).toBe('```\nconst a = **b');
    expect(parseMarkdown('look:\n```ts\nconst a = 1;\n')).toEqual([
      { t: 'p', lines: [[{ t: 'text', v: 'look:' }]] },
      { t: 'code', v: 'const a = 1;\n' },
    ]);
    expect(parseMarkdown('```\na\n```\nb').map((x) => x.t)).toEqual(['code', 'p']);
  });
  test('tables are read as tables', () => {
    const [t] = parseMarkdown('| Asset | Price |\n|---|---|\n| XLM | 0.12 |');
    expect(t).toMatchObject({ t: 'table' });
    expect(t!.t === 'table' && t!.rows).toHaveLength(1);
    // A pipe in a sentence is not a table.
    expect(parseMarkdown('a | b is fine')[0]!.t).toBe('p');
  });
});
