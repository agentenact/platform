'use client';
import { memo, useEffect, useMemo, useReducer, useRef, useState } from 'react';
import { useSearchParams } from 'next/navigation';
import { setPausedAction } from '@/app/actions/agent';
import { ArchivedList, ChatSettings, ChatTabs, DeleteChatDialog, RenameChatDialog } from '@/components/chat-tabs';
import { Markdown } from '@/components/markdown';
import { Seal } from '@/components/seal';
import { SealLoader } from '@/components/seal-loader';
import { Button } from '@/components/ui/button';
import { copy } from '@/copy';
import { chatReducer, createChatController, initialChat, tabsOf, threadOf, CHAT_MESSAGE_MAX, DRAFT, type ChatMessage, type ChatSessionInfo, type ChatState, type ChatTransport, type ToolStep } from '@/lib/chat';
import { browserChatTransport } from '@/lib/chat-client';
import { tidyPartial } from '@/lib/markdown';
import { doingWords, stepWords } from '@/lib/run-words';

const c = copy.chat;
const stellarTx = (tx: string) => `https://stellar.expert/explorer/testnet/tx/${tx}`;
/** Where the tab strip sticks, under the page header. */
const STRIP_TOP = 74;
const LINE = { fill: 'none', stroke: 'currentColor', strokeLinecap: 'round', strokeLinejoin: 'round' } as const;

/** Enter sends on a keyboard. A phone's return key makes a new line; its send button sends. */
export const enterSends = (e: { key: string; shiftKey: boolean; isComposing: boolean }, coarse: boolean) => e.key === 'Enter' && !e.shiftKey && !e.isComposing && !coarse;

/** What the tools of one answer are doing, as they happen; once all are finished, one quiet line. */
function ToolSteps({ tools }: { tools: ToolStep[] }) {
  if (tools.every((t) => t.state !== 'running')) {
    return (
      <p data-tool-summary="" className="mb-2 flex items-center gap-1.5 text-[13px] text-fg-3">
        <svg aria-hidden="true" viewBox="0 0 16 16" className="size-3.5 shrink-0" strokeWidth="1.6" {...LINE}>
          <path d="M3.5 8.5l3 3 6-7" />
        </svg>
        <span className="min-w-0">{stepWords(tools.map((t) => t.name))}</span>
      </p>
    );
  }
  return (
    <ul data-tool-steps="" className="mb-2 flex flex-col gap-1 text-[13px] text-fg-3">
      {tools.map((t) => (
        <li key={t.id} data-tool={t.name} data-state={t.state} className={`chat-in flex items-center gap-1.5 ${t.state === 'running' ? 'text-fg-2' : ''}`}>
          {t.state === 'running' ? (
            <SealLoader size={14} className="shrink-0 text-accent" />
          ) : (
            <svg aria-hidden="true" viewBox="0 0 16 16" className="size-3.5 shrink-0" strokeWidth="1.6" {...LINE}>
              <path d={t.state === 'done' ? 'M3.5 8.5l3 3 6-7' : 'M4.5 4.5l7 7M11.5 4.5l-7 7'} />
            </svg>
          )}
          <span>{doingWords(t.name)}</span>
        </li>
      ))}
    </ul>
  );
}

/** Under one answer, quiet: its own seal (a link once landed) and the payment decision of a turn that paid. */
function TurnSeals({ message }: { message: ChatMessage }) {
  const links = [
    message.seal?.status === 'sent' && message.seal.tx ? { href: stellarTx(message.seal.tx), label: c.turnSealed, key: 'seal' } : null,
    message.decision?.status === 'sent' && message.decision.tx ? { href: stellarTx(message.decision.tx), label: c.turnPaidSealed, key: 'decision' } : null,
  ].filter((x) => x !== null);
  const pending = message.seal?.status === 'pending' || message.decision?.status === 'pending';
  if (links.length === 0 && !pending) return null;
  return (
    <span className="mt-1.5 flex gap-3 text-[12px] text-fg-3" data-turn-seal="">
      {links.map((l) => (
        <a key={l.key} href={l.href} target="_blank" rel="noreferrer" className="underline-offset-2 hover:text-fg hover:underline">
          {l.label}
        </a>
      ))}
      {pending ? <span>{c.turnSealing}</span> : null}
    </span>
  );
}

