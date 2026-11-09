import { createModelDirectory } from '../src/loop/model-choices.js';
import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import type { AuthVerifier } from '../src/account/auth.js';
import { createAccessTokens } from '../src/account/access-tokens.js';
import { createAgents } from '../src/agents/index.js';
import type { Db } from '../src/db/index.js';
import { httpError } from '../src/errors.js';
import { createApp, type AppDeps } from '../src/gateway/app.js';
import type { ChatMessage } from '../src/loop/owner.js';
import { createChatLock } from '../src/owner-mcp/chat-lock.js';
import { createOwnerMcp, type OwnerMcpDeps } from '../src/owner-mcp/index.js';
import { createRuns, type RunView } from '../src/runs/index.js';
import { freshDb } from './support/db.js';
import { activeAgent } from './support/specs.js';

const ORIGIN = 'https://app.agentenact.io';
const API = 'https://api.agentenact.io';
const RUN = '11111111-2222-4333-8444-555555555555';

const runView = (over: Partial<RunView> = {}): RunView => ({
  id: RUN, mode: 'mission', status: 'done', stopReason: 'end_turn', steps: [{ n: 1, tools: ['price'], inputTokens: 900, outputTokens: 120, finishReason: 'stop' }],
  inputTokens: 900, outputTokens: 120, cacheReadTokens: 0, cacheWriteTokens: 0, toolCalls: 1, usdcSpent: '0.0000000', usdcEarned: '0.0100000',
  settlementTx: 'ab'.repeat(32), summary: 'XLM is flat today.', triggerId: null, serviceId: null, model: 'sonnet', startedAt: new Date('2026-10-28T08:00:00Z'), endedAt: new Date('2026-10-28T08:00:09Z'),
  ...over,
});

