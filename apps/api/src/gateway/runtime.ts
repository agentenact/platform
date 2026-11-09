/**
 * Owner runtime routes (spec §3 gateway): spec save/approve (P3's stand-in for the P4 Builder), runs,
 * the webhook secret, and the streamed chat (plan D9, D10). Every route authenticates and touches only
 * the caller's agent. The chat stream is SSE; refusals happen before the stream starts, so they keep
 * their status and JSON body.
 */
import type { Profile } from '../account/profiles.js';
import { checkDraft, DraftView } from '../builder/draft-schema.js';
import { httpError } from '../errors.js';
import type { ChatMessage, OwnerRuns } from '../loop/owner.js';
import type { Runs } from '../runs/index.js';
import type { Specs } from '../specs/index.js';
import { parseSpec } from '../specs/schema.js';
import type { Route } from './app.js';
import { createChatLock, type ChatLock } from '../owner-mcp/chat-lock.js';
import { createRateLimiter } from './rate-limit.js';
import { CHAT_TITLE_MAX, type ChatSessions } from '../chat/sessions.js';

export interface RuntimeDeps {
  specs: Pick<Specs, 'saveDraft' | 'approve' | 'view' | 'discard'>;
  runs: Pick<Runs, 'recent' | 'getOwned'>;
  chat: Pick<OwnerRuns, 'openChat'>;
  webhookSecret: (agentId: string) => string | Promise<string>;
  killed: boolean;
  /** Shared with the owner MCP's message_agent, so the panel and a harness never talk to one agent at once. */
  chatLock?: ChatLock;
  /** Server-kept conversations. Without them the chat takes only the old browser-held `messages` body. */
  chatSessions?: ChatSessions;
  /** A stored chat turn paid someone: seal that decision now (seals/index.ts enqueueDecision). Never throws. */
  sealPaidTurn?: (agentId: string, t: { runId: string; status: string; input: string; output: string }) => Promise<void>;
  keepaliveMs?: number;
  now?: () => number;
}

export interface RouteHelpers {
  user(req: Request): Promise<Profile>;
  body<T>(req: Request): Promise<T>;
  ownAgent(userId: string, id: string): Promise<{ id: string; status: string; name: string }>;
  json(status: number, body: unknown, headers?: Record<string, string>): Response;
  cors: Record<string, string>;
}

export const KEEPALIVE_MS = 15_000;
export const CHAT_MAX_MESSAGES = 20;
/** Spec writes (save + approve) per account per hour; each save stores a version row of up to ~64 KB. */
export const SPEC_WRITES_PER_HOUR = 30;
export const BUILD_PROMPT_MAX = 4000;
/** Per message; 20 of them stay inside the gateway's 64 KB body cap. */
export const CHAT_MESSAGE_MAX = 3000;
const UUID = '[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}';
const isObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

/** 1–20 messages of {role: user|assistant, content: non-empty string}, ending with the user's turn. */
export function parseChatMessages(v: unknown): ChatMessage[] | null {
  if (!Array.isArray(v) || v.length === 0 || v.length > CHAT_MAX_MESSAGES) return null;
  const out: ChatMessage[] = [];
  for (const m of v) {
    if (!isObject(m) || (m.role !== 'user' && m.role !== 'assistant') || typeof m.content !== 'string' || m.content.length === 0 || m.content.length > CHAT_MESSAGE_MAX) return null;
    out.push({ role: m.role, content: m.content });
  }
  return out.at(-1)!.role === 'user' ? out : null;
}

