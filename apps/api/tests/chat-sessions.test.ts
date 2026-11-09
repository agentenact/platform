import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { createHash } from 'node:crypto';
import { Keypair } from '@stellar/stellar-sdk';
import { createChatSessions, CHAT_CONTEXT_TURNS } from '../src/chat/sessions.js';
import type { Db } from '../src/db/index.js';
import { chatBytes, chatTurnBytes, CHAT_TURN_VERSION, CHAT_VERSION, parseChat, parseChatTurn } from '../src/seals/format.js';
import { createSeals, CHAT_QUIET_S, type SealChain } from '../src/seals/index.js';
import { auditPath, leafHash, merkleRoot, verifyPath } from '../src/seals/merkle.js';
import { freshDb } from './support/db.js';
import { insertAgent, insertUser } from './support/fixtures.js';

const sha = (s: string) => createHash('sha256').update(s).digest('hex');
const SESSION = '7d0f3c4e-1b2a-4c3d-8e9f-0a1b2c3d4e5f';

describe('merkle tree (RFC 6962)', () => {
  it('matches the RFC test vectors for the empty tree and the empty leaf', () => {
    expect(merkleRoot([])).toBe('e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855');
    expect(leafHash('').toString('hex')).toBe('6e340b9cffb37a989ca544e6bb780a2c78901d3fb33738768511a30617afa01d');
    expect(merkleRoot([''])).toBe('6e340b9cffb37a989ca544e6bb780a2c78901d3fb33738768511a30617afa01d');
  });

  it('proves every leaf of every tree size up to 17 against its root, and nothing else', () => {
    for (let n = 1; n <= 17; n++) {
      const leaves = Array.from({ length: n }, (_, i) => `leaf ${i}`);
      const root = merkleRoot(leaves);
      for (let i = 0; i < n; i++) {
        const path = auditPath(leaves, i);
        expect(verifyPath(leaves[i]!, i, n, path, root)).toBe(true);
        expect(verifyPath(`${leaves[i]!}x`, i, n, path, root)).toBe(false);
        if (n > 1) expect(verifyPath(leaves[i]!, (i + 1) % n, n, path, root)).toBe(false);
      }
    }
  });

  it('changes the root when a turn is added, so a later seal covers more', () => {
    expect(merkleRoot(['a', 'b'])).not.toBe(merkleRoot(['a', 'b', 'c']));
  });
});

describe('chat seal documents', () => {
  const leaf = { v: CHAT_TURN_VERSION, session: SESSION, seq: 1, at: '2026-10-30T19:00:00.000Z', runId: null, status: 'done', input: sha('hi'), output: sha('hello'), steps: ['web_search'], salt: 'cd'.repeat(16) } as const;

  it('are canonical, parse back only when exact, and carry hashes, never words', () => {
    const b = chatTurnBytes({ ...leaf, steps: [...leaf.steps] });
    expect(parseChatTurn(b)).toEqual({ ...leaf, steps: [...leaf.steps] });
    expect(b).not.toContain('hello');
    const d = { v: CHAT_VERSION, network: 'stellar:testnet', agent: Keypair.random().publicKey(), agentId: null, at: '2026-10-30T19:10:00.000Z', session: SESSION, turns: 1, root: merkleRoot([b]) } as const;
    expect(parseChat(chatBytes(d))).toEqual(d);
    expect(parseChat(JSON.stringify(d, null, 1))).toBeNull();
  });

  it('refuse a bad salt, seq, step or root', () => {
    expect(() => chatTurnBytes({ ...leaf, steps: [], salt: 'x' })).toThrow();
    expect(() => chatTurnBytes({ ...leaf, steps: [], seq: 0 })).toThrow();
    expect(() => chatTurnBytes({ ...leaf, steps: ['Bad Tool'] })).toThrow();
    expect(() => chatBytes({ v: CHAT_VERSION, network: 'stellar:testnet', agent: Keypair.random().publicKey(), agentId: null, at: '2026-10-30T19:10:00.000Z', session: SESSION, turns: 1, root: 'nope' })).toThrow();
  });
});