describe('owner MCP: a harness talks to the owner\'s own agents', () => {
  let sql: Db;
  let drop: () => Promise<void>;
  beforeAll(async () => {
    ({ sql, drop } = await freshDb());
  });
  afterAll(() => drop());

  /** The gateway with the real token store, the real pause/resume, and fakes for the model-backed parts. */
  function setup(over: Partial<OwnerMcpDeps> = {}) {
    const tokens = createAccessTokens(sql);
    const chats: { userId: string; agentId: string; messages: ChatMessage[] }[] = [];
    const chatLock = createChatLock();
    let killed = false;
    const deps: OwnerMcpDeps = {
      sql,
      tokens,
      activity: {
        overview: async (_u, _a) => ({ name: 'test agent', status: 'watching', nextCheckAt: null, lastAlertAt: null, checksToday: 3, alertsThisWeek: 1, earnedUsdc: '0.0100000', salesCount: 1, budgetUsedPct: 4, watchingSince: '2026-10-20T00:00:00Z', checksTotal: 40, watchesCondition: true, running: false, lastRun: null, latestCheck: null, morningNote: null, model: await createModelDirectory({ defaultId: 'deepseek/deepseek-v4.1-flash' }).view(null), awaitingFunds: false }),
        feed: async () => [{ type: 'alert', at: '2026-10-28T08:00:09Z', runId: RUN, text: 'XLM fell 5.2%' }],
      },
      runs: {
        start: (r) => createRuns(sql).start(r),
        finish: (id, r) => createRuns(sql).finish(id, r),
        annotate: (id, t) => createRuns(sql).annotate(id, t),
        recent: async (_u, _a, limit) => Array.from({ length: Math.min(limit ?? 20, 2) }, () => runView()),
        getOwned: async (u, a, id) => (id === RUN && (await sql`select 1 from app.agents where id = ${a} and user_id = ${u}`).length ? runView() : null),
      },
      chat: {
        openChat: async (userId, agentId) => {
          const rows = (await sql`select status from app.agents where id = ${agentId} and user_id = ${userId}`) as { status: string }[];
          if (!rows[0]) throw httpError(404, 'not_found');
          if (rows[0].status !== 'active') throw httpError(409, 'agent_not_active');
          return {
            run: async (messages, o) => {
              chats.push({ userId, agentId, messages });
              o.onDelta('Hel');
              o.onDelta('lo');
              return { runId: RUN, status: 'done', stop: 'end_turn', usage: {} as never, text: 'Hello', finalText: 'Hello' } as never;
            },
          };
        },
      },
      chatLock,
      agents: createAgents(sql),
      specs: { liveServices: async () => [] },
      killed: () => killed,
      publicBaseUrl: API,
      version: 'test',
      ...over,
    };
    const verify: AuthVerifier = async (t) => (t.startsWith('tok:') ? { id: t.slice(4), email: `${t.slice(4)}@example.com` } : null);
    const base: AppDeps = { sql, verify, passkey: {} as never, signRequests: {} as never, provisioner: {} as never, appOrigin: ORIGIN };
    const app = createApp({ ...base, tokens, ownerMcp: createOwnerMcp(deps) });
    return { app, tokens, chats, chatLock, kill: () => (killed = true) };
  }

  let id = 0;
  const rpc = async (app: ReturnType<typeof setup>['app'], token: string | null, method: string, params?: unknown) => {
    const res = await app(new Request(`${API}/mcp`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream', ...(token ? { authorization: `Bearer ${token}` } : {}) },
      body: JSON.stringify({ jsonrpc: '2.0', id: ++id, method, ...(params ? { params } : {}) }),
    }));
    return res;
  };
  const tool = async (app: ReturnType<typeof setup>['app'], token: string, name: string, args: Record<string, unknown> = {}) => {
    const res = await rpc(app, token, 'tools/call', { name, arguments: args });
    expect(res.status).toBe(200);
    return ((await res.json()) as { result: { structuredContent: Record<string, any>; isError?: boolean } }).result;
  };

  it('needs a live access token: none, a session JWT or a revoked token is 401 with a Bearer challenge', async () => {
    const { app, tokens } = setup();
    const a = await activeAgent(sql);
    const t = await tokens.issue(a.userId, 'laptop');
    for (const bad of [null, `tok:${a.userId}`, 'ae_pat_nope']) {
      const r = await rpc(app, bad, 'initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 't', version: '0' } });
      expect([r.status, r.headers.get('www-authenticate')]).toEqual([401, 'Bearer realm="agentenact"']);
    }
    expect((await rpc(app, t.token, 'ping')).status).toBe(200);
    await tokens.revoke(a.userId, t.id);
    expect((await rpc(app, t.token, 'ping')).status).toBe(401);
    expect((await app(new Request(`${API}/mcp`, { method: 'GET', headers: { authorization: `Bearer ${t.token}` } }))).status).toBe(405);
  });

  it('lists the owner tools and only ever the owner\'s own agents', async () => {
    const { app, tokens } = setup();
    const a = await activeAgent(sql);
    const other = await activeAgent(sql);
    const t = (await tokens.issue(a.userId, 'laptop')).token;
    const list = (await (await rpc(app, t, 'tools/list')).json()) as { result: { tools: { name: string }[] } };
    expect(list.result.tools.map((x) => x.name)).toEqual(['list_my_agents', 'get_my_agent', 'message_agent', 'list_runs', 'get_run', 'get_activity', 'pause_agent', 'resume_agent']);
    const mine = await tool(app, t, 'list_my_agents');
    expect(mine.structuredContent.agents).toEqual([{ id: a.agentId, name: 'test agent', status: 'active', address: a.address, agentId: '77', profile: `${API}/a/${a.agentId}/agent.json` }]);
    const foreign = await tool(app, t, 'get_my_agent', { agent: other.agentId });
    expect([foreign.isError, foreign.structuredContent]).toEqual([true, { error: 'not_found' }]);
    const run = await tool(app, t, 'get_run', { agent: other.agentId, run_id: RUN });
    expect(run.structuredContent).toEqual({ error: 'not_found' });
  });

  it('reads the one agent without naming it: overview, runs, one run with its record, activity', async () => {
    const { app, tokens } = setup();
    const a = await activeAgent(sql);
    const t = (await tokens.issue(a.userId, 'laptop')).token;
    const got = await tool(app, t, 'get_my_agent');
    expect(got.structuredContent).toMatchObject({ id: a.agentId, agentId: '77', checksToday: 3, earnedUsdc: '0.0100000', services: [] });
    const runs = await tool(app, t, 'list_runs', { limit: 5 });
    expect(runs.structuredContent.runs[0]).toEqual({ id: RUN, mode: 'mission', status: 'done', summary: 'XLM is flat today.', startedAt: '2026-10-28T08:00:00.000Z', endedAt: '2026-10-28T08:00:09.000Z', usdcSpent: '0.0000000', usdcEarned: '0.0100000', settlementTx: 'ab'.repeat(32) });
    const one = await tool(app, t, 'get_run', { run_id: RUN });
    expect(one.structuredContent.record).toBe(`${API}/a/${a.agentId}/records/${'ab'.repeat(32)}`);
    expect((await tool(app, t, 'get_activity', { days: 3 })).structuredContent.items).toHaveLength(1);
    expect((await tool(app, t, 'list_runs', { limit: 500 })).structuredContent).toEqual({ error: 'bad_limit' });
  });

  it('message_agent runs the panel chat with the history, and shares the panel\'s one-chat lock and kill switch', async () => {
    const s = setup();
    const a = await activeAgent(sql);
    const t = (await s.tokens.issue(a.userId, 'laptop')).token;
    const said = await tool(s.app, t, 'message_agent', { message: 'and now?', history: [{ role: 'user', content: 'how is XLM?' }, { role: 'assistant', content: 'flat' }] });
    expect(said.structuredContent).toEqual({ agent: a.agentId, runId: RUN, status: 'done', reply: 'Hello' });
    expect(s.chats[0]!.messages).toEqual([{ role: 'user', content: 'how is XLM?' }, { role: 'assistant', content: 'flat' }, { role: 'user', content: 'and now?' }]);
    expect(s.chats[0]!.userId).toBe(a.userId);

    const release = (await s.chatLock.take(a.agentId))!; // the panel chat is open
    expect((await tool(s.app, t, 'message_agent', { message: 'hi' })).structuredContent).toEqual({ error: 'chat_busy' });
    release();
    expect((await tool(s.app, t, 'message_agent', { message: 'hi', history: [{ role: 'system', content: 'x' }] })).structuredContent).toEqual({ error: 'bad_history' });
    s.kill();
    expect((await tool(s.app, t, 'message_agent', { message: 'hi' })).structuredContent).toEqual({ error: 'killed' });
    expect(s.chats).toHaveLength(1);
  });

  it('pauses and resumes through the panel\'s own guarded update, and a paused agent cannot chat', async () => {
    const s = setup();
    const a = await activeAgent(sql);
    const t = (await s.tokens.issue(a.userId, 'laptop')).token;
    expect((await tool(s.app, t, 'pause_agent')).structuredContent).toEqual({ agent: a.agentId, status: 'paused' });
    expect(((await sql`select status from app.agents where id = ${a.agentId}`) as { status: string }[])[0]!.status).toBe('paused');
    expect((await tool(s.app, t, 'pause_agent')).structuredContent).toEqual({ error: 'not_active' });
    expect((await tool(s.app, t, 'message_agent', { message: 'hi' })).structuredContent).toEqual({ error: 'agent_not_active' });
    expect((await tool(s.app, t, 'resume_agent')).structuredContent).toEqual({ agent: a.agentId, status: 'active' });
  });

  it('manages tokens from the panel session only: issue (once), list without secrets, revoke', async () => {
    const { app } = setup();
    const a = await activeAgent(sql);
    const call = (method: string, path: string, body?: unknown, auth = `tok:${a.userId}`) =>
      app(new Request(`${API}${path}`, { method, headers: { origin: ORIGIN, 'content-type': 'application/json', authorization: `Bearer ${auth}` }, ...(body ? { body: JSON.stringify(body) } : {}) }));
    const made = await call('POST', '/api/tokens', { name: 'Codex' });
    expect([made.status, made.headers.get('cache-control')]).toEqual([201, 'no-store']);
    const t = (await made.json()) as { id: string; token: string };
    expect(t.token).toMatch(/^ae_pat_/);
    const listed = await (await call('GET', '/api/tokens')).text();
    expect(listed).toContain(t.id);
    expect(listed).not.toContain(t.token);
    // A token cannot manage tokens: those routes take the panel session only.
    expect((await call('GET', '/api/tokens', undefined, t.token)).status).toBe(401);
    expect((await call('POST', `/api/tokens/${t.id}/revoke`)).status).toBe(204);
    expect((await rpc(app, t.token, 'ping')).status).toBe(401);
    expect((await call('POST', '/api/tokens', { name: '' })).status).toBe(400);
  });

  it('with reads, the same key finds and checks any agent, after the owner tools and before the writes', async () => {
    const seen: unknown[] = [];
    const s = setup({
      reads: {
        find: async (a) => (seen.push(['find', a]), { network: 'stellar:testnet', agents: [{ agent_id: '108', proven_sales: 2 }], next: null }),
        get: async (id) => {
          seen.push(['get', id]);
          if (id === 9) throw Object.assign(new Error('tool: agent_not_found'), { code: 'agent_not_found' });
          return { agent_id: String(id), owner: 'G…' };
        },
        verify: async (a) => (seen.push(['verify', a]), { ok: true }),
      },
    });
    const a = await activeAgent(sql);
    const t = (await s.tokens.issue(a.userId, 'laptop')).token;
    const list = (await (await rpc(s.app, t, 'tools/list')).json()) as { result: { tools: { name: string }[] } };
    expect(list.result.tools.map((x) => x.name)).toEqual(['list_my_agents', 'get_my_agent', 'message_agent', 'list_runs', 'get_run', 'get_activity', 'find_agents', 'get_agent', 'verify_record', 'pause_agent', 'resume_agent']);
    expect((await tool(s.app, t, 'find_agents', { query: 'price', limit: 5 })).structuredContent.agents).toHaveLength(1);
    expect((await tool(s.app, t, 'get_agent', { agent_id: '108' })).structuredContent).toEqual({ agent_id: '108', owner: 'G…' });
    expect((await tool(s.app, t, 'get_agent', { agent_id: '9' })).structuredContent).toEqual({ error: 'agent_not_found' });
    expect((await tool(s.app, t, 'get_agent', { agent_id: 'x' })).structuredContent).toEqual({ error: 'bad_agent_id' });
    expect((await tool(s.app, t, 'find_agents', { limit: 99 })).structuredContent).toEqual({ error: 'bad_limit' });
    expect((await tool(s.app, t, 'verify_record', { record: 'abc', output: 'hello' })).structuredContent).toEqual({ ok: true });
    expect(seen).toEqual([['find', { query: 'price', limit: 5 }], ['get', 108], ['get', 9], ['verify', { record: 'abc', output: 'hello' }]]);
  });

  it('hire_agent pays from the owner\'s named agent through the hirer, as a chat run of its own, and never hides a claimed payment', async () => {
    const asked: unknown[] = [];
    let next: 'paid' | 'refused' | 'unknown' | 'throws' = 'paid';
    const s = setup({
      hire: async (r) => {
        asked.push(r);
        if (next === 'throws') throw new Error('boom');
        if (next === 'refused') return { ok: false, code: 'offer_refused' };
        if (next === 'unknown') return { ok: false, code: 'seller_failed', payment: 'unknown', paidUsdc: '0.01' };
        return { ok: true, status: 200, output: { price: 0.31 }, payment: 'settled', transaction: 'cd'.repeat(32), paidUsdc: '0.01', record: 'verified', failedChecks: [], consistent: true };
      },
    });
    const a = await activeAgent(sql);
    const t = (await s.tokens.issue(a.userId, 'laptop')).token;
    const ok = (await tool(s.app, t, 'hire_agent', { url: 'https://seller.example/price', input: { coin: 'XLM' }, max_usdc: '0.02' })).structuredContent;
    expect(ok).toMatchObject({ agent: a.agentId, status: 200, output: { price: 0.31 }, payment: 'settled', paid_usdc: '0.01', record: 'verified' });
    expect(asked[0]).toMatchObject({ agentId: a.agentId, mode: 'chat', url: 'https://seller.example/price', input: { coin: 'XLM' }, maxUsdc: '0.02', runId: ok.runId });
    const run = ((await sql`select mode, status, stop_reason, summary from app.runs where id = ${ok.runId}`) as Record<string, string>[])[0];
    expect(run).toEqual({ mode: 'chat', status: 'done', stop_reason: 'owner_hire', summary: 'Hired seller.example from your AI tool for 0.01 USDC.' });

    next = 'refused';
    expect((await tool(s.app, t, 'hire_agent', { url: 'https://seller.example/price' })).structuredContent).toEqual({ error: 'offer_refused' });
    next = 'unknown';
    expect((await tool(s.app, t, 'hire_agent', { url: 'https://seller.example/price' })).structuredContent).toMatchObject({ error: 'seller_failed', payment: 'unknown', paid_usdc: '0.01' });
    next = 'throws';
    expect((await tool(s.app, t, 'hire_agent', { url: 'https://seller.example/price' })).structuredContent).toMatchObject({ error: 'hire_failed', payment: 'unknown' });

    const before = asked.length;
    expect((await tool(s.app, t, 'hire_agent', { url: 'http://seller.example/x' })).structuredContent).toEqual({ error: 'bad_url' });
    expect((await tool(s.app, t, 'hire_agent', { url: 'https://seller.example/x', max_usdc: '0.06' })).structuredContent).toEqual({ error: 'bad_max_usdc' });
    expect((await tool(s.app, t, 'hire_agent', { url: 'https://seller.example/x', max_usdc: '-1' })).structuredContent).toEqual({ error: 'bad_max_usdc' });
    const other = await activeAgent(sql);
    expect((await tool(s.app, t, 'hire_agent', { agent: other.agentId, url: 'https://seller.example/x' })).structuredContent).toEqual({ error: 'not_found' });
    s.kill();
    expect((await tool(s.app, t, 'hire_agent', { url: 'https://seller.example/x' })).structuredContent).toEqual({ error: 'killed' });
    expect(asked.length).toBe(before);
  });
});
