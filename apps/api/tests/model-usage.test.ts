/**
 * The usage ledger (app.model_usage): one row per model call, written at the single point where usage is metered
 * (the middleware in runLoop), with the real dollar cost OpenRouter reports. Fakes use realistic magnitudes.
 */
import { afterAll, beforeAll, describe, expect, it, setDefaultTimeout } from 'bun:test';
import { tool } from 'ai';
import { z } from 'zod';
import { createBuilder } from '../src/builder/index.js';
import { xlmDrop } from '../src/builder/examples.js';
import { createBuilderLimits } from '../src/builder/limits.js';
import { createSuggest } from '../src/builder/suggest.js';
import { createTrial } from '../src/builder/trial.js';
import type { Db } from '../src/db/index.js';
import { createRunner } from '../src/loop/index.js';
import { costOf, createLedger, type ModelCall } from '../src/loop/ledger.js';
import { createModels, MODEL_IDS } from '../src/loop/models.js';
import { runLoop, type Budget } from '../src/loop/run.js';
import { createPolicy } from '../src/policy/index.js';
import { createRuns } from '../src/runs/index.js';
import { createChecks } from '../src/runs/checks.js';
import { createSpecs } from '../src/specs/index.js';
import { freshDb } from './support/db.js';
import { loopingModel, scriptedModel } from './support/models.js';
import { minimalSpec, activeAgent } from './support/specs.js';
import { createToolbox } from '../src/tools/index.js';
import { fakeSafeFetch } from './support/safe-fetch.js';

setDefaultTimeout(30_000);

const B: Budget = { maxTokens: 1e6, maxToolCalls: 100, maxSteps: 50, wallClockMs: 5000, maxOutputTokens: 4000 };
const msgs = [{ role: 'user' as const, content: 'x' }];
const ping = tool({ description: 'p', inputSchema: z.object({}), execute: async () => 'p' });
const SONNET = 'anthropic/claude-sonnet-5.5';
const OPUS = 'anthropic/claude-opus-5.5';
const FLASH = 'deepseek/deepseek-v4.1-flash';

type Row = { kind: string; model: string; input_tokens: number; output_tokens: number; cost_usd: string | null; agent_id: string | null; user_id: string | null; run_id: string | null; anon: boolean };

