import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import type { AuthVerifier } from '../src/account/auth.js';
import { xlmDrop } from '../src/builder/examples.js';
import type { Db } from '../src/db/index.js';
import { createApp, type AppDeps } from '../src/gateway/app.js';
import type { RuntimeDeps } from '../src/gateway/runtime.js';
import { httpError } from '../src/errors.js';
import { createRunner } from '../src/loop/index.js';
import { createOwnerRuns, type ChatSession } from '../src/loop/owner.js';
import { createPolicy } from '../src/policy/index.js';
import { createMemory } from '../src/runs/memory.js';
import { SPEC_WRITES_PER_HOUR } from '../src/gateway/runtime.js';
import { createRuns, emptyUsage } from '../src/runs/index.js';
import { createSpecs } from '../src/specs/index.js';
import { createChatSessions } from '../src/chat/sessions.js';
import { freshDb } from './support/db.js';
import { scriptedModel } from './support/models.js';
import { activeAgent, minimalSpec } from './support/specs.js';

const ORIGIN = 'https://app.agentenact.io';
const API = 'https://api.agentenact.io';

describe('gateway runtime routes', () => {
  let sql: Db;
  let drop: () => Promise<void>;
  let base: Omit<AppDeps, 'runtime'>;
  let chatOpen: (userId: string, agentId: string) => Promise<ChatSession>;

  beforeAll(async () => {
    ({ sql, drop } = await freshDb());
    const verify: AuthVerifier = async (t) => (t.startsWith('tok:') ? { id: t.slice(4), email: `${t.slice(4)}@example.com` } : null);
    base = { sql, verify, passkey: {} as never, signRequests: {} as never, provisioner: {} as never, appOrigin: ORIGIN };
  });
  afterAll(() => drop());

  function app(over: Partial<RuntimeDeps> = {}) {
    const runtime: RuntimeDeps = {
      specs: createSpecs(sql),
      runs: createRuns(sql),
      chat: { openChat: (u, a) => chatOpen(u, a) },
      webhookSecret: (id) => `secret-of-${id}`,
      killed: false,
      ...over,
    };
    return createApp({ ...base, runtime });
  }
  const call = async (handler: ReturnType<typeof app>, method: string, path: string, userId?: string, body?: unknown) =>
    handler(
      new Request(`${API}${path}`, {
        method,
        headers: { origin: ORIGIN, ...(userId ? { authorization: `Bearer tok:${userId}` } : {}), ...(body === undefined ? {} : { 'content-type': 'application/json' }) },
        body: body === undefined ? undefined : typeof body === 'string' ? body : JSON.stringify(body),
      }),
    );

  it('saves a draft, refuses a bad spec, approves, and shows the active version', async () => {
    const a = await activeAgent(sql);
    const h = app();
    const saved = await call(h, 'PUT', `/api/agents/${a.agentId}/spec`, a.userId, { spec: minimalSpec(), buildPrompt: 'watch xlm' });
    expect([saved.status, await saved.json()]).toEqual([201, { version: 1 }]);
    expect(saved.headers.get('access-control-allow-origin')).toBe(ORIGIN);
    const bad = await call(h, 'PUT', `/api/agents/${a.agentId}/spec`, a.userId, { spec: { persona: 'p' } });
    expect([bad.status, await bad.json()]).toEqual([400, { error: 'bad_spec', problem: 'system_prompt: Invalid input: expected string, received undefined' }]);
    expect((await call(h, 'POST', `/api/agents/${a.agentId}/spec/1/approve`, a.userId)).status).toBe(204);
    const view = await (await call(h, 'GET', `/api/agents/${a.agentId}/spec`, a.userId)).json();
    expect(view).toMatchObject({ active: { version: 1, status: 'approved' }, draft: null });
    expect((await call(h, 'POST', `/api/agents/${a.agentId}/spec/9/approve`, a.userId)).status).toBe(404);
  });

  it('approve binds to the draft the owner saw: createdAt must match, a replaced draft is 409 version_changed, no body still works', async () => {
    const a = await activeAgent(sql);
    const h = app();
    await call(h, 'PUT', `/api/agents/${a.agentId}/spec`, a.userId, { spec: minimalSpec() });
    await call(h, 'POST', `/api/agents/${a.agentId}/spec/1/approve`, a.userId); // no body: as before
    await call(h, 'PUT', `/api/agents/${a.agentId}/spec`, a.userId, { spec: minimalSpec() });
    const shown = ((await (await call(h, 'GET', `/api/agents/${a.agentId}/spec`, a.userId)).json()) as { draft: { version: number; createdAt: string } }).draft;
    expect(shown.version).toBe(2);
    // the owner discards it and saves another under the same number while the first is still on screen
    await call(h, 'DELETE', `/api/agents/${a.agentId}/spec/2`, a.userId);
    await sql`select pg_sleep(0.01)`;
    await call(h, 'PUT', `/api/agents/${a.agentId}/spec`, a.userId, { spec: minimalSpec() });
    const stale = await call(h, 'POST', `/api/agents/${a.agentId}/spec/2/approve`, a.userId, { createdAt: shown.createdAt });
    expect([stale.status, await stale.json()]).toEqual([409, { error: 'version_changed' }]);
    expect(((await (await call(h, 'GET', `/api/agents/${a.agentId}/spec`, a.userId)).json()) as { active: { version: number } }).active.version).toBe(1); // nothing was approved
    const now = ((await (await call(h, 'GET', `/api/agents/${a.agentId}/spec`, a.userId)).json()) as { draft: { createdAt: string } }).draft;
    for (const bad of [{ createdAt: 5 }, { createdAt: 'yesterday-ish' }, [1]]) expect((await call(h, 'POST', `/api/agents/${a.agentId}/spec/2/approve`, a.userId, bad)).status).toBe(400);
    expect((await call(h, 'POST', `/api/agents/${a.agentId}/spec/2/approve`, a.userId, { createdAt: now.createdAt })).status).toBe(204);
    expect(((await (await call(h, 'GET', `/api/agents/${a.agentId}/spec`, a.userId)).json()) as { active: { version: number } }).active.version).toBe(2);
    // an unknown version stays 404 whatever createdAt says
    expect((await call(h, 'POST', `/api/agents/${a.agentId}/spec/9/approve`, a.userId, { createdAt: now.createdAt })).status).toBe(404);
  });

  it('DELETE spec/:v discards only an unapproved newer draft the caller owns', async () => {
    const a = await activeAgent(sql);
    const b = await activeAgent(sql);
    const h = app();
    await call(h, 'PUT', `/api/agents/${a.agentId}/spec`, a.userId, { spec: minimalSpec() });
    await call(h, 'POST', `/api/agents/${a.agentId}/spec/1/approve`, a.userId);
    await call(h, 'PUT', `/api/agents/${a.agentId}/spec`, a.userId, { spec: minimalSpec() }); // version 2, pending
    expect((await call(h, 'DELETE', `/api/agents/${a.agentId}/spec/2`)).status).toBe(401);
    expect((await call(h, 'DELETE', `/api/agents/${a.agentId}/spec/2`, b.userId)).status).toBe(404); // not theirs
    const left = async () => ((await sql`select version from app.agent_specs where agent_id = ${a.agentId} order by version`) as { version: number }[]).map((r) => r.version);
    expect(await left()).toEqual([1, 2]);
    const active = await call(h, 'DELETE', `/api/agents/${a.agentId}/spec/1`, a.userId); // the active version is never discarded
    expect([active.status, await active.json()]).toEqual([409, { error: 'not_discardable' }]);
    expect(await left()).toEqual([1, 2]);
    const ok = await call(h, 'DELETE', `/api/agents/${a.agentId}/spec/2`, a.userId);
    expect([ok.status, ok.headers.get('access-control-allow-origin')]).toEqual([204, ORIGIN]);
    expect(await left()).toEqual([1]);
    expect(await (await call(h, 'GET', `/api/agents/${a.agentId}/spec`, a.userId)).json()).toMatchObject({ active: { version: 1 }, draft: null });
    expect((await call(h, 'DELETE', `/api/agents/${a.agentId}/spec/2`, a.userId)).status).toBe(404); // already gone
  });

  it('an approved version that is no longer active cannot be discarded either', async () => {
    const a = await activeAgent(sql);
    const h = app();
    for (let i = 0; i < 2; i++) await call(h, 'PUT', `/api/agents/${a.agentId}/spec`, a.userId, { spec: minimalSpec() });
    await call(h, 'POST', `/api/agents/${a.agentId}/spec/1/approve`, a.userId);
    await call(h, 'POST', `/api/agents/${a.agentId}/spec/2/approve`, a.userId);
    expect((await call(h, 'DELETE', `/api/agents/${a.agentId}/spec/1`, a.userId)).status).toBe(409);
    expect((await call(h, 'DELETE', `/api/agents/${a.agentId}/spec/2`, a.userId)).status).toBe(409);
  });

  it('keeps every agent route to its owner', async () => {
    const a = await activeAgent(sql);
    const b = await activeAgent(sql);
    const h = app();
    expect((await call(h, 'PUT', `/api/agents/${a.agentId}/spec`, b.userId, { spec: minimalSpec() })).status).toBe(404);
    expect((await call(h, 'GET', `/api/agents/${a.agentId}/spec`, b.userId)).status).toBe(404);
    expect((await call(h, 'GET', `/api/agents/${a.agentId}/webhook-secret`, b.userId)).status).toBe(404);
    expect((await call(h, 'GET', `/api/agents/${a.agentId}/runs`, b.userId)).status).toBe(404); // like every owner route, never an empty 200
    expect((await call(h, 'GET', `/api/agents/${a.agentId}/spec`)).status).toBe(401);
  });

  it('returns the webhook secret and the recent runs', async () => {
    const a = await activeAgent(sql);
    const runs = createRuns(sql);
    const id = await runs.start({ agentId: a.agentId, mode: 'mission' });
    await runs.finish(id, { status: 'done', stopReason: 'done', usage: emptyUsage(), steps: [] });
    const h = app();
    expect(await (await call(h, 'GET', `/api/agents/${a.agentId}/webhook-secret`, a.userId)).json()).toEqual({ secret: `secret-of-${a.agentId}` });
    const list = (await (await call(h, 'GET', `/api/agents/${a.agentId}/runs`, a.userId)).json()) as { runs: { id: string; status: string }[] };
    expect(list.runs.map((r) => [r.id, r.status])).toEqual([[id, 'done']]);
  });

  it('one run for its owner: exactly the RunView fields; a foreign or unknown run is the same 404', async () => {
    const a = await activeAgent(sql);
    const b = await activeAgent(sql);
    const runs = createRuns(sql);
    const id = await runs.start({ agentId: a.agentId, mode: 'mission' });
    await runs.finish(id, { status: 'done', stopReason: 'done', usage: emptyUsage(), steps: [{ n: 1, tools: ['send_email'], inputTokens: 5, outputTokens: 2, finishReason: 'stop' }] });
    await runs.annotate(id, 'XLM fell.');
    const h = app();
    const mine = await call(h, 'GET', `/api/agents/${a.agentId}/runs/${id}`, a.userId);
    expect(mine.status).toBe(200);
    const body = (await mine.json()) as { run: Record<string, unknown> };
    expect(Object.keys(body)).toEqual(['run']);
    expect(Object.keys(body.run).sort()).toEqual(
      ['id', 'mode', 'status', 'stopReason', 'steps', 'inputTokens', 'outputTokens', 'cacheReadTokens', 'cacheWriteTokens', 'toolCalls', 'usdcSpent', 'usdcEarned', 'settlementTx', 'summary', 'result', 'triggerId', 'serviceId', 'model', 'startedAt', 'endedAt'].sort(),
    );
    expect(body.run).toMatchObject({ id, status: 'done', summary: 'XLM fell.' });
    expect(typeof body.run.startedAt).toBe('string');
    // another user, asking with their own agent id or the owner's agent id
    const foreign = await call(h, 'GET', `/api/agents/${a.agentId}/runs/${id}`, b.userId);
    const crossed = await call(h, 'GET', `/api/agents/${b.agentId}/runs/${id}`, b.userId);
    const unknown = await call(h, 'GET', `/api/agents/${a.agentId}/runs/${crypto.randomUUID()}`, a.userId);
    const text = async (r: Response) => [r.status, await r.text()];
    const want = await text(unknown);
    expect(want[0]).toBe(404);
    expect(await text(foreign)).toEqual(want);
    expect(await text(crossed)).toEqual(want);
    expect((await call(h, 'GET', `/api/agents/${a.agentId}/runs/${id}`)).status).toBe(401);
    expect((await call(h, 'GET', `/api/agents/${a.agentId}/runs/not-a-uuid`, a.userId)).status).toBe(404);
  });

  it('streams a chat turn as SSE: deltas then done', async () => {
    const a = await activeAgent(sql);
    chatOpen = async () => ({
      run: async (messages, o) => {
        expect(messages).toEqual([{ role: 'user', content: 'How is XLM?' }]);
        o.onDelta('XLM ');
        o.onDelta('is calm.');
        return { runId: 'r1', status: 'done', stop: 'done', text: 'XLM is calm.', finalText: 'XLM is calm.', usage: emptyUsage() };
      },
    });
    const res = await call(app(), 'POST', `/api/chat/${a.agentId}`, a.userId, { messages: [{ role: 'user', content: 'How is XLM?' }] });
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('text/event-stream');
    expect(res.headers.get('access-control-allow-origin')).toBe(ORIGIN);
    // Nothing on the way may hold the stream back or rewrite it.
    expect(res.headers.get('cache-control')).toBe('no-cache, no-transform');
    expect(res.headers.get('x-accel-buffering')).toBe('no');
    expect(await res.text()).toBe(
      ': open\n\n' +
        'event: delta\ndata: {"text":"XLM "}\n\n' +
        'event: delta\ndata: {"text":"is calm."}\n\n' +
        `event: done\ndata: ${JSON.stringify({ runId: 'r1', status: 'done', stop: 'done', usage: emptyUsage() })}\n\n`,
    );
  });

  it('sends the first bytes, each word and each tool call while the model is still working, over a real socket', async () => {
    const a = await activeAgent(sql);
    let step!: () => void;
    const next = () => new Promise<void>((r) => (step = r));
    let gate = next();
    chatOpen = async () => ({
      run: async (_m, o) => {
        await gate;
        gate = next();
        o.onDelta('first');
        await gate;
        gate = next();
        o.onTool?.({ id: 1, name: 'web_search', state: 'running' });
        await gate;
        return { runId: 'r1', status: 'done', stop: 'done', text: 'first', finalText: 'first', usage: emptyUsage() };
      },
    });
    const h = app();
    const server = Bun.serve({ port: 0, fetch: (r) => h(r, undefined) });
    try {
      const res = await fetch(`http://localhost:${server.port}/api/chat/${a.agentId}`, {
        method: 'POST',
        headers: { origin: ORIGIN, authorization: `Bearer tok:${a.userId}`, 'content-type': 'application/json' },
        body: JSON.stringify({ messages: [{ role: 'user', content: 'hi' }] }),
      });
      const reader = res.body!.getReader();
      const dec = new TextDecoder();
      const read = async () => dec.decode((await reader.read()).value);
      expect(await read()).toBe(': open\n\n'); // the model has not been asked to go on yet
      step();
      expect(await read()).toBe('event: delta\ndata: {"text":"first"}\n\n');
      step();
      expect(await read()).toBe('event: tool\ndata: {"id":1,"name":"web_search","state":"running"}\n\n');
      step();
      expect(await read()).toContain('event: done');
    } finally {
      await server.stop(true);
    }
  });

  it('stores exactly what was streamed: the answer is the joined words, and its leaf the hash of them', async () => {
    const a = await activeAgent(sql);
    const pieces = ['Let me ', 'check.', 'It is **calm**.'];
    chatOpen = async () => ({
      run: async (_m, o) => {
        o.onDelta(pieces[0]!);
        o.onDelta(pieces[1]!);
        o.onTool?.({ id: 1, name: 'web_search', state: 'running' });
        o.onTool?.({ id: 1, name: 'web_search', state: 'done' });
        o.onDelta(pieces[2]!);
        return { runId: null as unknown as string, status: 'done', stop: 'done', text: pieces.join(''), finalText: pieces[2]!, usage: emptyUsage() };
      },
    });
    const h = app({ chatSessions: createChatSessions(sql) });
    const { session } = (await (await call(h, 'POST', `/api/chat/${a.agentId}/sessions`, a.userId)).json()) as { session: { id: string } };
    const body = await (await call(h, 'POST', `/api/chat/${a.agentId}`, a.userId, { sessionId: session.id, text: 'how?' })).text();
    const streamed = [...body.matchAll(/^event: delta\ndata: (.*)$/gm)].map((x) => (JSON.parse(x[1]!) as { text: string }).text).join('');
    const [row] = (await sql`select answer, leaf from app.chat_turns where session_id = ${session.id}`) as { answer: string; leaf: string }[];
    expect(row!.answer).toBe(streamed);
    expect(JSON.parse(row!.leaf).output).toBe(new Bun.CryptoHasher('sha256').update(streamed).digest('hex'));
    expect(row!.answer).not.toContain('web_search');
  });

  it('renames, archives and deletes a chat, for its owner only', async () => {
    const a = await activeAgent(sql);
    const other = await activeAgent(sql);
    chatOpen = async () => ({ run: async (_m, o) => (o.onDelta('a'), { runId: null as unknown as string, status: 'done', stop: 'done', text: 'a', finalText: 'a', usage: emptyUsage() }) });
    const h = app({ chatSessions: createChatSessions(sql) });
    const { session } = (await (await call(h, 'POST', `/api/chat/${a.agentId}/sessions`, a.userId)).json()) as { session: { id: string } };
    await (await call(h, 'POST', `/api/chat/${a.agentId}`, a.userId, { sessionId: session.id, text: 'hello' })).text();
    const path = `/api/chat/${a.agentId}/sessions/${session.id}`;
    const ids = async (q = '') => ((await (await call(h, 'GET', `/api/chat/${a.agentId}/sessions${q}`, a.userId)).json()) as { sessions: { id: string; title: string }[] }).sessions;

    expect((await call(h, 'PATCH', path, a.userId, { title: '  My   chat ' })).status).toBe(200);
    expect((await ids())[0]!.title).toBe('My chat');
    for (const bad of [{}, { title: '' }, { title: 'x'.repeat(81) }, { archived: 'yes' }]) expect((await call(h, 'PATCH', path, a.userId, bad)).status).toBe(400);
    expect((await call(h, 'PATCH', path, other.userId, { archived: true })).status).toBe(404);
    expect((await call(h, 'DELETE', path, other.userId)).status).toBe(404);
    expect((await call(h, 'DELETE', path)).status).toBe(401);

    expect((await call(h, 'PATCH', path, a.userId, { archived: true })).status).toBe(200);
    expect(await ids()).toEqual([]);
    expect((await ids('?archived=1')).map((x) => x.id)).toEqual([session.id]);
    expect((await call(h, 'PATCH', path, a.userId, { archived: false })).status).toBe(200);
    expect((await ids()).map((x) => x.id)).toEqual([session.id]);

    const del = await call(h, 'DELETE', path, a.userId);
    expect([del.status, await del.json()]).toEqual([200, { kept: false }]);
    expect(await ids()).toEqual([]);
    expect((await call(h, 'GET', path, a.userId)).status).toBe(404);
    expect((await call(h, 'DELETE', path, a.userId)).status).toBe(404);
  });

  it('keeps a conversation on the server: new chat, its history goes to the model, turns read back, owner-only', async () => {
    const a = await activeAgent(sql);
    const other = await activeAgent(sql);
    const sealed: unknown[] = [];
    const h = app({ chatSessions: createChatSessions(sql), sealPaidTurn: async (_id, t) => void sealed.push(t) });
    let seen: unknown[] = [];
    let n = 0;
    chatOpen = async () => ({
      run: async (messages, o) => {
        seen = messages;
        n++;
        o.onDelta(`answer ${n}`);
        return { runId: crypto.randomUUID(), status: 'done', stop: 'done', text: `answer ${n}`, finalText: `answer ${n}`, usage: emptyUsage() };
      },
    });
    const created = await call(h, 'POST', `/api/chat/${a.agentId}/sessions`, a.userId);
    expect(created.status).toBe(201);
    const { session } = (await created.json()) as { session: { id: string } };
    const first = await call(h, 'POST', `/api/chat/${a.agentId}`, a.userId, { sessionId: session.id, text: ' first ' });
    expect(first.status).toBe(200);
    await first.text(); // the turn is stored before the stream's last frame
    await (await call(h, 'POST', `/api/chat/${a.agentId}`, a.userId, { sessionId: session.id, text: 'second' })).text();
    expect(seen).toEqual([
      { role: 'user', content: 'first' },
      { role: 'assistant', content: 'answer 1' },
      { role: 'user', content: 'second' },
    ]);
    const turns = (await (await call(h, 'GET', `/api/chat/${a.agentId}/sessions/${session.id}`, a.userId)).json()) as { turns: { question: string; answer: string }[] };
    expect(turns.turns.map((t) => [t.question, t.answer])).toEqual([['first', 'answer 1'], ['second', 'answer 2']]);
    const list = (await (await call(h, 'GET', `/api/chat/${a.agentId}/sessions`, a.userId)).json()) as { sessions: { id: string; title: string; turns: number }[] };
    expect(list.sessions[0]).toMatchObject({ id: session.id, title: 'first', turns: 2 });
    expect(sealed).toEqual([]); // nothing was paid
    // Another owner: their agent cannot reach this conversation, and this agent's list is a 404 for them.
    expect((await call(h, 'GET', `/api/chat/${a.agentId}/sessions`, other.userId)).status).toBe(404);
    expect((await call(h, 'GET', `/api/chat/${other.agentId}/sessions/${session.id}`, other.userId)).status).toBe(404);
    expect((await call(h, 'POST', `/api/chat/${a.agentId}`, a.userId, { sessionId: session.id, text: '' })).status).toBe(400);
    expect((await call(h, 'POST', `/api/chat/${a.agentId}`, a.userId, { sessionId: 'nope', text: 'x' })).status).toBe(400);
  });

  it('refuses before streaming: bad messages, refused session, kill switch', async () => {
    const a = await activeAgent(sql);
    chatOpen = async () => {
      throw httpError(409, 'no_spec');
    };
    const h = app();
    for (const body of [{}, { messages: [] }, { messages: [{ role: 'system', content: 'x' }] }, { messages: [{ role: 'assistant', content: 'x' }] }, { messages: Array(21).fill({ role: 'user', content: 'x' }) }]) {
      expect((await call(h, 'POST', `/api/chat/${a.agentId}`, a.userId, body)).status).toBe(400);
    }
    const refused = await call(h, 'POST', `/api/chat/${a.agentId}`, a.userId, { messages: [{ role: 'user', content: 'hi' }] });
    expect([refused.status, await refused.json()]).toEqual([409, { error: 'no_spec' }]);
    const killed = await call(app({ killed: true }), 'POST', `/api/chat/${a.agentId}`, a.userId, { messages: [{ role: 'user', content: 'hi' }] });
    expect([killed.status, await killed.json()]).toEqual([503, { error: 'killed' }]);
  });

  it('allows one chat at a time per agent, sends keepalives, and ends a failed run with an error frame', async () => {
    const a = await activeAgent(sql);
    let finish!: () => void;
    const gate = new Promise<void>((r) => (finish = r));
    chatOpen = async () => ({
      run: async () => {
        await gate;
        throw new Error('db down');
      },
    });
    const h = app({ keepaliveMs: 5 });
    const first = await call(h, 'POST', `/api/chat/${a.agentId}`, a.userId, { messages: [{ role: 'user', content: 'hi' }] });
    const second = await call(h, 'POST', `/api/chat/${a.agentId}`, a.userId, { messages: [{ role: 'user', content: 'hi' }] });
    expect([second.status, await second.json()]).toEqual([429, { error: 'chat_busy' }]);
    await Bun.sleep(30);
    finish();
    const text = await first.text();
    expect(text).toContain(': keepalive\n\n');
    expect(text.endsWith('event: done\ndata: {"status":"error","stop":"error"}\n\n')).toBe(true);
    chatOpen = async () => ({ run: async () => ({ runId: 'r2', status: 'done', stop: 'done', text: '', finalText: '', usage: emptyUsage() }) });
    expect((await call(h, 'POST', `/api/chat/${a.agentId}`, a.userId, { messages: [{ role: 'user', content: 'again' }] })).status).toBe(200);
  });

  it('never sends raw error text, sends the secret uncached, caps message size, and aborts on disconnect', async () => {
    const a = await activeAgent(sql);
    const h = app();
    const sec = await call(h, 'GET', `/api/agents/${a.agentId}/webhook-secret`, a.userId);
    expect(sec.headers.get('cache-control')).toBe('no-store');
    expect((await call(h, 'POST', `/api/chat/${a.agentId}`, a.userId, { messages: [{ role: 'user', content: 'x'.repeat(3001) }] })).status).toBe(400);
    chatOpen = async () => ({ run: async () => ({ runId: 'r3', status: 'error', stop: 'error', text: 'partial SECRET-DETAIL', finalText: 'partial SECRET-DETAIL', usage: emptyUsage() }) });
    const err = await (await call(h, 'POST', `/api/chat/${a.agentId}`, a.userId, { messages: [{ role: 'user', content: 'hi' }] })).text();
    expect(err).toBe(': open\n\nevent: done\ndata: {"runId":"r3","status":"error","stop":"error"}\n\n');
    let seen: AbortSignal | undefined;
    let started!: () => void;
    const go = new Promise<void>((r) => (started = r));
    chatOpen = async () => ({
      run: async (_m, o) => {
        seen = o.signal;
        started();
        await new Promise((r) => o.signal?.addEventListener('abort', r));
        return { runId: 'r4', status: 'error', stop: 'aborted', text: '', finalText: '', usage: emptyUsage() };
      },
    });
    const res = await call(h, 'POST', `/api/chat/${a.agentId}`, a.userId, { messages: [{ role: 'user', content: 'hi' }] });
    await go;
    await res.body!.cancel();
    await Bun.sleep(10);
    expect(seen?.aborted).toBe(true);
    chatOpen = async () => ({ run: async () => ({ runId: 'r5', status: 'done', stop: 'done', text: '', finalText: '', usage: emptyUsage() }) });
    expect((await call(h, 'POST', `/api/chat/${a.agentId}`, a.userId, { messages: [{ role: 'user', content: 'again' }] })).status).toBe(200);
  });

  it('a non-owner gets 404 while the owner chats, and never blocks the owner', async () => {
    const a = await activeAgent(sql);
    const intruder = await activeAgent(sql);
    let finish!: () => void;
    const gate = new Promise<void>((r) => (finish = r));
    let slowOpen!: () => void;
    const slow = new Promise<void>((r) => (slowOpen = r));
    chatOpen = async (u) => {
      if (u !== a.userId) {
        await slow; // a slow ownership check must not hold the lock
        throw httpError(404, 'not_found');
      }
      return { run: async () => (await gate, { runId: 'r6', status: 'done', stop: 'done', text: '', finalText: '', usage: emptyUsage() }) };
    };
    const h = app();
    const msg = { messages: [{ role: 'user', content: 'hi' }] };
    // The intruder's check is still pending when the owner starts: the owner is not refused.
    const pending = call(h, 'POST', `/api/chat/${a.agentId}`, intruder.userId, msg);
    const first = await call(h, 'POST', `/api/chat/${a.agentId}`, a.userId, msg);
    expect(first.status).toBe(200);
    slowOpen();
    expect([(await pending).status]).toEqual([404]);
    // While the owner is mid-chat, a non-owner still sees 404, not 429 chat_busy.
    const during = await call(h, 'POST', `/api/chat/${a.agentId}`, intruder.userId, msg);
    expect([during.status, await during.json()]).toEqual([404, { error: 'not_found' }]);
    // And the owner's own second tab is the only one told busy.
    expect((await call(h, 'POST', `/api/chat/${a.agentId}`, a.userId, msg)).status).toBe(429);
    finish();
    await first.text();
    expect((await call(h, 'POST', `/api/chat/${a.agentId}`, a.userId, msg)).status).toBe(200);
  });

  it('rate-limits spec writes per account: save and approve share the budget, other accounts are unaffected', async () => {
    const a = await activeAgent(sql);
    const other = await activeAgent(sql);
    let t = 1_000_000;
    const h = app({ now: () => t });
    const put = (u: string, id: string) => call(h, 'PUT', `/api/agents/${id}/spec`, u, { spec: {} });
    for (let i = 0; i < SPEC_WRITES_PER_HOUR - 1; i++) expect((await put(a.userId, a.agentId)).status).toBe(400);
    expect((await call(h, 'POST', `/api/agents/${a.agentId}/spec/9/approve`, a.userId)).status).toBe(404);
    const limited = await put(a.userId, a.agentId);
    expect([limited.status, await limited.json()]).toEqual([429, { error: 'rate_limited' }]);
    expect(Number(limited.headers.get('retry-after'))).toBeGreaterThan(0);
    expect((await call(h, 'POST', `/api/agents/${a.agentId}/spec/9/approve`, a.userId)).status).toBe(429);
    expect((await put(other.userId, other.agentId)).status).toBe(400);
    expect((await call(h, 'GET', `/api/agents/${a.agentId}/spec`, a.userId)).status).toBe(200); // reads are not limited
    t += 3_600_001;
    expect((await put(a.userId, a.agentId)).status).toBe(400);
  });

  describe('with the real owner runs', () => {
    function realChat(model: ReturnType<typeof scriptedModel>, beforeRun?: () => Promise<void>) {
      const policy = createPolicy(sql, { killSwitch: false });
      const specs = createSpecs(sql);
      const real = createOwnerRuns({
        sql,
        specs,
        memory: createMemory(sql),
        runs: createRuns(sql),
        runner: createRunner({ runs: createRuns(sql), policy, model, modelId: 'test/model' }),
        toolbox: { ownerTools: () => ({}), delivery: { email: async () => ({ id: 'm' }), webhook: async () => ({ status: 200 }) } },
        policy,
      });
      return {
        openChat: async (u: string, id: string) => {
          const s = await real.openChat(u, id);
          await beforeRun?.();
          return s;
        },
      };
    }
    const msg = { messages: [{ role: 'user', content: 'hi' }] };

    it('a provisioning agent is refused before any model call', async () => {
      const a = await activeAgent(sql);
      await sql`update app.agents set status = 'provisioning' where id = ${a.agentId}`;
      const model = scriptedModel([{ text: 'x' }]);
      const res = await call(app({ chat: realChat(model) }), 'POST', `/api/chat/${a.agentId}`, a.userId, msg);
      expect([res.status, await res.json()]).toEqual([409, { error: 'agent_not_active' }]);
      expect(model.calls()).toBe(0);
    });

    it('an agent revoked after the session opened ends with an error frame and no model call', async () => {
      const a = await activeAgent(sql);
      const specs = createSpecs(sql);
      await specs.approve(a.userId, a.agentId, await specs.saveDraft(a.userId, a.agentId, minimalSpec()));
      const model = scriptedModel([{ text: 'x' }]);
      const chat = realChat(model, async () => void (await sql`update app.agents set status = 'revoked' where id = ${a.agentId}`));
      const res = await call(app({ chat }), 'POST', `/api/chat/${a.agentId}`, a.userId, msg);
      expect(res.status).toBe(200);
      expect(await res.text()).toBe(': open\n\nevent: done\ndata: {"status":"error","stop":"error"}\n\n');
      expect(model.calls()).toBe(0);
    });
  });

  it('CORS preflight allows PUT', async () => {
    const res = await app()(new Request(`${API}/api/agents/x/spec`, { method: 'OPTIONS' }));
    expect(res.headers.get('access-control-allow-methods')).toBe('GET, POST, PUT, PATCH, DELETE');
  });
});

