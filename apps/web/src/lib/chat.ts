/**
 * The chat as plain data: every open conversation's messages, the reducer, and the controller that sends a turn and reads
 * the stream. Threads are kept per conversation, so switching tabs never stops an answer being written and a tab comes back
 * instantly. The transport (the browser's fetch to the api) is handed in, so tests drive it with fakes. Message text is
 * never logged and never leaves the tab except in the one request that sends it.
 */
import { copy, errorCopy } from '../copy';
import { parseSse, type SseFrame } from './sse';

/** Mirrors the api: up to 20 messages of up to 3000 characters, ending with the user's turn. */
export const CHAT_MAX_MESSAGES = 20;
export const CHAT_MESSAGE_MAX = 3000;
export const CHAT_TITLE_MAX = 80;
/** The key of the new chat that has no conversation on the server yet (one opens with its first message). */
export const DRAFT = '';

export interface ToolStep {
  id: number;
  name: string;
  state: 'running' | 'done' | 'failed';
}

export interface ChatMessage {
  role: 'user' | 'assistant';
  content: string;
  /** A turn that did not finish: an answer cut short, or (on the question) one that never came. Not sent again. */
  failed?: true;
  /** The owner stopped this turn. */
  stopped?: true;
  /** The tools this answer called, live while it is written. */
  tools?: ToolStep[];
  /** Words arrive next after a tool call: shown as a new paragraph. Display only; the stored answer is the api's own. */
  gap?: true;
  /** On a kept answer: its own seal on Stellar, and the decision seal when the turn paid (tx once landed). */
  seal?: TurnSeal | null;
  decision?: TurnSeal | null;
}

export interface TurnSeal {
  status: 'pending' | 'sent' | 'failed';
  tx: string | null;
}

export interface StoredTurn {
  question: string;
  answer: string;
  status: string;
  seal?: TurnSeal | null;
  decision?: TurnSeal | null;
  tools?: string[];
}

export interface ChatSessionList {
  sessions: ChatSessionInfo[];
  sealEach: boolean;
}

/** One of the owner's conversations with the agent, as the api lists it. */
export interface ChatSessionInfo {
  id: string;
  title: string | null;
  turns: number;
  createdAt?: string;
  updatedAt: string;
  /** The newest seal of this conversation that landed on Stellar: how many turns its root covers, and its transaction. */
  sealed: { turns: number; tx: string } | null;
  /** Any seal, pending or landed: deleting this chat removes the words and keeps those. */
  hasSeals?: boolean;
}

export interface ChatThread {
  messages: ChatMessage[];
  /** One plain sentence under the list, or null. */
  note: string | null;
  /** Its turns are being read back. */
  loading?: boolean;
}

export interface ChatState {
  /** The conversation on screen: a session id, or DRAFT. */
  active: string;
  threads: Record<string, ChatThread>;
  /** The conversation whose answer is being written now. The api takes one turn per agent at a time. */
  streaming: string | null;
  sessions: ChatSessionInfo[];
  /** The owner's archived chats, once asked for. */
  archived: ChatSessionInfo[] | null;
  /** The chats are being listed for the first time. */
  loading?: boolean;
  /** Every message is also sealed on its own as it is sent (the api's per-agent setting, on by default). */
  sealEach: boolean;
}

export const initialChat: ChatState = { active: DRAFT, threads: {}, streaming: null, sessions: [], archived: null, sealEach: true };

const NO_THREAD: ChatThread = { messages: [], note: null };
export const threadOf = (s: ChatState, key: string = s.active): ChatThread => s.threads[key] ?? NO_THREAD;

/** One tab of the strip. */
export interface ChatTab {
  key: string;
  title: string | null;
  live: boolean;
  archived: boolean;
  session: ChatSessionInfo | null;
}

/** The tabs, in a steady order (oldest on the left, so sending never shuffles them), the new chat last. */
export function tabsOf(s: ChatState): ChatTab[] {
  const shown = s.sessions.filter((x) => x.turns > 0 || x.id === s.active || (s.threads[x.id]?.messages.length ?? 0) > 0);
  const when = (x: ChatSessionInfo) => x.createdAt ?? x.updatedAt;
  const open = [...shown].sort((a, b) => (when(a) < when(b) ? -1 : when(a) > when(b) ? 1 : 0));
  const tabs: ChatTab[] = open.map((x) => ({ key: x.id, title: x.title, live: s.streaming === x.id, archived: false, session: x }));
  const put = s.archived?.find((x) => x.id === s.active);
  if (put) tabs.push({ key: put.id, title: put.title, live: false, archived: true, session: put });
  if (s.active === DRAFT || tabs.length === 0) tabs.push({ key: DRAFT, title: threadOf(s, DRAFT).messages[0]?.content.slice(0, CHAT_TITLE_MAX) ?? null, live: s.streaming === DRAFT, archived: false, session: null });
  return tabs;
}

