/**
 * Owner chat conversations (Kerem, 2026-10-30): kept on the server, so a conversation survives a reload, the owner can
 * start a new one, and its turns can be sealed. Text is the owner's only, like memory: every read and write is keyed
 * by the owner's user id and the agent, and a foreign conversation is the same 404 as a missing one.
 *
 * Each stored turn carries its canonical `ae.chat-turn/1` leaf (seals/format.ts). The seal worker (seals/index.ts)
 * puts the Merkle root of a conversation's leaves on chain once the conversation goes quiet or the owner leaves it.
 */
import { randomBytes } from 'node:crypto';
import type { Db } from '../db/index.js';
import { httpError } from '../errors.js';
import { CHAT_TURN_VERSION, DECISION_MAX_STEPS, chatTurnBytes, parseChatTurn } from '../seals/format.js';

/** Turns handed to the model: the newest 10 (20 messages), as the browser used to send. */
export const CHAT_CONTEXT_TURNS = 10;
export const CHAT_LIST_LIMIT = 30;
export const CHAT_TITLE_MAX = 80;
export const CHAT_ANSWER_MAX = 64_000;

export interface ChatSessionRow {
  id: string;
  title: string | null;
  turns: number;
  createdAt: string;
  updatedAt: string;
  /** How many turns are covered by a seal that landed on chain, and the newest such seal's transaction. */
  sealed: { turns: number; tx: string } | null;
  /** Any seal of this chat, pending or landed, its own or a paid turn's: deleting it keeps those and removes the words. */
  hasSeals: boolean;
}

export interface ChatTurnRow {
  seq: number;
  at: string;
  question: string;
  answer: string;
  status: string;
  /** This turn's own seal (each message sealed), and the decision seal of a turn that paid: tx once landed. */
  seal: { status: 'pending' | 'sent' | 'failed'; tx: string | null } | null;
  decision: { status: 'pending' | 'sent' | 'failed'; tx: string | null } | null;
  /** The tools this turn called, by name, from its leaf. */
  tools: string[];
}

export interface ChatSessions {
  /** The owner's open chats, or with `archived` the ones put away. A deleted chat is in neither. */
  list(userId: string, agentId: string, o?: { archived?: boolean }): Promise<ChatSessionRow[]>;
  /** Whether every message of this agent's chats is also sealed on its own (on by default). */
  sealEach(userId: string, agentId: string): Promise<boolean>;
  setSealEach(userId: string, agentId: string, on: boolean): Promise<void>;
  /** A new, empty conversation. The owner's other conversations with this agent are marked for sealing now. */
  create(userId: string, agentId: string): Promise<ChatSessionRow>;
  turns(userId: string, agentId: string, sessionId: string): Promise<ChatTurnRow[]>;
  /** The newest finished turns as model messages, oldest first. Throws 404 for a foreign or missing conversation. */
  history(userId: string, agentId: string, sessionId: string): Promise<{ role: 'user' | 'assistant'; content: string }[]>;
  /** Renames a chat and/or moves it in or out of the archive. Throws 404 for a foreign, missing or deleted conversation. */
  update(userId: string, agentId: string, sessionId: string, c: { title?: string; archived?: boolean }): Promise<void>;
  /**
   * Deletes a chat. With no seal it is removed outright. With any seal the words go and the session row, the leaves and the
   * seals stay (`kept: true`), and turns not yet under a root are still sealed by the worker (it reads only leaves).
   */
  remove(userId: string, agentId: string, sessionId: string): Promise<{ kept: boolean }>;
  /**
   * Stores one finished turn with its leaf; the tools it called come from its run. Returns whether the run paid anyone
   * (a settled spend), so the caller can seal that decision at once. Never throws: a turn the owner already read must
   * not fail on storage.
   */
  append(sessionId: string, t: { question: string; answer: string; status: string; runId: string | null }): Promise<{ stored: boolean; paid: boolean }>;
}

const sha256 = (s: string) => new Bun.CryptoHasher('sha256').update(s).digest('hex');