describe('gateway runtime routes: the view on a saved description', () => {
  let sql: Db;
  let drop: () => Promise<void>;
  let h: ReturnType<typeof createApp>;
  beforeAll(async () => {
    ({ sql, drop } = await freshDb());
    const verify: AuthVerifier = async (t) => (t.startsWith('tok:') ? { id: t.slice(4), email: `${t.slice(4)}@example.com` } : null);
    h = createApp({
      sql,
      verify,
      passkey: {} as never,
      signRequests: {} as never,
      provisioner: {} as never,
      appOrigin: ORIGIN,
      runtime: { specs: createSpecs(sql), runs: createRuns(sql), chat: {} as never, webhookSecret: () => 's', killed: false },
    });
  });
  afterAll(() => drop());
  const put = (agentId: string, userId: string, body: unknown) =>
    h(new Request(`${API}/api/agents/${agentId}/spec`, { method: 'PUT', headers: { authorization: `Bearer tok:${userId}`, 'content-type': 'application/json' }, body: JSON.stringify(body) }));
  const { name: _n, spec: _s, ...VIEW } = xlmDrop();

  it('PUT spec stores a valid view and GET spec returns it', async () => {
    const a = await activeAgent(sql);
    const r = await put(a.agentId, a.userId, { spec: xlmDrop().spec, view: VIEW });
    expect([r.status, await r.json()]).toEqual([201, { version: 1 }]);
    const got = await h(new Request(`${API}/api/agents/${a.agentId}/spec`, { headers: { authorization: `Bearer tok:${a.userId}` } }));
    expect((await got.json()).draft.view).toEqual(VIEW);
  });

  it('an invalid view is 400 bad_view and nothing is saved', async () => {
    const a = await activeAgent(sql);
    for (const view of [{ sentence: [] }, { ...VIEW, extra: 1 }, { ...VIEW, bindings: [{ param: 'drop', path: '/persona' }] }, { ...VIEW, params: [] }]) {
      const r = await put(a.agentId, a.userId, { spec: xlmDrop().spec, view });
      expect([r.status, await r.json()]).toEqual([400, { error: 'bad_view' }]);
    }
    expect(((await sql`select count(*)::int as n from app.agent_specs where agent_id = ${a.agentId}`) as { n: number }[])[0]!.n).toBe(0);
  });

  it('a view for another user\'s agent is 404, not a validation answer', async () => {
    const a = await activeAgent(sql);
    const b = await activeAgent(sql);
    expect((await put(a.agentId, b.userId, { spec: xlmDrop().spec, view: { sentence: [] } })).status).toBe(404);
  });
});