/** The tab to show when `key`'s goes away: the one to its right, else its left, else a new chat. */
export function nextTab(s: ChatState, key: string): string {
  const tabs = tabsOf(s).filter((t) => t.key !== DRAFT);
  const i = tabs.findIndex((t) => t.key === key);
  return (tabs[i + 1] ?? tabs[i - 1])?.key ?? DRAFT;
}

export type ChatAction =
  | { t: 'sent'; text: string; key?: string }
  | { t: 'delta'; text: string; key?: string }
  | { t: 'tool'; step: ToolStep; key?: string }
  | { t: 'done'; note: string | null; key?: string }
  | { t: 'failed'; message: string; key?: string }
  | { t: 'stopped'; key?: string }
  | { t: 'retrying'; key?: string }
  | { t: 'activate'; key: string }
  | { t: 'loading'; key?: string }
  | { t: 'listing' }
  | { t: 'opened'; key: string; messages: ChatMessage[] }
  /** The draft's first message opened this conversation on the server: its thread moves there. */
  | { t: 'promoted'; session: ChatSessionInfo }
  | { t: 'sessions'; sessions: ChatSessionList }
  | { t: 'archivedList'; sessions: ChatSessionInfo[] }
  | { t: 'renamed'; id: string; title: string }
  /** Archived: out of the tabs, into the archive when that list has been read. */
  | { t: 'archive'; id: string }
  | { t: 'restored'; session: ChatSessionInfo }
  | { t: 'removed'; id: string }
  | { t: 'sealEach'; on: boolean }
  | { t: 'seals'; key: string; turns: StoredTurn[] };

function withThread(s: ChatState, key: string, f: (t: ChatThread) => ChatThread): ChatState {
  return { ...s, threads: { ...s.threads, [key]: f(threadOf(s, key)) } };
}
const replaceLast = (m: ChatMessage[], last: ChatMessage): ChatMessage[] => [...m.slice(0, -1), last];
function without<T>(r: Record<string, T>, key: string): Record<string, T> {
  const rest = { ...r };
  delete rest[key];
  return rest;
}

/** The turn ends without a finished answer: an empty bubble goes and the question carries the mark, a partial answer stays marked. */
function endTurn(m: ChatMessage[], mark: { failed: true } | { stopped: true }): ChatMessage[] {
  const last = m.at(-1);
  if (!last || last.role !== 'assistant') return m;
  const rest: ChatMessage = { ...last };
  delete rest.gap;
  const tools = rest.tools?.map((x) => (x.state === 'running' ? { ...x, state: 'failed' as const } : x));
  if (last.content === '' && !tools?.length) {
    const before = m.slice(0, -1);
    const q = before.at(-1);
    return q ? replaceLast(before, { ...q, ...mark }) : before;
  }
  return replaceLast(m, { ...rest, ...(tools ? { tools } : {}), ...mark });
}