/** One message. Memoised: a word arriving redraws the answer being written, never the conversation above it. */
const Message = memo(function Message({ m, writing }: { m: ChatMessage; writing: boolean }) {
  if (m.role === 'user') {
    return (
      <li data-role="user" className="chat-in flex justify-end">
        <p className="max-w-[min(85%,560px)] rounded-[18px] rounded-br-[6px] bg-[rgb(243_239_232/0.09)] px-4 py-2.5 text-[15.5px] leading-[1.55] break-words whitespace-pre-wrap text-fg">{m.content}</p>
      </li>
    );
  }
  const waiting = writing && m.content === '' && !m.tools?.some((t) => t.state === 'running');
  return (
    <li data-role="assistant" data-writing={writing ? '' : undefined} className="chat-in min-w-0">
      {m.tools?.length ? <ToolSteps tools={m.tools} /> : null}
      {waiting ? (
        <span data-chat-typing="" role="status" aria-label={c.sending} className="flex h-7 items-center">
          <SealLoader size={20} className="text-accent" />
        </span>
      ) : m.content ? (
        <div className="chat-answer max-w-[68ch] text-[15.5px] leading-[1.68] text-fg">
          <Markdown text={writing ? tidyPartial(m.content) : m.content} />
        </div>
      ) : null}
      {!writing ? <TurnSeals message={m} /> : null}
    </li>
  );
});

/** Where this chat stands on chain: its newest landed seal, or a word that it is sealed once it goes quiet. */
function ChatSeal({ session }: { session: ChatSessionInfo }) {
  return (
    <p className="mt-6 text-[12px] text-fg-3" data-chat-seal={session.sealed ? 'sealed' : 'soon'}>
      {session.sealed ? (
        <>
          {c.sealed(session.sealed.turns, session.turns)}{' '}
          <a className="underline underline-offset-2 hover:text-fg" href={stellarTx(session.sealed.tx)} target="_blank" rel="noreferrer">
            {c.sealLink}
          </a>
        </>
      ) : (
        c.sealSoon
      )}
    </p>
  );
}

function Empty({ seed, blocked, onAsk }: { seed: string; blocked: boolean; onAsk?: ((text: string) => void) | undefined }) {
  return (
    <div data-chat-empty="" className="chat-in flex flex-1 flex-col justify-center py-10">
      <Seal hash={seed} size={44} className="mb-5" />
      <p className="max-w-[28ch] font-display text-[19px] leading-[1.35] font-medium text-balance text-fg">{c.empty}</p>
      <ul className="mt-6 max-w-[480px] divide-y divide-line border-y border-line">
        {c.suggestions.map((q) => (
          <li key={q}>
            <button
              type="button"
              data-suggest=""
              disabled={blocked}
              onClick={() => onAsk?.(q)}
              className="group flex min-h-12 w-full items-center justify-between gap-3 text-left text-[15px] text-fg-2 outline-none hover:text-fg focus-visible:text-fg disabled:pointer-events-none disabled:opacity-40 motion-safe:transition-colors"
            >
              {q}
              <svg aria-hidden="true" viewBox="0 0 16 16" className="size-4 shrink-0 text-fg-3 group-hover:text-accent motion-safe:transition-transform motion-safe:group-hover:translate-x-0.5" strokeWidth="1.6" {...LINE}>
                <path d="M3 8h10M9 4l4 4-4 4" />
              </svg>
            </button>
          </li>
        ))}
      </ul>
    </div>
  );
}

export interface ChatViewProps {
  state: ChatState;
  paused: boolean;
  /** Seed of the agent's own seal. */
  seed?: string;
  draft?: string;
  onDraft?: (text: string) => void;
  onSend?: () => void;
  /** A suggested question was tapped: send it as it is. */
  onAsk?: (text: string) => void;
  onStop?: () => void;
  onRetry?: () => void;
  /** Paused: the button resumes the agent in place, and the chat opens once the server says it is running. */
  onResume?: () => void;
  resuming?: boolean;
  resumeFailed?: boolean;
  /** Paused by the platform until its first USDC set up its wallet: no Resume button, it starts on its own. */
  gettingReady?: boolean;
  /** Kept chats: the tab strip and its menus. Without them no strip is shown. */
  onNew?: () => void;
  onOpen?: (key: string) => void;
  onRename?: (key: string) => void;
  onArchive?: (key: string) => void;
  onUnarchive?: (key: string) => void;
  onDelete?: (key: string) => void;
  onSealEach?: (on: boolean) => void;
  onArchivedList?: () => void;
  /** The archive is on screen instead of a chat. */
  archiveOpen?: boolean;
  onArchiveClose?: () => void;
  /** A note outside any chat: an archive or rename that failed. */
  flash?: string | null;
  /** The chat's panel is the one showing (the other cockpit panels stay mounted beside it). */
  visible?: boolean;
}