export function createChatSessions(
  sql: Db,
  o: {
    now?: () => Date;
    salt?: () => string;
    log?: (e: Record<string, unknown>) => void;
    /** Queue a per-message seal for agents that ask for one (CHECK_SEALS); off, nothing per message is queued. */
    seals?: boolean;
  } = {},
): ChatSessions {
  const now = o.now ?? (() => new Date());
  const salt = o.salt ?? (() => randomBytes(16).toString('hex'));
  const log = o.log ?? (() => undefined);

  async function own(userId: string, agentId: string, sessionId: string): Promise<void> {
    const rows = (await sql`select 1 from app.chat_sessions where id = ${sessionId} and agent_id = ${agentId} and user_id = ${userId} and deleted_at is null`) as unknown[];
    if (rows.length === 0) throw httpError(404, 'not_found');
  }

  return {
    async sealEach(userId, agentId) {
      const rows = (await sql`select chat_seal_each from app.agents where id = ${agentId} and user_id = ${userId}`) as { chat_seal_each: boolean }[];
      if (!rows[0]) throw httpError(404, 'not_found');
      return rows[0].chat_seal_each;
    },

    async setSealEach(userId, agentId, on) {
      const rows = (await sql`update app.agents set chat_seal_each = ${on} where id = ${agentId} and user_id = ${userId} returning id`) as unknown[];
      if (rows.length === 0) throw httpError(404, 'not_found');
    },

    async list(userId, agentId, o = {}) {
      const archived = o.archived === true;
      const rows = (await sql`select s.id, s.title, s.turns, s.created_at, s.updated_at, c.turns as sealed_turns, c.tx_hash,
                                exists (select 1 from app.check_seals x where x.session_id = s.id)
                                or exists (select 1 from app.chat_turns t join app.check_seals d on d.kind = 'decision' and d.run_id = t.run_id where t.session_id = s.id) as has_seals
                              from app.chat_sessions s
                              left join lateral (select turns, tx_hash from app.check_seals
                                                 where session_id = s.id and kind = 'chat' and status = 'sent' order by turns desc limit 1) c on true
                              where s.agent_id = ${agentId} and s.user_id = ${userId} and s.deleted_at is null and (s.archived_at is not null) = ${archived}
                              order by s.updated_at desc limit ${CHAT_LIST_LIMIT}`) as {
        id: string; title: string | null; turns: number; created_at: Date; updated_at: Date; sealed_turns: number | null; tx_hash: string | null; has_seals: boolean;
      }[];
      return rows.map((r) => ({
        id: r.id,
        title: r.title,
        turns: r.turns,
        createdAt: r.created_at.toISOString(),
        updatedAt: r.updated_at.toISOString(),
        sealed: r.sealed_turns !== null && r.tx_hash ? { turns: r.sealed_turns, tx: r.tx_hash } : null,
        hasSeals: r.has_seals,
      }));
    },

    async create(userId, agentId) {
      const [row] = (await sql.begin(async (tx) => {
        await tx`update app.chat_sessions set seal_due = true where agent_id = ${agentId} and user_id = ${userId} and turns > sealed_turns`;
        // An empty conversation is reused rather than piling up blank ones.
        const empty = (await tx`select id, created_at, updated_at from app.chat_sessions
                                where agent_id = ${agentId} and user_id = ${userId} and turns = 0 and deleted_at is null and archived_at is null order by created_at desc limit 1`) as { id: string; created_at: Date; updated_at: Date }[];
        if (empty[0]) return empty;
        return tx`insert into app.chat_sessions (agent_id, user_id) values (${agentId}, ${userId}) returning id, created_at, updated_at`;
      })) as { id: string; created_at: Date; updated_at: Date }[];
      return { id: row!.id, title: null, turns: 0, createdAt: row!.created_at.toISOString(), updatedAt: row!.updated_at.toISOString(), sealed: null, hasSeals: false };
    },

    async turns(userId, agentId, sessionId) {
      await own(userId, agentId, sessionId);
      const rows = (await sql`select t.seq, t.at, t.question, t.answer, t.status, t.leaf, e.status as seal_status, e.tx_hash as seal_tx, d.status as decision_status, d.tx_hash as decision_tx
                              from app.chat_turns t
                              left join app.check_seals e on e.kind = 'chat_turn' and e.session_id = t.session_id and e.turns = t.seq
                              left join app.check_seals d on d.kind = 'decision' and t.run_id is not null and d.run_id = t.run_id
                              where t.session_id = ${sessionId} order by t.seq`) as {
        seq: number; at: Date; question: string; answer: string; status: string; leaf: string;
        seal_status: 'pending' | 'sent' | 'failed' | null; seal_tx: string | null; decision_status: 'pending' | 'sent' | 'failed' | null; decision_tx: string | null;
      }[];
      return rows.map((r) => ({
        seq: r.seq, at: r.at.toISOString(), question: r.question, answer: r.answer, status: r.status,
        seal: r.seal_status ? { status: r.seal_status, tx: r.seal_tx } : null,
        decision: r.decision_status ? { status: r.decision_status, tx: r.decision_tx } : null,
        tools: parseChatTurn(r.leaf)?.steps ?? [],
      }));
    },

    async history(userId, agentId, sessionId) {
      await own(userId, agentId, sessionId);
      const rows = (await sql`select question, answer from app.chat_turns
                              where session_id = ${sessionId} and answer <> '' and status in ('done', 'budget')
                              order by seq desc limit ${CHAT_CONTEXT_TURNS}`) as { question: string; answer: string }[];
      return rows.reverse().flatMap((r) => [
        { role: 'user' as const, content: r.question },
        { role: 'assistant' as const, content: r.answer },
      ]);
    },

    async update(userId, agentId, sessionId, c) {
      const title = c.title ?? null;
      const archived = c.archived ?? null;
      const rows = (await sql`update app.chat_sessions
                              set title = coalesce(${title}, title),
                                  archived_at = case when ${archived}::boolean is null then archived_at when ${archived}::boolean then coalesce(archived_at, now()) end
                              where id = ${sessionId} and agent_id = ${agentId} and user_id = ${userId} and deleted_at is null returning id`) as unknown[];
      if (rows.length === 0) throw httpError(404, 'not_found');
    },

    async remove(userId, agentId, sessionId) {
      return sql.begin(async (tx) => {
        // Any seal counts, a paid turn's too (a decision seal is keyed by its run, not by the chat).
        // The row lock serialises this against the seal worker and a turn being stored: a seal's foreign key waits for it.
        const rows = (await tx`select s.id, exists (select 1 from app.check_seals x where x.session_id = s.id)
                                 or exists (select 1 from app.chat_turns t join app.check_seals d on d.kind = 'decision' and d.run_id = t.run_id where t.session_id = s.id) as has_seals
                               from app.chat_sessions s where s.id = ${sessionId} and s.agent_id = ${agentId} and s.user_id = ${userId} and s.deleted_at is null
                               for update of s`) as { has_seals: boolean }[];
        if (!rows[0]) throw httpError(404, 'not_found');
        if (!rows[0].has_seals) {
          await tx`delete from app.chat_sessions where id = ${sessionId}`; // its turns go with it (on delete cascade)
          return { kept: false };
        }
        await tx`update app.chat_turns set question = '', answer = '' where session_id = ${sessionId}`;
        await tx`update app.chat_sessions set deleted_at = now(), title = null, seal_due = turns > sealed_turns where id = ${sessionId}`;
        return { kept: true };
      });
    },

    async append(sessionId, t) {
      try {
        const answer = t.answer.slice(0, CHAT_ANSWER_MAX);
        let steps: string[] = [];
        let paid = false;
        if (t.runId) {
          const [run] = (await sql`select steps, exists (select 1 from app.spend p where p.run_id = r.id and p.decision = 'settled') as paid
                                   from app.runs r where r.id = ${t.runId}`) as { steps: { tools?: unknown }[]; paid: boolean }[];
          steps = (Array.isArray(run?.steps) ? run.steps : [])
            .flatMap((x) => (Array.isArray(x?.tools) ? x.tools : []))
            .filter((x): x is string => typeof x === 'string' && /^[a-z0-9_]{1,64}$/.test(x))
            .slice(0, DECISION_MAX_STEPS);
          paid = run?.paid === true;
        }
        const at = now();
        const stored = await sql.begin(async (tx) => {
          // The chat lock already serialises an agent's turns; the row lock makes the seq safe without it too.
          const [s] = (await tx`update app.chat_sessions set turns = turns + 1, updated_at = ${at}, seal_due = false,
                                  title = coalesce(title, ${t.question.replace(/\s+/g, ' ').trim().slice(0, CHAT_TITLE_MAX)})
                                where id = ${sessionId} and deleted_at is null returning turns, agent_id,
                                  (select a.chat_seal_each and a.status <> 'revoked' from app.agents a where a.id = app.chat_sessions.agent_id) as seal_each`) as { turns: number; agent_id: string; seal_each: boolean }[];
          if (!s) return false;
          const leaf = chatTurnBytes({
            v: CHAT_TURN_VERSION,
            session: sessionId,
            seq: s.turns,
            at: at.toISOString(),
            runId: t.runId,
            status: t.status,
            input: sha256(t.question),
            output: answer.trim() ? sha256(answer) : null,
            steps,
            salt: salt(),
          });
          await tx`insert into app.chat_turns (session_id, seq, at, run_id, status, question, answer, leaf)
                   values (${sessionId}, ${s.turns}, ${at}, ${t.runId}, ${t.status}, ${t.question}, ${answer}, ${leaf})`;
          // Sealed on its own as well: the leaf is the document, so the same bytes prove it here and inside the root.
          if (o.seals && s.seal_each) {
            await tx`insert into app.check_seals (agent_id, kind, session_id, turns, check_at, document, digest)
                     values (${s.agent_id}, 'chat_turn', ${sessionId}, ${s.turns}, ${at}, ${leaf}, ${sha256(leaf)}) on conflict do nothing`;
          }
          return true;
        });
        return { stored, paid };
      } catch {
        log({ event: 'chat_turn_store_failed' });
        return { stored: false, paid: false };
      }
    },
  };
}