export function chatReducer(s: ChatState, a: ChatAction): ChatState {
  switch (a.t) {
    case 'sent': {
      const key = a.key ?? s.active;
      return { ...withThread(s, key, (t) => ({ ...t, messages: [...t.messages, { role: 'user', content: a.text }, { role: 'assistant', content: '' }], note: null })), streaming: key };
    }
    case 'delta': {
      const key = a.key ?? s.active;
      const last = threadOf(s, key).messages.at(-1);
      if (s.streaming !== key || !last || last.role !== 'assistant') return s;
      const next: ChatMessage = { ...last, content: last.content + (last.gap && last.content ? '\n\n' : '') + a.text };
      delete next.gap;
      return withThread(s, key, (t) => ({ ...t, messages: replaceLast(t.messages, next) }));
    }
    case 'tool': {
      const key = a.key ?? s.active;
      const last = threadOf(s, key).messages.at(-1);
      if (s.streaming !== key || !last || last.role !== 'assistant') return s;
      const known = last.tools?.some((x) => x.id === a.step.id);
      const tools = known ? last.tools!.map((x) => (x.id === a.step.id ? a.step : x)) : [...(last.tools ?? []), a.step];
      return withThread(s, key, (t) => ({ ...t, messages: replaceLast(t.messages, { ...last, tools, gap: true }) }));
    }
    case 'done': {
      const key = a.key ?? s.active;
      if (s.streaming !== key) return s;
      const last = threadOf(s, key).messages.at(-1);
      const settled: ChatMessage | null = last?.role === 'assistant' ? { ...last } : null;
      if (settled) delete settled.gap;
      return { ...withThread(s, key, (t) => ({ ...t, messages: settled ? replaceLast(t.messages, settled) : t.messages, note: a.note })), streaming: null };
    }
    case 'failed': {
      const key = a.key ?? s.active;
      const live = s.streaming === key;
      return { ...withThread(s, key, (t) => ({ ...t, messages: live ? endTurn(t.messages, { failed: true }) : t.messages, loading: false, note: a.message })), streaming: live ? null : s.streaming };
    }
    case 'stopped': {
      const key = a.key ?? s.active;
      if (s.streaming !== key) return s;
      return { ...withThread(s, key, (t) => ({ ...t, messages: endTurn(t.messages, { stopped: true }) })), streaming: null };
    }
    case 'retrying':
      return withThread(s, a.key ?? s.active, (t) => {
        const m = [...t.messages];
        if (m.at(-1)?.role === 'assistant') m.pop();
        if (m.at(-1)?.role === 'user') m.pop();
        return { ...t, messages: m, note: null };
      });
    case 'activate':
      return { ...s, active: a.key };
    case 'loading':
      return withThread(s, a.key ?? s.active, (t) => ({ ...t, loading: true, note: null }));
    case 'listing':
      return { ...s, loading: true };
    case 'opened':
      return { ...withThread(s, a.key, () => ({ messages: a.messages, note: null, loading: false })), loading: false };
    case 'promoted':
      return {
        ...s,
        threads: { ...without(s.threads, DRAFT), [a.session.id]: threadOf(s, DRAFT) },
        active: s.active === DRAFT ? a.session.id : s.active,
        streaming: s.streaming === DRAFT ? a.session.id : s.streaming,
        sessions: [...s.sessions.filter((x) => x.id !== a.session.id), a.session],
      };
    case 'sessions':
      return { ...s, sessions: a.sessions.sessions, sealEach: a.sessions.sealEach, loading: false };
    case 'archivedList':
      return { ...s, archived: a.sessions };
    case 'renamed': {
      const rename = (x: ChatSessionInfo) => (x.id === a.id ? { ...x, title: a.title } : x);
      return { ...s, sessions: s.sessions.map(rename), archived: s.archived?.map(rename) ?? null };
    }
    case 'archive': {
      const gone = s.sessions.find((x) => x.id === a.id);
      return { ...s, sessions: s.sessions.filter((x) => x.id !== a.id), archived: s.archived && gone ? [gone, ...s.archived] : s.archived };
    }
    case 'restored':
      return { ...s, sessions: [...s.sessions.filter((x) => x.id !== a.session.id), a.session], archived: s.archived?.filter((x) => x.id !== a.session.id) ?? null };
    case 'removed':
      return { ...s, threads: without(s.threads, a.id), sessions: s.sessions.filter((x) => x.id !== a.id), archived: s.archived?.filter((x) => x.id !== a.id) ?? null };
    case 'sealEach':
      return { ...s, sealEach: a.on };
    case 'seals': {
      // Seals land after the answer: copy them onto the shown answers, only when the tab still shows the same turns.
      if (s.streaming === a.key) return s;
      const shown = threadOf(s, a.key).messages;
      const fresh = turnsToMessages(a.turns);
      if (fresh.length !== shown.length || fresh.some((m, i) => m.role !== shown[i]!.role)) return s;
      return withThread(s, a.key, (t) => ({ ...t, messages: shown.map((m, i) => (m.role === 'assistant' ? { ...m, seal: fresh[i]!.seal ?? null, decision: fresh[i]!.decision ?? null } : m)) }));
    }
  }
}

/** What goes to the api: finished turns only, the most recent 20, starting with a question, ending with the new one. */
export function toApiMessages(history: readonly ChatMessage[], next: string): { role: 'user' | 'assistant'; content: string }[] {
  const out: { role: 'user' | 'assistant'; content: string }[] = [];
  for (let i = 0; i < history.length; i++) {
    const m = history[i]!;
    const after = history[i + 1];
    if (m.failed || m.stopped) continue;
    if (m.role === 'user' && (after?.failed || after?.stopped)) continue; // asked, never answered
    if (m.role === 'assistant' && m.content === '') continue;
    out.push({ role: m.role, content: m.content });
  }
  out.push({ role: 'user', content: next });
  let tail = out.slice(-CHAT_MAX_MESSAGES);
  while (tail[0]?.role === 'assistant') tail = tail.slice(1);
  return tail;
}