/** The conversation as markup for a given state, so every state can be rendered and scanned without a browser. */
export function ChatView({ state, paused, seed = 'agentenact', draft = '', onDraft, onSend, onAsk, onStop, onRetry, onResume, resuming = false, resumeFailed = false, gettingReady = false, onNew, onOpen, onRename, onArchive, onUnarchive, onDelete, onSealEach, onArchivedList, archiveOpen = false, onArchiveClose, flash = null, visible = true }: ChatViewProps) {
  const thread = threadOf(state);
  const streaming = state.streaming !== null;
  const here = state.streaming === state.active;
  const elsewhere = streaming && !here;
  const blocked = paused || streaming;
  const loading = thread.loading === true || state.loading === true;
  const tabs = tabsOf(state);
  const tab = tabs.find((t) => t.key === state.active);
  const last = thread.messages.at(-1);
  const canRetry = !streaming && !paused && !!(last?.failed || last?.stopped);
  const area = useRef<HTMLTextAreaElement>(null);
  const composer = useRef<HTMLDivElement>(null);
  const end = useRef<HTMLDivElement>(null);
  const [away, setAway] = useState(false);
  const stick = useRef(true);

  // The field grows with what is typed, up to its cap, then scrolls.
  useEffect(() => {
    const el = area.current;
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = `${el.scrollHeight}px`;
  }, [draft]);

  // How far the newest line is below the top of the composer, which stays pinned to the screen's bottom edge.
  const overshoot = () => {
    const e = end.current;
    const box = composer.current;
    if (!e || !box || e.offsetParent === null) return null; // the chat's tab is hidden
    return e.getBoundingClientRect().bottom - box.getBoundingClientRect().top;
  };
  const follow = () => {
    const by = overshoot();
    // `instant`: the page has smooth scrolling on, which would trail behind the words.
    if (by !== null && by > 0) window.scrollBy({ top: by, behavior: 'instant' });
  };

  // The owner's own scrolling decides: up and away stops following, back down starts it again.
  useEffect(() => {
    const onScroll = () => {
      const by = overshoot();
      if (by === null) return;
      stick.current = by < 96;
      setAway(!stick.current);
    };
    window.addEventListener('scroll', onScroll, { passive: true });
    return () => window.removeEventListener('scroll', onScroll);
  }, []);

  const count = thread.messages.length;
  const words = last?.content.length ?? 0;
  const steps = last?.tools?.length ?? 0;
  // A new question always brings the chat back to the bottom; opening another chat starts at its bottom.
  useEffect(() => {
    stick.current = true;
    setAway(false);
    if (count > 0) follow();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [count, state.active, visible, archiveOpen]);
  useEffect(() => {
    if (stick.current) follow();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [words, steps, loading]);

  // Above the phone keyboard: the sticky bar's bottom edge follows the part of the page that is still visible.
  useEffect(() => {
    const vv = window.visualViewport;
    const box = composer.current;
    if (!vv || !box) return;
    const place = () => box.style.setProperty('--keyboard', `${Math.max(0, window.innerHeight - vv.height - vv.offsetTop)}px`);
    vv.addEventListener('resize', place);
    vv.addEventListener('scroll', place);
    return () => {
      vv.removeEventListener('resize', place);
      vv.removeEventListener('scroll', place);
    };
  }, [archiveOpen]);

  // The archive is short: bring its top back into view from wherever a long chat had the page.
  const root = useRef<HTMLElement>(null);
  useEffect(() => {
    if (!archiveOpen || !root.current) return;
    const by = root.current.getBoundingClientRect().top - STRIP_TOP;
    if (by < 0) window.scrollBy({ top: by, behavior: 'instant' });
  }, [archiveOpen]);

  const send = () => {
    if (!blocked) onSend?.();
    area.current?.focus();
  };

  return (
    <section ref={root} data-chat="" className="flex min-h-[calc(100dvh-96px)] flex-col lg:min-h-[calc(100dvh-112px)]">
      {onNew && onOpen ? (
        <ChatTabs
          tabs={tabs}
          active={state.active}
          disabled={state.loading === true}
          onNew={onNew}
          onOpen={onOpen}
          onRename={onRename ?? (() => undefined)}
          onArchive={onArchive ?? (() => undefined)}
          onUnarchive={onUnarchive ?? (() => undefined)}
          onDelete={onDelete ?? (() => undefined)}
          settings={onSealEach ? <ChatSettings sealEach={state.sealEach} onSealEach={onSealEach} onArchived={() => onArchivedList?.()} /> : null}
        />
      ) : null}
      {flash ? (
        <p role="alert" data-chat-flash="" className="mt-3 text-sm text-danger">
          {flash}
        </p>
      ) : null}
      {archiveOpen ? (
        <ArchivedList sessions={state.archived} onBack={() => onArchiveClose?.()} onOpen={(id) => onOpen?.(id)} onUnarchive={(id) => onUnarchive?.(id)} onDelete={(id) => onDelete?.(id)} />
      ) : (
        <>
          {loading ? (
            <p className="flex items-center gap-2 py-8 text-sm text-fg-2" data-chat-loading="">
              <SealLoader size={16} className="text-accent" />
              {c.loading}
            </p>
          ) : count === 0 ? (
            <Empty seed={seed} blocked={blocked} onAsk={onAsk} />
          ) : (
            <ul className="flex flex-col gap-6 pt-6" aria-live="polite" aria-busy={here} data-chat-messages="">
              {thread.messages.map((m, i) => (
                <Message key={i} m={m} writing={here && i === count - 1} />
              ))}
            </ul>
          )}
          {tab?.session && tab.session.turns > 0 && !loading && !here ? <ChatSeal session={tab.session} /> : null}
          {thread.note || canRetry || (paused && resumeFailed) ? (
            <div data-chat-note="" className="mt-3 flex flex-wrap items-center gap-x-3 gap-y-1 text-[14px]">
              {paused && resumeFailed ? (
                <p role="alert" className="text-danger">
                  {copy.agent.resumeFailed}
                </p>
              ) : thread.note ? (
                <p role="alert" className="text-danger">
                  {thread.note}
                </p>
              ) : last?.stopped ? (
                <p className="text-fg-3">{c.stopped}</p>
              ) : null}
              {canRetry ? (
                <button type="button" data-chat-retry="" onClick={onRetry} className="min-h-11 rounded-full font-medium text-accent-ink underline-offset-4 hover:underline sm:min-h-8">
                  {c.retry}
                </button>
              ) : null}
            </div>
          ) : null}
          <div ref={end} aria-hidden="true" className="h-3 flex-none" />
          <div className="flex-1" />
          {tab?.archived ? (
            <div ref={composer} className="chat-composer-bar sticky z-10 pt-4" data-chat-archived-note="">
              <div className="flex flex-wrap items-center justify-between gap-3 rounded-[20px] border border-line bg-[var(--raised)] px-4 py-3 text-[14px] text-fg-2">
                <span>{c.archivedNote}</span>
                <Button type="button" variant="quiet" onClick={() => onUnarchive?.(state.active)}>
                  {c.unarchive}
                </Button>
              </div>
            </div>
          ) : (
            <div ref={composer} className="chat-composer-bar sticky z-10 pt-4">
              {away && count > 0 ? (
                <button
                  type="button"
                  data-chat-jump=""
                  onClick={() => {
                    stick.current = true;
                    setAway(false);
                    follow();
                  }}
                  className="chat-pop absolute -top-8 left-1/2 inline-flex h-9 -translate-x-1/2 items-center gap-1.5 rounded-full border border-[var(--raised-line)] bg-[var(--raised)] px-3.5 text-[13px] font-medium whitespace-nowrap text-fg shadow-[0_12px_24px_-10px_rgb(0_0_0/0.7)] hover:bg-line"
                >
                  {c.jump}
                  <svg aria-hidden="true" viewBox="0 0 16 16" className="size-3.5" strokeWidth="1.6" {...LINE}>
                    <path d="M8 3v10M4 9l4 4 4-4" />
                  </svg>
                </button>
              ) : null}
              <form
                className="chat-composer flex items-end gap-2 rounded-[22px] border border-line bg-[var(--raised)] p-1.5 pl-4"
                onSubmit={(e) => {
                  e.preventDefault();
                  send();
                }}
              >
                <textarea
                  ref={area}
                  aria-label={c.label}
                  value={draft}
                  maxLength={CHAT_MESSAGE_MAX}
                  rows={1}
                  disabled={paused}
                  placeholder={gettingReady ? c.gettingReadyPlaceholder : paused ? c.pausedPlaceholder : copy.agent.chatPlaceholder}
                  onChange={(e) => onDraft?.(e.target.value)}
                  onKeyDown={(e) => {
                    if (enterSends({ key: e.key, shiftKey: e.shiftKey, isComposing: e.nativeEvent.isComposing }, window.matchMedia?.('(pointer: coarse)').matches ?? false)) {
                      e.preventDefault();
                      send();
                    }
                  }}
                  className="max-h-44 min-h-8 min-w-0 flex-1 resize-none self-center bg-transparent py-1 text-base leading-[1.5] text-fg outline-none placeholder:text-fg-3 disabled:cursor-not-allowed disabled:opacity-60"
                />
                {paused && gettingReady ? null : paused ? (
                  <Button type="button" disabled={resuming} data-chat-resume="" onClick={() => onResume?.()}>
                    {resuming ? (
                      <span className="inline-flex items-center gap-2">
                        <SealLoader size={14} />
                        {c.resuming}
                      </span>
                    ) : (
                      c.resume
                    )}
                  </Button>
                ) : here ? (
                  <button type="button" data-chat-stop="" aria-label={c.stop} title={c.stop} onClick={onStop} className="grid size-11 shrink-0 place-items-center rounded-full bg-fg text-bg hover:bg-fg-2">
                    <svg aria-hidden="true" viewBox="0 0 16 16" className="size-3.5" fill="currentColor">
                      <rect x="3" y="3" width="10" height="10" rx="2" />
                    </svg>
                  </button>
                ) : (
                  <button type="submit" data-send="" aria-label={c.send} title={c.send} disabled={blocked || draft.trim() === ''} className="grid size-11 shrink-0 place-items-center rounded-full bg-accent text-on-fill hover:bg-accent-deep disabled:bg-line disabled:text-fg-3">
                    <svg aria-hidden="true" viewBox="0 0 16 16" className="size-4" strokeWidth="1.8" {...LINE}>
                      <path d="M8 13V3M3.5 7.5L8 3l4.5 4.5" />
                    </svg>
                  </button>
                )}
              </form>
              {elsewhere ? (
                <p data-chat-elsewhere="" className="mt-1.5 px-1 text-[12.5px] text-fg-3">
                  {c.busyElsewhere}
                </p>
              ) : null}
            </div>
          )}
        </>
      )}
    </section>
  );
}

/**
 * The chat. Conversations are kept by the api (the owner's only), one tab each; the address's `chat=` says which is open.
 * Each turn goes from the browser straight to the api with the owner's own sign-in (so the stream is not held back by the
 * Next server), the question shows before anything is sent, and the answer is written in as it arrives, tool calls and all.
 * Leaving a tab keeps the answer going; leaving the page stops reading.
 */
export function Chat({
  agentId,
  paused: pausedOnServer,
  gettingReady = false,
  transport = browserChatTransport,
  resume = (id: string) => setPausedAction(id, false),
}: {
  agentId: string;
  paused: boolean;
  /** Paused by the platform until its first USDC set up its wallet (see ChatViewProps). */
  gettingReady?: boolean;
  transport?: ChatTransport;
  /** Resumes the agent; the page uses the server action, which also renders the header again. */
  resume?: (agentId: string) => Promise<{ ok: boolean }>;
}) {
  const [state, dispatch] = useReducer(chatReducer, initialChat);
  const stateRef = useRef(state);
  stateRef.current = state;
  // Resumed from here: the chat opens on the server's ok, without waiting for the page to be read again. A new answer from
  // the server (paused again from the header) wins.
  const [resumed, setResumed] = useState(false);
  const [resuming, setResuming] = useState(false);
  const [resumeFailed, setResumeFailed] = useState(false);
  useEffect(() => setResumed(false), [pausedOnServer]);
  const paused = pausedOnServer && !resumed;
  // One draft per chat: switching tabs never loses what was being typed.
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  const draft = drafts[state.active] ?? '';
  const setDraft = (text: string) => setDrafts((d) => ({ ...d, [stateRef.current.active]: text }));
  const [archiveOpen, setArchiveOpen] = useState(false);
  const [flash, setFlash] = useState<string | null>(null);
  const [renaming, setRenaming] = useState<string | null>(null);
  const [deleting, setDeleting] = useState<string | null>(null);
  const ctl = useMemo(() => createChatController({ agentId, transport, getState: () => stateRef.current, dispatch }), [agentId, transport]);
  const params = useSearchParams();
  const wanted = params?.get('chat') ?? null;
  const onChatTab = params?.get('tab') === 'chat';
  useEffect(() => {
    void ctl.load(wanted);
    return () => ctl.stop();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ctl]);
  // The address follows the open chat, and Back or a pasted link opens the chat it names. A link to the tab with no chat
  // named (the tab rail) keeps the one that was open.
  const loaded = useRef(false);
  useEffect(() => {
    if (wanted && wanted !== stateRef.current.active && loaded.current) void ctl.open(wanted);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [wanted]);
  useEffect(() => {
    if (state.loading === true) return;
    loaded.current = true;
    if (!onChatTab) return;
    const url = new URL(window.location.href);
    if (state.active === DRAFT) url.searchParams.delete('chat');
    else url.searchParams.set('chat', state.active);
    if (url.href !== window.location.href) window.history.replaceState(null, '', url);
  }, [state.active, state.loading, onChatTab]);
  const kept = transport.sessions !== undefined;
  const sessionOf = (id: string | null) => (id ? (state.sessions.find((x) => x.id === id) ?? state.archived?.find((x) => x.id === id) ?? null) : null);
  const attempt = (ok: Promise<boolean>) => {
    setFlash(null);
    void ok.then((done) => done || setFlash(c.archiveFailed));
  };
  return (
    <>
      <ChatView
        {...(kept
          ? {
              onNew: () => {
                setArchiveOpen(false);
                ctl.fresh();
              },
              onOpen: (key: string) => {
                setArchiveOpen(false);
                void ctl.open(key);
              },
              onRename: setRenaming,
              onArchive: (id: string) => attempt(ctl.archive(id)),
              onUnarchive: (id: string) => attempt(ctl.unarchive(id)),
              onDelete: (id: string) => {
                setDeleting(id);
                void ctl.refresh();
              },
              onSealEach: (on: boolean) => void ctl.sealEach(on),
              onArchivedList: () => {
                setArchiveOpen(true);
                void ctl.listArchived();
              },
              onArchiveClose: () => setArchiveOpen(false),
              archiveOpen,
              flash,
            }
          : {})}
        state={state}
        seed={agentId}
        visible={params ? onChatTab : true}
        paused={paused}
        gettingReady={gettingReady}
        draft={draft}
        onDraft={setDraft}
        resuming={resuming}
        resumeFailed={resumeFailed}
        onResume={() => {
          setResuming(true);
          setResumeFailed(false);
          void resume(agentId)
            .catch(() => ({ ok: false }))
            .then((r) => {
              setResuming(false);
              if (r.ok) setResumed(true);
              else setResumeFailed(true);
            });
        }}
        onAsk={(q) => {
          if (!paused && stateRef.current.streaming === null) void ctl.send(q);
        }}
        onStop={() => ctl.stopAnswer()}
        onRetry={() => void ctl.retry()}
        onSend={() => {
          const text = draft;
          if (text.trim() === '') return;
          setDraft('');
          void ctl.send(text);
        }}
      />
      {deleting !== null ? <DeleteChatDialog title={sessionOf(deleting)?.title ?? null} sealed={sessionOf(deleting)?.hasSeals === true} onClose={() => setDeleting(null)} onConfirm={() => ctl.remove(deleting)} /> : null}
      {renaming !== null ? <RenameChatDialog title={sessionOf(renaming)?.title ?? ''} onClose={() => setRenaming(null)} onSave={(t) => ctl.rename(renaming, t)} /> : null}
    </>
  );
}