describe('cost from the provider', () => {
  it('costOf reads providerMetadata.openrouter.usage.cost and nothing else', () => {
    expect(costOf({ openrouter: { usage: { cost: 0.004215 } } })).toBe(0.004215);
    expect(costOf({ openrouter: { usage: { cost: 0 } } })).toBe(0);
    for (const bad of [undefined, {}, { openrouter: {} }, { openrouter: { usage: {} } }, { openrouter: { usage: { cost: '0.1' } } }, { openrouter: { usage: { cost: -1 } } }, { openrouter: { usage: { cost: Number.NaN } } }, { openrouter: { usage: { cost: 1e12 } } }]) {
      expect(costOf(bad as never)).toBeNull();
    }
  });

  it('the real OpenRouter provider asks for usage accounting and surfaces usage.cost on the finish chunk runLoop meters', async () => {
    const bodies: { usage?: unknown; stream_options?: unknown }[] = [];
    // The shape OpenRouter streams: the last chunk before [DONE] carries usage, with cost in credits (USD).
    const sse = [
      { id: 'gen-1', model: SONNET, choices: [{ index: 0, delta: { role: 'assistant', content: 'hi' }, finish_reason: null }] },
      { id: 'gen-1', model: SONNET, choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] },
      { id: 'gen-1', model: SONNET, choices: [], usage: { prompt_tokens: 1200, completion_tokens: 80, total_tokens: 1280, cost: 0.004215, cost_details: { upstream_inference_cost: 0.004 }, prompt_tokens_details: { cached_tokens: 300 } } },
    ]
      .map((c) => `data: ${JSON.stringify(c)}\n\n`)
      .join('') + 'data: [DONE]\n\n';
    const fake = (async (_u: unknown, init?: RequestInit) => {
      bodies.push(JSON.parse(String(init?.body)));
      return new Response(sse, { status: 200, headers: { 'content-type': 'text/event-stream' } });
    }) as unknown as typeof fetch;
    const models = createModels({ OPENROUTER_API_KEY: 'sk-or-test' }, { fetch: fake });
    const calls: ModelCall[] = [];
    const r = await runLoop({ model: models.run, system: 's', messages: msgs, tools: {}, budget: B, record: async (c) => void calls.push(c) });
    expect(r.stop).toBe('done');
    expect(bodies[0]!.usage).toEqual({ include: true });
    expect(calls).toEqual([{ model: MODEL_IDS.run, inputTokens: 1200, outputTokens: 80, cacheReadTokens: 300, cacheWriteTokens: 0, costUsd: 0.004215 }]);
  });

  it('a BYOK call costs OpenRouter fee + the upstream bill: cost 0 with is_byok is not a free call', async () => {
    // Verbatim shape of a live Opus chunk on 2026-10-16 (Anthropic through Kerem's own key on OpenRouter): cost 0, the money is upstream.
    const sse = [
      { id: 'gen-2', model: OPUS, provider: 'Anthropic', choices: [{ index: 0, delta: { role: 'assistant', content: 'hi' }, finish_reason: null }] },
      {
        id: 'gen-2', model: OPUS, provider: 'Anthropic', choices: [{ index: 0, delta: { content: '', role: 'assistant' }, finish_reason: 'length', native_finish_reason: 'max_tokens' }],
        usage: {
          prompt_tokens: 3528, completion_tokens: 477, total_tokens: 4005, cost: 0, is_byok: true,
          prompt_tokens_details: { cached_tokens: 0, cache_write_tokens: 0, audio_tokens: 0, video_tokens: 0 },
          cost_details: { upstream_inference_cost: 0.023565, upstream_inference_prompt_cost: 0.01764, upstream_inference_completions_cost: 0.011925 },
          completion_tokens_details: { reasoning_tokens: 0, image_tokens: 0, audio_tokens: 0 },
        },
      },
    ]
      .map((c) => `data: ${JSON.stringify(c)}\n\n`)
      .join('') + 'data: [DONE]\n\n';
    const fake = (async () => new Response(sse, { status: 200, headers: { 'content-type': 'text/event-stream' } })) as unknown as typeof fetch;
    const models = createModels({ OPENROUTER_API_KEY: 'sk-or-test' }, { fetch: fake });
    const calls: ModelCall[] = [];
    await runLoop({ model: models.builder, system: 's', messages: msgs, tools: {}, budget: B, record: async (c) => void calls.push(c) });
    expect(calls.map((c) => c.costUsd)).toEqual([0.023565]);
  });

  it('costOf adds the upstream bill only for BYOK (otherwise cost already includes it)', () => {
    const meta = (cost: number | undefined, upstream?: number) => ({ openrouter: { usage: { ...(cost === undefined ? {} : { cost }), ...(upstream === undefined ? {} : { costDetails: { upstreamInferenceCost: upstream } }) } } });
    expect(costOf(meta(0, 0.02), { is_byok: true })).toBe(0.02);
    expect(costOf(meta(0.001, 0.02), { is_byok: true })).toBeCloseTo(0.021, 9);
    expect(costOf(meta(undefined, 0.02), { is_byok: true })).toBe(0.02);
    expect(costOf(meta(0.0042, 0.004), { is_byok: false })).toBe(0.0042);
    expect(costOf(meta(0.0042, 0.004))).toBe(0.0042);
    expect(costOf(meta(undefined, undefined), { is_byok: true })).toBeNull();
  });
});

describe('runLoop record', () => {
  it('records every model call with its own tokens and cost', async () => {
    const calls: ModelCall[] = [];
    const m = loopingModel('ping', 2, 1, { cost: 0.0123, modelId: SONNET });
    await runLoop({ model: m, system: 's', messages: msgs, tools: { ping }, budget: B, record: async (c) => void calls.push(c) });
    expect(calls).toEqual([
      { model: SONNET, inputTokens: 1000, outputTokens: 100, cacheReadTokens: 0, cacheWriteTokens: 0, costUsd: 0.0123 },
      { model: SONNET, inputTokens: 1000, outputTokens: 100, cacheReadTokens: 0, cacheWriteTokens: 0, costUsd: 0.0123 },
      { model: SONNET, inputTokens: 1000, outputTokens: 50, cacheReadTokens: 0, cacheWriteTokens: 0, costUsd: 0.0123 },
    ]);
  });

  it('a provider that sends no cost records tokens with a null cost', async () => {
    const calls: ModelCall[] = [];
    await runLoop({ model: scriptedModel([{ text: 'ok' }]), system: 's', messages: msgs, tools: {}, budget: B, record: async (c) => void calls.push(c) });
    expect(calls.map((c) => c.costUsd)).toEqual([null]);
  });

  it('a throwing record never breaks the run', async () => {
    const r = await runLoop({
      model: loopingModel('ping', 1, 1, { cost: 0.01 }), system: 's', messages: msgs, tools: { ping }, budget: B,
      record: async () => {
        throw new Error('db down');
      },
    });
    expect(r.stop).toBe('done');
    expect(r.usage.steps).toBe(2);
  });
});