export interface ChatOpen {
  status: number;
  /** The api's `error` code, for the statuses whose JSON body survives the proxy. */
  code?: string | undefined;
  chunks?: AsyncIterable<Uint8Array> | undefined;
}
export interface ChatTransport {
  /**
   * Sends a turn. With a `sessionId` the api keeps the history and only the last (new) message is sent; without one the
   * browser-held history goes along, as before conversations were kept.
   */
  open(agentId: string, messages: { role: 'user' | 'assistant'; content: string }[], signal: AbortSignal, sessionId?: string): Promise<ChatOpen>;
  /** The server-kept conversations. Each answers null when the api refused. */
  sessions?: {
    list(agentId: string, o?: { archived?: boolean }): Promise<ChatSessionList | null>;
    /** Turns sealing each message on or off; answers the setting the api now holds, or null when it refused. */
    setSealEach(agentId: string, on: boolean): Promise<boolean | null>;
    create(agentId: string): Promise<ChatSessionInfo | null>;
    turns(agentId: string, sessionId: string): Promise<StoredTurn[] | null>;
    /** Renames and/or archives; answers whether the api did it. */
    update(agentId: string, sessionId: string, c: { title?: string; archived?: boolean }): Promise<boolean>;
    /** Deletes; `kept` when the chat has seals, so only its words went. Null when the api refused. */
    remove(agentId: string, sessionId: string): Promise<{ kept: boolean } | null>;
  };
}

/** Stored turns as messages: an answer that never came is shown as failed, like a turn that failed in this tab. */
export function turnsToMessages(turns: readonly StoredTurn[]): ChatMessage[] {
  return turns.flatMap((t) => {
    const ok = t.answer !== '' && (t.status === 'done' || t.status === 'budget');
    const tools = t.tools?.length ? { tools: t.tools.map((name, i) => ({ id: i + 1, name, state: 'done' as const })) } : {};
    const hasAnswer = t.answer !== '' || 'tools' in tools;
    const answer: ChatMessage = { role: 'assistant', content: t.answer, ...(ok ? {} : { failed: true as const }), ...tools, seal: t.seal ?? null, decision: t.decision ?? null };
    const question: ChatMessage = { role: 'user', content: t.question, ...(hasAnswer ? {} : { failed: true as const }) };
    return [question, ...(hasAnswer ? [answer] : [])];
  });
}

/** Re-reads after a turn, for its seal: the worker lands one within seconds, a busy queue takes longer. */
export const SEAL_REFRESH_MS = [6_000, 20_000, 60_000] as const;

/** Plain sentence for a refused or failed chat request. */
export function chatErrorCopy(status: number, code?: string): string {
  if (status === 401) return errorCopy('unauthorized', status);
  if (status === 429 && code === 'chat_busy') return errorCopy('chat_busy', status);
  if (status === 409) return errorCopy('not_active', status); // agent_not_active, agent_revoked: it is not running
  return errorCopy(undefined, status);
}

export interface ChatControllerDeps {
  agentId: string;
  transport: ChatTransport;
  getState(): ChatState;
  dispatch(a: ChatAction): void;
  /** Runs `f` before the next paint, so a burst of words is drawn once a frame. */
  schedule?: (f: () => void) => void;
}

/** Once a frame; a hidden page has no frames, and its words still need to arrive. */
const nextFrame = (f: () => void) => {
  if (typeof requestAnimationFrame === 'function' && typeof document !== 'undefined' && !document.hidden) requestAnimationFrame(f);
  else setTimeout(f, 50);
};