export function runtimeRoutes(rt: RuntimeDeps, h: RouteHelpers): Route[] {
  const chatLock = rt.chatLock ?? createChatLock();
  const writes = createRateLimiter({ name: 'runtime.writes', limit: SPEC_WRITES_PER_HOUR, windowMs: 3_600_000, ...(rt.now ? { now: rt.now } : {}) });
  const limitWrites = async (userId: string) => {
    const wait = await writes.hit(userId);
    if (wait) throw Object.assign(httpError(429, 'rate_limited'), { retryAfter: wait });
  };
  const enc = new TextEncoder();
  const frame = (event: string, data: unknown) => `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;

  return [
    ['GET', new RegExp(`^/api/agents/(${UUID})/spec$`), async (r, m) => h.json(200, await rt.specs.view((await h.user(r)).id, m[1]!))],

    ['PUT', new RegExp(`^/api/agents/(${UUID})/spec$`), async (r, m) => {
      const p = await h.user(r);
      await limitWrites(p.id);
      const b = await h.body<{ spec?: unknown; buildPrompt?: unknown; view?: unknown }>(r);
      if (!isObject(b)) throw httpError(400, 'bad_request');
      const prompt = b.buildPrompt;
      if (prompt !== undefined && (typeof prompt !== 'string' || prompt.length > BUILD_PROMPT_MAX)) throw httpError(400, 'bad_request');
      const parsed = parseSpec(b.spec);
      if (!parsed.ok) return h.json(400, { error: 'bad_spec', problem: parsed.problem });
      let view: DraftView | undefined;
      if (b.view !== undefined && b.view !== null) {
        const v = DraftView.safeParse(b.view);
        const a = await h.ownAgent(p.id, m[1]!); // 404 for a foreign agent, before the view is looked at
        if (!v.success || checkDraft({ name: a.name, ...v.data, spec: parsed.spec })) return h.json(400, { error: 'bad_view' });
        view = v.data;
      }
      const version = await rt.specs.saveDraft(p.id, m[1]!, parsed.spec, prompt, view);
      return h.json(201, { version });
    }],

    ['POST', new RegExp(`^/api/agents/(${UUID})/spec/(\\d{1,6})/approve$`), async (r, m) => {
      const p = await h.user(r);
      await limitWrites(p.id);
      // Optional body { createdAt }: the draft the owner was shown. No body at all stays valid.
      const b = r.body ? await h.body<{ createdAt?: unknown }>(r) : {};
      if (!isObject(b)) throw httpError(400, 'bad_request');
      let createdAt: Date | undefined;
      if (b.createdAt !== undefined) {
        createdAt = typeof b.createdAt === 'string' && b.createdAt.length <= 64 ? new Date(b.createdAt) : undefined;
        if (!createdAt || Number.isNaN(createdAt.getTime())) throw httpError(400, 'bad_request');
      }
      await rt.specs.approve(p.id, m[1]!, Number(m[2]), createdAt);
      return h.json(204, null);
    }],

    // Throws away a pending, unapproved description. Never the active one (409 not_discardable); a foreign agent is 404.
    ['DELETE', new RegExp(`^/api/agents/(${UUID})/spec/(\\d{1,6})$`), async (r, m) => {
      const p = await h.user(r);
      await limitWrites(p.id);
      await rt.specs.discard(p.id, m[1]!, Number(m[2]));
      return h.json(204, null);
    }],

    // A foreign agent is 404 like every other owner route (the user-scoped query alone would answer an empty list).
    ['GET', new RegExp(`^/api/agents/(${UUID})/runs$`), async (r, m) => {
      const p = await h.user(r);
      await h.ownAgent(p.id, m[1]!);
      return h.json(200, { runs: await rt.runs.recent(p.id, m[1]!) });
    }],

    // One run for its owner. Unknown, foreign and a run of another agent are the same 404 (never 403).
    ['GET', new RegExp(`^/api/agents/(${UUID})/runs/(${UUID})$`), async (r, m) => {
      const run = await rt.runs.getOwned((await h.user(r)).id, m[1]!, m[2]!);
      if (!run) throw httpError(404, 'not_found');
      return h.json(200, { run });
    }],

    ['GET', new RegExp(`^/api/agents/(${UUID})/webhook-secret$`), async (r, m) => {
      const a = await h.ownAgent((await h.user(r)).id, m[1]!);
      // A secret: only to its owner, never cached by the browser or a proxy.
      return h.json(200, { secret: await rt.webhookSecret(a.id) }, { ...h.cors, 'cache-control': 'no-store' });
    }],

    // The owner's conversations with one agent, newest first; a new one; and one conversation's turns.
    ['GET', new RegExp(`^/api/chat/(${UUID})/sessions$`), async (r, m) => {
      const sessions = rt.chatSessions;
      if (!sessions) throw httpError(404, 'not_found');
      const p = await h.user(r);
      const a = await h.ownAgent(p.id, m[1]!);
      const archived = new URL(r.url).searchParams.get('archived') === '1';
      const [list, sealEach] = await Promise.all([sessions.list(p.id, a.id, { archived }), sessions.sealEach(p.id, a.id)]);
      return h.json(200, { sessions: list, sealEach }, { ...h.cors, 'cache-control': 'no-store' });
    }],

    // Seal every message on its own too (on by default; the owner can turn it off): a transaction per message shows when the owner talks.
    ['PUT', new RegExp(`^/api/chat/(${UUID})/seal-each$`), async (r, m) => {
      const sessions = rt.chatSessions;
      if (!sessions) throw httpError(404, 'not_found');
      const p = await h.user(r);
      const b = await h.body<{ on?: unknown }>(r);
      if (!isObject(b) || typeof b.on !== 'boolean') throw httpError(400, 'bad_request');
      await sessions.setSealEach(p.id, m[1]!, b.on);
      return h.json(200, { sealEach: b.on }, { ...h.cors, 'cache-control': 'no-store' });
    }],

    ['POST', new RegExp(`^/api/chat/(${UUID})/sessions$`), async (r, m) => {
      const sessions = rt.chatSessions;
      if (!sessions) throw httpError(404, 'not_found');
      const p = await h.user(r);
      const a = await h.ownAgent(p.id, m[1]!);
      return h.json(201, { session: await sessions.create(p.id, a.id) }, { ...h.cors, 'cache-control': 'no-store' });
    }],

    ['GET', new RegExp(`^/api/chat/(${UUID})/sessions/(${UUID})$`), async (r, m) => {
      const sessions = rt.chatSessions;
      if (!sessions) throw httpError(404, 'not_found');
      const p = await h.user(r);
      return h.json(200, { turns: await sessions.turns(p.id, m[1]!, m[2]!) }, { ...h.cors, 'cache-control': 'no-store' });
    }],

    // Rename a chat, or move it in or out of the archive.
    ['PATCH', new RegExp(`^/api/chat/(${UUID})/sessions/(${UUID})$`), async (r, m) => {
      const sessions = rt.chatSessions;
      if (!sessions) throw httpError(404, 'not_found');
      const p = await h.user(r);
      const b = await h.body<{ title?: unknown; archived?: unknown }>(r);
      if (!isObject(b) || (b.title === undefined && b.archived === undefined)) throw httpError(400, 'bad_request');
      if (b.archived !== undefined && typeof b.archived !== 'boolean') throw httpError(400, 'bad_request');
      const title = typeof b.title === 'string' ? b.title.replace(/\s+/g, ' ').trim() : '';
      if (b.title !== undefined && (title === '' || title.length > CHAT_TITLE_MAX)) throw httpError(400, 'bad_request');
      await sessions.update(p.id, m[1]!, m[2]!, { ...(b.title !== undefined ? { title } : {}), ...(b.archived !== undefined ? { archived: b.archived } : {}) });
      return h.json(200, { ok: true }, { ...h.cors, 'cache-control': 'no-store' });
    }],

    // Deletes a chat: gone when it has no seal; with a seal the words go and the seals stay (`kept`).
    ['DELETE', new RegExp(`^/api/chat/(${UUID})/sessions/(${UUID})$`), async (r, m) => {
      const sessions = rt.chatSessions;
      if (!sessions) throw httpError(404, 'not_found');
      const p = await h.user(r);
      return h.json(200, await sessions.remove(p.id, m[1]!, m[2]!), { ...h.cors, 'cache-control': 'no-store' });
    }],

    ['POST', new RegExp(`^/api/chat/(${UUID})$`), async (r, m) => {
      const p = await h.user(r);
      const agentId = m[1]!;
      if (rt.killed) throw httpError(503, 'killed');
      const b = await h.body<{ messages?: unknown; sessionId?: unknown; text?: unknown }>(r);
      // Two shapes: a server-kept conversation ({sessionId, text}) or the older browser-held history ({messages}).
      const kept = isObject(b) && typeof b.sessionId === 'string' && rt.chatSessions ? { sessionId: b.sessionId, text: b.text } : null;
      if (kept && (!new RegExp(`^${UUID}$`).test(kept.sessionId) || typeof kept.text !== 'string' || kept.text.trim() === '' || kept.text.length > CHAT_MESSAGE_MAX)) throw httpError(400, 'bad_messages');
      const question = kept ? (kept.text as string).trim() : '';
      const legacy = kept ? null : isObject(b) ? parseChatMessages(b.messages) : null;
      if (!kept && !legacy) throw httpError(400, 'bad_messages');
      // Ownership first (read-only): agent ids are public, so a non-owner must see 404, never "busy",
      // and must never be able to take the owner's lock.
      const session = await rt.chat.openChat(p.id, agentId);
      const messages = kept ? [...(await rt.chatSessions!.history(p.id, agentId, kept.sessionId)), { role: 'user' as const, content: question }] : legacy!;
      const release = await chatLock.take(agentId);
      if (!release) throw httpError(429, 'chat_busy');

      const abort = new AbortController();
      let ctl!: ReadableStreamDefaultController<Uint8Array>;
      let closed = false;
      const stream = new ReadableStream<Uint8Array>({
        start(c) {
          ctl = c;
          // Bytes at once: the headers go out and every proxy on the way starts passing the stream, before the model has said a word.
          c.enqueue(enc.encode(': open\n\n'));
        },
        cancel() {
          closed = true;
          abort.abort();
        },
      });
      const send = (chunk: string) => {
        if (closed) return;
        try {
          ctl.enqueue(enc.encode(chunk));
        } catch {
          closed = true;
        }
      };
      const keepalive = setInterval(() => send(': keepalive\n\n'), rt.keepaliveMs ?? KEEPALIVE_MS);
      const signal = AbortSignal.any([abort.signal, r.signal]);
      // The runner never throws, but a refused turn (agent revoked since open) does. Neither ever sends error text:
      // a failed run ends with a fixed frame, and the other frames carry only tool names, enum values and counters.
      void Promise.resolve()
        .then(() => session.run(messages, { onDelta: (t) => send(frame('delta', { text: t })), onTool: (e) => send(frame('tool', e)), signal }))
        .then(async (o) => {
          // Stored before the last frame, so a reload right after shows the turn. A turn the owner stopped is kept too.
          if (kept && rt.chatSessions) {
            const s = await rt.chatSessions.append(kept.sessionId, { question, answer: o.text, status: o.status, runId: o.runId });
            if (s.paid && rt.sealPaidTurn) await rt.sealPaidTurn(agentId, { runId: o.runId, status: o.status, input: question, output: o.finalText || o.text });
          }
          return o;
        })
        .then(
          (o) => send(o.status === 'error' ? frame('done', { runId: o.runId, status: 'error', stop: 'error' }) : frame('done', { runId: o.runId, status: o.status, stop: o.stop, usage: o.usage })),
          () => send(frame('done', { status: 'error', stop: 'error' })),
        )
        .finally(() => {
          clearInterval(keepalive);
          release();
          if (!closed) {
            closed = true;
            try {
              ctl.close();
            } catch {
              // already closed by the client
            }
          }
        });
      return new Response(stream, {
        status: 200,
        headers: { ...h.cors, 'content-type': 'text/event-stream', 'cache-control': 'no-cache, no-transform', 'x-accel-buffering': 'no' },
      });
    }],
  ];
}