describe.skipIf(!process.env.TEST_DATABASE_URL)('chat sessions and their seals (real Postgres)', () => {
  let sql: Db;
  let drop: () => Promise<void>;
  let userId: string;
  let otherUser: string;
  let agentId: string;
  const address = Keypair.random().publicKey();
  const chain: SealChain = { sponsorPublicKey: Keypair.random().publicKey(), getAccount: async () => { throw new Error('unused'); }, signSponsor: async () => '', submit: async () => ({ hash: '' }) };

  beforeAll(async () => {
    ({ sql, drop } = await freshDb());
    userId = await insertUser(sql);
    otherUser = await insertUser(sql);
    agentId = await insertAgent(sql, userId, { status: 'active', stellarAddress: address });
  });
  afterAll(async () => {
    await drop?.();
  });

  const run = async (tools: string[], paid = false) => {
    const [r] = (await sql`insert into app.runs (agent_id, mode, status, steps) values (${agentId}, 'chat', 'done', ${[{ tools }]}) returning id`) as { id: string }[];
    if (paid) {
      await sql`insert into app.spend (agent_id, run_id, url, payee, amount_usdc, tx_hash, decision)
                values (${agentId}, ${r!.id}, 'https://x.example/s', ${Keypair.random().publicKey()}, 0.01, ${sha(r!.id)}, 'settled')`;
    }
    return r!.id;
  };

  it('keeps turns per conversation, owner-only, with the newest turns as model history', async () => {
    const s = createChatSessions(sql);
    const a = await s.create(userId, agentId);
    expect(a.turns).toBe(0);
    // An empty conversation is reused, never piled up.
    expect((await s.create(userId, agentId)).id).toBe(a.id);
    for (let i = 1; i <= CHAT_CONTEXT_TURNS + 2; i++) {
      const r = await s.append(a.id, { question: `q${i}`, answer: `a${i}`, status: 'done', runId: await run(['web_search']) });
      expect(r).toEqual({ stored: true, paid: false });
    }
    await s.append(a.id, { question: 'stopped', answer: '', status: 'error', runId: null });
    const h = await s.history(userId, agentId, a.id);
    expect(h).toHaveLength(CHAT_CONTEXT_TURNS * 2);
    expect(h[0]).toEqual({ role: 'user', content: 'q3' });
    expect(h.at(-1)).toEqual({ role: 'assistant', content: `a${CHAT_CONTEXT_TURNS + 2}` });
    const turns = await s.turns(userId, agentId, a.id);
    expect(turns).toHaveLength(CHAT_CONTEXT_TURNS + 3);
    expect((await s.list(userId, agentId))[0]).toMatchObject({ id: a.id, title: 'q1', turns: CHAT_CONTEXT_TURNS + 3, sealed: null });
    // Someone else's conversation is a 404, and they see none in the list.
    await expect(s.turns(otherUser, agentId, a.id)).rejects.toMatchObject({ status: 404 });
    await expect(s.history(otherUser, agentId, a.id)).rejects.toMatchObject({ status: 404 });
    expect(await s.list(otherUser, agentId)).toEqual([]);
    // Each stored leaf is canonical and holds the run's tools, not the words.
    const [l] = (await sql`select leaf from app.chat_turns where session_id = ${a.id} and seq = 1`) as { leaf: string }[];
    expect(parseChatTurn(l!.leaf)).toMatchObject({ seq: 1, steps: ['web_search'], input: sha('q1'), output: sha('a1') });
    expect(l!.leaf).not.toContain('q1');
  });

  it('says when a turn paid, so its decision is sealed at once', async () => {
    const s = createChatSessions(sql);
    agentId = await insertAgent(sql, userId, { status: 'active', stellarAddress: Keypair.random().publicKey() }); // a fresh agent per case
    const b = await s.create(userId, agentId);
    expect(await s.append(b.id, { question: 'hire it', answer: 'done', status: 'done', runId: await run(['hire_agent'], true) })).toEqual({ stored: true, paid: true });
  });

  it('seals a conversation once it goes quiet or is left, and again over all turns when it goes on', async () => {
    let now = new Date();
    const seals = createSeals({ sql, chain, signSeal: async () => '', killed: () => false, log: () => undefined, now: () => now });
    const s = createChatSessions(sql);
    agentId = await insertAgent(sql, userId, { status: 'active', stellarAddress: Keypair.random().publicKey() });
    await sql`update app.chat_sessions set sealed_turns = turns, seal_due = false`; // the cases above are not this one's
    const c = await s.create(userId, agentId);
    await s.append(c.id, { question: 'one', answer: '1', status: 'done', runId: null });
    await s.append(c.id, { question: 'two', answer: '2', status: 'done', runId: null });
    expect(await seals.sweepChats()).toBe(0); // still talking
    // The owner opens a new conversation: the old one is sealed without waiting.
    await s.create(userId, agentId);
    expect(await seals.sweepChats()).toBe(1);
    expect(await seals.sweepChats()).toBe(0);
    const [row] = (await sql`select document, digest, turns, session_id from app.check_seals where kind = 'chat'`) as { document: string; digest: string; turns: number; session_id: string }[];
    const leaves = ((await sql`select leaf from app.chat_turns where session_id = ${c.id} order by seq`) as { leaf: string }[]).map((x) => x.leaf);
    expect(row).toMatchObject({ turns: 2, session_id: c.id, digest: sha(row!.document) });
    expect(parseChat(row!.document)).toMatchObject({ session: c.id, turns: 2, root: merkleRoot(leaves) });
    // The conversation goes on, then goes quiet: a second seal over all three turns.
    await s.append(c.id, { question: 'three', answer: '3', status: 'done', runId: null });
    expect(await seals.sweepChats()).toBe(0);
    await sql`update app.chat_sessions set updated_at = now() - make_interval(secs => ${CHAT_QUIET_S + 1}) where id = ${c.id}`;
    expect(await seals.sweepChats()).toBe(1);
    const all = (await sql`select turns from app.check_seals where session_id = ${c.id} order by turns`) as { turns: number }[];
    expect(all.map((x) => x.turns)).toEqual([2, 3]);
    // The worker lands it like any other seal: the day download carries it with its conversation.
    const day = await seals.day(agentId, now.toISOString().slice(0, 10));
    expect(day.filter((x) => x.kind === 'chat').map((x) => x.turns)).toEqual([2, 3]);
    now = new Date();
  });

  it('seals every message on its own by default, with the leaf as the document, until the owner turns it off', async () => {
    agentId = await insertAgent(sql, userId, { status: 'active', stellarAddress: Keypair.random().publicKey() });
    const s = createChatSessions(sql, { seals: true });
    expect(await s.sealEach(userId, agentId)).toBe(true);
    await expect(s.sealEach(otherUser, agentId)).rejects.toMatchObject({ status: 404 });
    await expect(s.setSealEach(otherUser, agentId, false)).rejects.toMatchObject({ status: 404 });
    const c = await s.create(userId, agentId);
    await s.append(c.id, { question: 'one', answer: '1', status: 'done', runId: null });
    const rows = (await sql`select kind, turns, document, digest from app.check_seals where session_id = ${c.id}`) as { kind: string; turns: number; document: string; digest: string }[];
    const [leaf] = (await sql`select leaf from app.chat_turns where session_id = ${c.id} and seq = 1`) as { leaf: string }[];
    expect(rows).toEqual([{ kind: 'chat_turn', turns: 1, document: leaf!.leaf, digest: sha(leaf!.leaf) }]);
    // The turn reads back with its own seal, and its transaction once the worker has landed it.
    expect((await s.turns(userId, agentId, c.id))[0]!.seal).toEqual({ status: 'pending', tx: null });
    await sql`update app.check_seals set status = 'sent', tx_hash = ${sha('tx')}, sent_at = now() where session_id = ${c.id}`;
    expect((await s.turns(userId, agentId, c.id))[0]).toMatchObject({ seal: { status: 'sent', tx: sha('tx') }, decision: null });
    await s.setSealEach(userId, agentId, false);
    await s.append(c.id, { question: 'two', answer: '2', status: 'done', runId: null });
    expect(((await sql`select 1 from app.check_seals where session_id = ${c.id}`) as unknown[]).length).toBe(1);
    // Without CHECK_SEALS nothing is queued per message.
    await s.setSealEach(userId, agentId, true);
    await createChatSessions(sql).append(c.id, { question: 'three', answer: '3', status: 'done', runId: null });
    expect(((await sql`select 1 from app.check_seals where session_id = ${c.id}`) as unknown[]).length).toBe(1);
  });

  describe('archive and delete', () => {
    const words = async (id: string) => (await sql`select question, answer, leaf from app.chat_turns where session_id = ${id} order by seq`) as { question: string; answer: string; leaf: string }[];
    const sealRows = async (id: string) => (await sql`select kind, turns, document, digest, status from app.check_seals where session_id = ${id} order by kind, turns`) as { kind: string; turns: number; document: string; digest: string; status: string }[];
    const fresh = async () => {
      agentId = await insertAgent(sql, userId, { status: 'active', stellarAddress: Keypair.random().publicKey() });
      return agentId;
    };

    it('an archived chat leaves the tabs and keeps its words; it is not reused as a new chat', async () => {
      const a = await fresh();
      const s = createChatSessions(sql);
      const c = await s.create(userId, a);
      await s.append(c.id, { question: 'one', answer: '1', status: 'done', runId: null });
      await s.update(userId, a, c.id, { archived: true });
      expect(await s.list(userId, a)).toEqual([]);
      expect((await s.list(userId, a, { archived: true })).map((x) => x.id)).toEqual([c.id]);
      expect((await s.turns(userId, a, c.id))[0]!.question).toBe('one');
      await s.update(userId, a, c.id, { archived: false, title: 'Named' });
      expect((await s.list(userId, a))[0]).toMatchObject({ id: c.id, title: 'Named', hasSeals: false });
      const empty = await s.create(userId, a);
      await s.update(userId, a, empty.id, { archived: true });
      expect((await s.create(userId, a)).id).not.toBe(empty.id);
      await expect(s.update(otherUser, a, c.id, { archived: true })).rejects.toMatchObject({ status: 404 });
    });

    it('a chat with no seal is removed outright, turns and all', async () => {
      const a = await fresh();
      const s = createChatSessions(sql);
      const c = await s.create(userId, a);
      await s.append(c.id, { question: 'one', answer: '1', status: 'done', runId: null });
      await expect(s.remove(otherUser, a, c.id)).rejects.toMatchObject({ status: 404 });
      expect(await s.remove(userId, a, c.id)).toEqual({ kept: false });
      expect(await words(c.id)).toEqual([]);
      expect(((await sql`select 1 from app.chat_sessions where id = ${c.id}`) as unknown[]).length).toBe(0);
    });

    it('a sealed chat loses its words and keeps its row, leaves and seals, and the leaves still prove the seals', async () => {
      const a = await fresh();
      const s = createChatSessions(sql, { seals: true });
      const c = await s.create(userId, a);
      await s.append(c.id, { question: 'one', answer: '1', status: 'done', runId: null });
      await s.append(c.id, { question: 'two', answer: '2', status: 'done', runId: null });
      expect((await s.list(userId, a))[0]!.hasSeals).toBe(true);
      const before = await words(c.id);
      const seals = await sealRows(c.id);
      expect(await s.remove(userId, a, c.id)).toEqual({ kept: true });
      // Words gone, proof intact.
      const after = await words(c.id);
      expect(after.map((x) => [x.question, x.answer])).toEqual([['', ''], ['', '']]);
      expect(after.map((x) => x.leaf)).toEqual(before.map((x) => x.leaf));
      expect(await sealRows(c.id)).toEqual(seals);
      expect(parseChatTurn(after[0]!.leaf)).toMatchObject({ input: sha('one'), output: sha('1') });
      const [row] = (await sql`select title, deleted_at from app.chat_sessions where id = ${c.id}`) as { title: string | null; deleted_at: Date | null }[];
      expect(row!.title).toBeNull();
      expect(row!.deleted_at).not.toBeNull();
      // Hidden everywhere the owner can look, and it takes nothing new.
      expect(await s.list(userId, a)).toEqual([]);
      expect(await s.list(userId, a, { archived: true })).toEqual([]);
      await expect(s.turns(userId, a, c.id)).rejects.toMatchObject({ status: 404 });
      await expect(s.history(userId, a, c.id)).rejects.toMatchObject({ status: 404 });
      await expect(s.update(userId, a, c.id, { archived: true })).rejects.toMatchObject({ status: 404 });
      await expect(s.remove(userId, a, c.id)).rejects.toMatchObject({ status: 404 });
      expect(await s.append(c.id, { question: 'late', answer: 'words', status: 'done', runId: null })).toEqual({ stored: false, paid: false });
      expect((await words(c.id)).length).toBe(2);
    });

    it('turns not yet under a root are still sealed after the delete, from the leaves alone', async () => {
      const a = await fresh();
      await sql`update app.chat_sessions set sealed_turns = turns, seal_due = false`; // the cases above are not this one's
      const seals = createSeals({ sql, chain, signSeal: async () => '', killed: () => false, log: () => undefined });
      const s = createChatSessions(sql, { seals: true });
      const c = await s.create(userId, a);
      await s.append(c.id, { question: 'one', answer: '1', status: 'done', runId: null });
      const leaves = (await words(c.id)).map((x) => x.leaf);
      await s.remove(userId, a, c.id);
      expect(await seals.sweepChats()).toBe(1);
      const root = (await sealRows(c.id)).find((x) => x.kind === 'chat');
      expect(parseChat(root!.document)).toMatchObject({ session: c.id, turns: 1, root: merkleRoot(leaves) });
    });

    it('a paid turn counts as sealed: its decision seal is keyed by run, and the leaf must stay with it', async () => {
      const a = await fresh();
      const s = createChatSessions(sql);
      const c = await s.create(userId, a);
      const runId = await run(['hire_agent'], true);
      await s.append(c.id, { question: 'hire it', answer: 'done', status: 'done', runId });
      expect((await s.list(userId, a))[0]!.hasSeals).toBe(false);
      await sql`insert into app.check_seals (agent_id, kind, run_id, check_at, document, digest) values (${a}, 'decision', ${runId}, now(), 'd', ${sha(`d${runId}`)})`;
      expect((await s.list(userId, a))[0]!.hasSeals).toBe(true);
      expect(await s.remove(userId, a, c.id)).toEqual({ kept: true });
      expect((await words(c.id))[0]!.answer).toBe('');
    });

    it('reads back the tools a turn called, from its leaf', async () => {
      const a = await fresh();
      const s = createChatSessions(sql);
      const c = await s.create(userId, a);
      await s.append(c.id, { question: 'q', answer: 'a', status: 'done', runId: await run(['web_search', 'web_read']) });
      expect((await s.turns(userId, a, c.id))[0]!.tools).toEqual(['web_search', 'web_read']);
    });
  });
});