export function createChatController(d: ChatControllerDeps) {
  let abort: AbortController | null = null;
  const kept = d.transport.sessions;
  const schedule = d.schedule ?? nextFrame;
  const timers = new Map<string, ReturnType<typeof setTimeout>[]>();
  const clearSeals = (key: string) => {
    for (const t of timers.get(key) ?? []) clearTimeout(t);
    timers.delete(key);
  };
  /** Reads the conversation's seals again a few times after a turn, until every shown answer's seal has landed. */
  function followSeals(sessionId: string) {
    clearSeals(sessionId);
    timers.set(
      sessionId,
      SEAL_REFRESH_MS.map((ms) =>
        setTimeout(() => {
          const s = d.getState();
          if (threadOf(s, sessionId).messages.every((m) => m.role === 'user' || m.failed || (m.seal?.status !== 'pending' && m.decision?.status !== 'pending' && (m.seal !== null || !s.sealEach)))) return;
          void kept?.turns(d.agentId, sessionId).then((turns) => turns && d.dispatch({ t: 'seals', key: sessionId, turns }), () => undefined);
        }, ms),
      ),
    );
  }
  const refreshList = async (): Promise<void> => {
    const x = await kept?.list(d.agentId).catch(() => null);
    if (x) d.dispatch({ t: 'sessions', sessions: x });
  };

  /** Shows a conversation at once; its turns are read only the first time. Best effort: a chat that cannot be read gives way. */
  async function show(key: string): Promise<void> {
    d.dispatch({ t: 'activate', key });
    if (key === DRAFT || !kept || d.getState().threads[key]) return;
    d.dispatch({ t: 'loading', key });
    const turns = await kept.turns(d.agentId, key).catch(() => null);
    if (turns) return d.dispatch({ t: 'opened', key, messages: turnsToMessages(turns) });
    d.dispatch({ t: 'removed', id: key });
    if (d.getState().active === key) await show(d.getState().sessions.find((x) => x.turns > 0)?.id ?? DRAFT);
  }

  async function sendTurn(text: string): Promise<void> {
    const s = d.getState();
    let key = s.active;
    const messages = toApiMessages(threadOf(s, key).messages, text);
    // The question is on screen before anything leaves the tab, the first message of a new chat included.
    d.dispatch({ t: 'sent', text, key });
    const mine = new AbortController();
    abort = mine;
    let finished = false;
    let words = '';
    let due = false;
    const flush = () => {
      due = false;
      if (words) d.dispatch({ t: 'delta', text: words, key });
      words = '';
    };
    try {
      if (key === DRAFT && kept) {
        const created = await kept.create(d.agentId);
        if (!created) throw new Error('create');
        d.dispatch({ t: 'promoted', session: { ...created, title: text.replace(/\s+/g, ' ').slice(0, CHAT_TITLE_MAX) } });
        key = created.id;
      }
      if (mine.signal.aborted) return;
      const open = await d.transport.open(d.agentId, messages, mine.signal, key === DRAFT ? undefined : key);
      if (open.status !== 200 || !open.chunks) return d.dispatch({ t: 'failed', message: chatErrorCopy(open.status, open.code), key });
      for await (const f of parseSse(open.chunks) as AsyncIterable<SseFrame>) {
        const data = f.data as { text?: unknown; status?: unknown; id?: unknown; name?: unknown; state?: unknown } | null;
        if (f.event === 'delta' && data && typeof data.text === 'string') {
          words += data.text;
          if (!due) {
            due = true;
            schedule(flush);
          }
        } else if (f.event === 'tool' && data && typeof data.id === 'number' && typeof data.name === 'string' && (data.state === 'running' || data.state === 'done' || data.state === 'failed')) {
          flush();
          d.dispatch({ t: 'tool', step: { id: data.id, name: data.name, state: data.state }, key });
        } else if (f.event === 'done') {
          flush();
          finished = true;
          if (data?.status === 'error' || data?.status === 'capped') d.dispatch({ t: 'failed', message: copy.chat.failed, key });
          else d.dispatch({ t: 'done', note: data?.status === 'budget' ? copy.agent.stoppedToday : null, key });
        }
      }
      flush();
      // The stream closed without its last frame (a dropped connection).
      if (!finished && !mine.signal.aborted) d.dispatch({ t: 'failed', message: copy.chat.failed, key });
    } catch {
      if (!mine.signal.aborted) {
        flush();
        d.dispatch({ t: 'failed', message: copy.chat.failed, key });
      }
    } finally {
      if (abort === mine) abort = null;
      // The list's titles and seals moved with this turn (a stopped turn is stored too).
      if (kept && key !== DRAFT) {
        const sid = key;
        void refreshList();
        void kept.turns(d.agentId, sid).then((turns) => turns && d.dispatch({ t: 'seals', key: sid, turns }), () => undefined);
        followSeals(sid);
      }
    }
  }

  /** The owner pressed Stop: what was written stays. The api notices the closed connection and stores the turn. */
  function stopAnswer(): void {
    const key = d.getState().streaming;
    abort?.abort();
    if (key !== null) d.dispatch({ t: 'stopped', key });
  }

  return {
    /** Lists the owner's chats and opens the one the address names, else the one used last, else a new chat. */
    async load(wanted?: string | null): Promise<void> {
      if (!kept) return;
      d.dispatch({ t: 'listing' });
      const sessions = await kept.list(d.agentId).catch(() => null);
      if (sessions) d.dispatch({ t: 'sessions', sessions });
      else d.dispatch({ t: 'opened', key: DRAFT, messages: [] });
      // A link to an archived chat opens it as archived: read-only, with the way to unarchive it.
      if (wanted && sessions && !sessions.sessions.some((x) => x.id === wanted)) {
        const put = await kept.list(d.agentId, { archived: true }).catch(() => null);
        if (put) d.dispatch({ t: 'archivedList', sessions: put.sessions });
      }
      await show(wanted ?? sessions?.sessions.find((x) => x.turns > 0)?.id ?? DRAFT);
    },
    /** Shows one chat. An answer being written elsewhere keeps going. */
    open: show,
    /** The new chat: nothing is made on the server until its first message. */
    fresh(): void {
      d.dispatch({ t: 'activate', key: DRAFT });
    },
    /** Reads the list again (before a dialog that depends on it). */
    refresh: refreshList,
    /** Seal each message on its own, or only each chat's root. The switch moves at once and goes back if the api refuses. */
    async sealEach(on: boolean): Promise<void> {
      if (!kept) return;
      const was = d.getState().sealEach;
      d.dispatch({ t: 'sealEach', on });
      const now = await kept.setSealEach(d.agentId, on).catch(() => null);
      d.dispatch({ t: 'sealEach', on: now ?? was });
    },
    async listArchived(): Promise<void> {
      const r = await kept?.list(d.agentId, { archived: true }).catch(() => null);
      d.dispatch({ t: 'archivedList', sessions: r?.sessions ?? d.getState().archived ?? [] });
    },
    /** Out of the tabs at once; back again if the api refuses. */
    async archive(id: string): Promise<boolean> {
      if (!kept) return false;
      const before = d.getState();
      const session = before.sessions.find((x) => x.id === id);
      if (!session) return false;
      if (before.active === id) await show(nextTab(before, id));
      d.dispatch({ t: 'archive', id });
      const ok = await kept.update(d.agentId, id, { archived: true }).catch(() => false);
      if (!ok) d.dispatch({ t: 'restored', session });
      return ok;
    },
    async unarchive(id: string): Promise<boolean> {
      if (!kept) return false;
      const session = d.getState().archived?.find((x) => x.id === id);
      const ok = await kept.update(d.agentId, id, { archived: false }).catch(() => false);
      if (ok && session) d.dispatch({ t: 'restored', session });
      return ok;
    },
    async rename(id: string, title: string): Promise<boolean> {
      const clean = title.replace(/\s+/g, ' ').trim().slice(0, CHAT_TITLE_MAX);
      if (!kept || clean === '') return false;
      const ok = await kept.update(d.agentId, id, { title: clean }).catch(() => false);
      if (ok) d.dispatch({ t: 'renamed', id, title: clean });
      return ok;
    },
    /** Deletes a chat. An answer being written in it stops first. False when the api refused, and nothing moved. */
    async remove(id: string): Promise<boolean> {
      if (!kept) return false;
      if (d.getState().streaming === id) stopAnswer();
      const r = await kept.remove(d.agentId, id).catch(() => null);
      if (!r) return false;
      clearSeals(id);
      const s = d.getState();
      if (s.active === id) await show(nextTab(s, id));
      d.dispatch({ t: 'removed', id });
      return true;
    },
    /** Sends the owner's turn and streams the answer into the last message. Returns when the stream has ended. */
    async send(raw: string): Promise<void> {
      const text = raw.trim();
      const s = d.getState();
      if (s.streaming !== null || text === '' || text.length > CHAT_MESSAGE_MAX) return;
      await sendTurn(text);
    },
    /** The last turn again: it failed or was stopped, so its question is sent once more. */
    async retry(): Promise<void> {
      const s = d.getState();
      if (s.streaming !== null) return;
      const question = [...threadOf(s).messages].reverse().find((x) => x.role === 'user');
      if (!question) return;
      d.dispatch({ t: 'retrying' });
      await sendTurn(question.content);
    },
    stopAnswer,
    /** The owner left the page: stop reading. */
    stop(): void {
      abort?.abort();
      for (const key of [...timers.keys()]) clearSeals(key);
    },
  };
}
export type ChatController = ReturnType<typeof createChatController>;