describe('createLedger', () => {
  it('a write failure is logged by name and code only, and never thrown', async () => {
    const logs: Record<string, unknown>[] = [];
    const broken = (() => {
      throw Object.assign(new Error('connection to postgres://u:SECRET@host failed'), { errno: '08006', code: 'ERR_POSTGRES_CONNECTION_CLOSED' });
    }) as unknown as Db;
    const ledger = createLedger(broken, { log: (e) => logs.push(e) });
    await ledger.record({ kind: 'chat' }, { model: SONNET, inputTokens: 1, outputTokens: 1, cacheReadTokens: 0, cacheWriteTokens: 0, costUsd: 0.1 });
    expect(logs).toHaveLength(1);
    expect(logs[0]).toMatchObject({ event: 'usage_ledger_failed', kind: 'chat', name: 'Error', code: '08006' });
    expect(JSON.stringify(logs)).not.toContain('SECRET');
  });
});

describe('the ledger, per kind', () => {
  let sql: Db;
  let drop: () => Promise<void>;
  const logs: Record<string, unknown>[] = [];
  beforeAll(async () => {
    ({ sql, drop } = await freshDb());
  });
  afterAll(() => drop());
  const ledger = () => createLedger(sql, { log: (e) => logs.push(e) });
  const rows = async (where: { agent?: string; user?: string } = {}) =>
    (await sql`select kind, model, input_tokens, output_tokens, cost_usd::text as cost_usd, agent_id, user_id, run_id, anon from app.model_usage
               where (${where.agent ?? null}::uuid is null or agent_id = ${where.agent ?? null}) and (${where.user ?? null}::uuid is null or user_id = ${where.user ?? null}) order by id`) as Row[];

  it('chat, mission and service runs: one row per model call with agent, user and the run id', async () => {
    const a = await activeAgent(sql);
    const runs = createRuns(sql);
    for (const mode of ['chat', 'mission', 'service'] as const) {
      const runner = createRunner({ runs, policy: createPolicy(sql, { killSwitch: false }), model: loopingModel('ping', 1, 1, { cost: 0.0421, modelId: SONNET }), modelId: SONNET, ledger: ledger() });
      const out = await runner.run({ agentId: a.agentId, userId: a.userId, mode, system: 's', messages: msgs, tools: { ping } });
      const got = (await rows({ agent: a.agentId })).filter((r) => r.run_id === out.runId);
      expect(got).toHaveLength(2); // a tool step and the answer
      expect(got[0]).toEqual({ kind: mode, model: SONNET, input_tokens: 1000, output_tokens: 100, cost_usd: '0.042100', agent_id: a.agentId, user_id: a.userId, run_id: out.runId, anon: false });
    }
    expect(await rows({ agent: a.agentId })).toHaveLength(6);
  });

  it('a capped run (zero model calls) writes nothing', async () => {
    const a = await activeAgent(sql);
    const runner = createRunner({ runs: createRuns(sql), policy: createPolicy(sql, { killSwitch: true }), model: loopingModel('ping', 1), modelId: SONNET, ledger: ledger() });
    await runner.run({ agentId: a.agentId, userId: a.userId, mode: 'chat', system: 's', messages: msgs, tools: { ping } });
    expect(await rows({ agent: a.agentId })).toHaveLength(0);
  });

  it('a failing ledger does not break a run', async () => {
    const a = await activeAgent(sql);
    const broken = createLedger((() => {
      throw new Error('down');
    }) as unknown as Db, { log: (e) => logs.push(e) });
    const before = logs.length;
    const out = await createRunner({ runs: createRuns(sql), policy: createPolicy(sql, { killSwitch: false }), model: loopingModel('ping', 1, 1, { cost: 0.01 }), modelId: SONNET, ledger: broken }).run({ agentId: a.agentId, userId: a.userId, mode: 'chat', system: 's', messages: msgs, tools: { ping } });
    expect(out.status).toBe('done');
    expect(logs.length - before).toBe(2); // both calls failed loudly, neither silently
    expect(logs.at(-1)).toMatchObject({ event: 'usage_ledger_failed', kind: 'chat' });
  });

  it('draft: signed-in carries the user, anonymous is flagged; a repair call is a second row', async () => {
    const good = JSON.stringify(xlmDrop());
    const user = await activeAgent(sql);
    const m = scriptedModel([{ text: 'not json' }, { text: good }], { cost: 0.0831, modelId: OPUS });
    const anon = scriptedModel([{ text: good }], { cost: 0.00012, modelId: FLASH });
    const b = createBuilder({ models: { builder: m, builderAnon: anon }, ledger: ledger() });
    await b.draft({ prompt: 'tell me when XLM drops', userId: user.userId });
    await b.draft({ prompt: 'tell me when XLM drops', anonymous: true });
    const got = await rows({ user: user.userId });
    expect(got.map((r) => [r.kind, r.model, r.cost_usd, r.agent_id, r.anon])).toEqual([
      ['draft', OPUS, '0.083100', null, false],
      ['draft', OPUS, '0.083100', null, false],
    ]);
    const anonRows = (await sql`select kind, model, cost_usd::text as cost_usd, user_id, agent_id, anon from app.model_usage where model = ${FLASH}`) as { kind: string; model: string; cost_usd: string; user_id: string | null; agent_id: string | null; anon: boolean }[];
    expect(anonRows).toEqual([{ kind: 'draft', model: FLASH, cost_usd: '0.000120', user_id: null, agent_id: null, anon: true }]);
  });

  it('edit: a revision of an existing agent is kind edit with the agent', async () => {
    const a = await activeAgent(sql);
    const m = scriptedModel([{ text: JSON.stringify(xlmDrop()) }], { cost: 0.07, modelId: OPUS });
    await createBuilder({ models: { builder: m, builderAnon: m }, ledger: ledger() }).draft({ prompt: 'make it hourly', kind: 'edit', userId: a.userId, agentId: a.agentId });
    expect((await rows({ agent: a.agentId })).map((r) => [r.kind, r.user_id, r.agent_id])).toEqual([['edit', a.userId, a.agentId]]);
  });

  it('trial: signed-in carries the user, anonymous is flagged, neither has an agent', async () => {
    const sf = fakeSafeFetch(() => undefined);
    const toolbox = createToolbox({ safeFetch: sf, memory: { remember: async () => 'saved' }, specs: { skillBody: async () => null }, policy: { delivery: () => true, egress: () => true, paidSearch: () => true, trialSearch: () => true }, webhookSecret: () => 'ab'.repeat(32), mailFrom: 'x@example.com', env: { RESEND_API_KEY: 'k' } });
    const mk = (id: string, cost: number) => createTrial({ model: scriptedModel([{ text: 'Would tell the owner.' }], { cost, modelId: id }), toolbox, sandbox: (async () => ({ ok: true, value: true })) as never, ledger: ledger() });
    const u = await activeAgent(sql);
    await mk(SONNET, 0.031).run({ spec: minimalSpec(), scope: `user:${u.userId}`, userId: u.userId });
    await mk(FLASH, 0.0002).run({ spec: minimalSpec(), scope: 'ip:9' });
    expect((await rows({ user: u.userId })).map((r) => [r.kind, r.model, r.cost_usd, r.agent_id, r.anon])).toEqual([['trial', SONNET, '0.031000', null, false]]);
    const anon = (await sql`select kind, user_id, agent_id, anon from app.model_usage where kind = 'trial' and anon`) as { kind: string; user_id: string | null; agent_id: string | null; anon: boolean }[];
    expect(anon).toEqual([{ kind: 'trial', user_id: null, agent_id: null, anon: true }]);
  });

  it('suggest: carries the owner and the agent', async () => {
    const specs = createSpecs(sql);
    const a = await activeAgent(sql);
    const { name: _n, spec: _s, ...view } = xlmDrop();
    const v = await specs.saveDraft(a.userId, a.agentId, xlmDrop().spec, undefined, view);
    await specs.approve(a.userId, a.agentId, v);
    for (let i = 0; i < 3; i++) await sql`insert into app.check_days (agent_id, day, quiet, fired) values (${a.agentId}, (now() at time zone 'utc')::date - ${i}::int, 5, 0)`;
    const suggestion = { label: 'Sell my XLM price checks to other agents', slug: 'xlm-drop-check', description: 'Tells another agent whether XLM fell sharply recently.', price_usdc: '0.02', input_schema: { type: 'object', properties: { window_s: { type: 'number' } }, required: [] }, output_schema: { type: 'object', properties: { fell: { type: 'boolean' } }, required: ['fell'] }, tools: ['stellar_price_change'] };
    const model = scriptedModel([{ text: JSON.stringify(suggestion) }], { cost: 0.019, modelId: SONNET });
    await createSuggest({ sql, specs, checks: createChecks(sql), model, limits: createBuilderLimits(sql), ledger: ledger() }).get(a.userId, a.agentId);
    expect((await rows({ agent: a.agentId })).map((r) => [r.kind, r.user_id, r.agent_id, r.cost_usd])).toEqual([['suggest', a.userId, a.agentId, '0.019000']]);
  });
});
