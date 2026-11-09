import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import type { Db } from '../src/db/index.js';
import { createRunner, statusFor } from '../src/loop/index.js';
import { createModelDirectory } from '../src/loop/model-choices.js';
import type { Budget } from '../src/loop/run.js';
import { createPolicy, DAILY_RUNS, DAILY_TOKENS } from '../src/policy/index.js';
import { createRuns, type RunMode, type Runs } from '../src/runs/index.js';
import { freshDb } from './support/db.js';
import { failingModel, loopingModel } from './support/models.js';
import { activeAgent } from './support/specs.js';
import { tool, type ToolSet } from 'ai';
import { z } from 'zod';

const ping = tool({ description: 'p', inputSchema: z.object({}), execute: async () => 'p' });
const msgs = [{ role: 'user' as const, content: 'hi' }];

describe('runner', () => {
  let sql: Db;
  let drop: () => Promise<void>;
  let runs: Runs;
  beforeAll(async () => {
    ({ sql, drop } = await freshDb());
    runs = createRuns(sql);
  });
  afterAll(() => drop());
  const tokens = async (userId: string) => ((await sql`select daily_tokens from app.users where id = ${userId}`) as { daily_tokens: number }[])[0]!.daily_tokens;

  it('records the model id the runner was given', async () => {
    const a = await activeAgent(sql);
    const policy = createPolicy(sql, { killSwitch: false });
    const withId = await createRunner({ runs, policy, model: loopingModel('ping', 0), modelId: 'anthropic/claude-sonnet-5.5' }).run({ agentId: a.agentId, userId: a.userId, mode: 'chat', system: 's', messages: msgs, tools: { ping } });
    expect((await runs.get(withId.runId))!.model).toBe('anthropic/claude-sonnet-5.5');
  });

  it("runs on the agent's listed pick, records it, and charges its tokens times the model's weight", async () => {
    const a = await activeAgent(sql);
    const policy = createPolicy(sql, { killSwitch: false });
    const made: string[] = [];
    const runner = createRunner({
      runs, policy, model: failingModel(), modelId: 'deepseek/deepseek-v4.1-flash',
      modelFor: async () => 'anthropic/claude-sonnet-5.5',
      models: createModelDirectory({ defaultId: 'deepseek/deepseek-v4.1-flash' }),
      chat: (id) => (made.push(id), loopingModel('ping', 1)),
    });
    const before = await tokens(a.userId);
    const out = await runner.run({ agentId: a.agentId, userId: a.userId, mode: 'chat', system: 's', messages: msgs, tools: { ping } });
    expect(out.status).toBe('done');
    expect((await runs.get(out.runId))!.model).toBe('anthropic/claude-sonnet-5.5');
    const charged = (await tokens(a.userId)) - before;
    expect(charged).toBeGreaterThanOrEqual(out.usage.inputTokens * 26.5 + out.usage.outputTokens * 26.5 - 1);
    expect(charged).toBeLessThanOrEqual((out.usage.inputTokens + out.usage.outputTokens) * 26.5 + out.usage.steps);
    await runner.run({ agentId: a.agentId, userId: a.userId, mode: 'chat', system: 's', messages: msgs, tools: { ping } });
    expect(made).toEqual(['anthropic/claude-sonnet-5.5']);
  });

  it('falls back to the default model on no pick, an unlisted pick or a failed lookup', async () => {
    const a = await activeAgent(sql);
    const policy = createPolicy(sql, { killSwitch: false });
    for (const modelFor of [async () => null, async () => 'openai/gpt-5.4-pro', async (): Promise<string | null> => { throw new Error('db'); }]) {
      const runner = createRunner({ runs, policy, model: loopingModel('ping', 0), modelId: 'deepseek/deepseek-v4.1-flash', modelFor, models: createModelDirectory({ defaultId: 'deepseek/deepseek-v4.1-flash' }), chat: () => failingModel() });
      const out = await runner.run({ agentId: a.agentId, userId: a.userId, mode: 'chat', system: 's', messages: msgs, tools: { ping } });
      expect(out.status).toBe('done');
      expect((await runs.get(out.runId))!.model).toBe('deepseek/deepseek-v4.1-flash');
    }
  });

  it('maps stops to run statuses', () => {
    expect(['done', 'length', 'tokens', 'tool_calls', 'steps', 'timeout', 'aborted', 'error'].map((s) => statusFor(s as never))).toEqual(['done', 'done', 'budget', 'budget', 'budget', 'budget', 'error', 'error']);
  });

  it('records a finished run with usage and redacted steps, and charges the user', async () => {
    const a = await activeAgent(sql);
    const progress: number[] = [];
    const spy: Pick<Runs, 'start' | 'progress' | 'finish'> = { ...runs, progress: async (id, u, s) => (progress.push(u.steps), runs.progress(id, u, s)) };
    const runner = createRunner({ runs: spy, policy: createPolicy(sql, { killSwitch: false }), model: loopingModel('ping', 1), modelId: 'test/model' });
    const out = await runner.run({ agentId: a.agentId, userId: a.userId, mode: 'chat', system: 's', messages: msgs, tools: { ping } });
    expect(out).toMatchObject({ status: 'done', stop: 'done', text: 'done', usage: { inputTokens: 2000, outputTokens: 150, toolCalls: 1, steps: 2 } });
    expect(progress).toEqual([1, 2]);
    expect(await runs.get(out.runId)).toMatchObject({ mode: 'chat', status: 'done', stopReason: 'done', inputTokens: 2000, outputTokens: 150, toolCalls: 1 });
    expect((await runs.get(out.runId))!.steps.map((s) => s.tools)).toEqual([['ping'], []]);
    expect(await tokens(a.userId)).toBe(2150);
  });

  it('builds tools from the run id when given a function', async () => {
    const a = await activeAgent(sql);
    let seen = '';
    const out = await createRunner({ runs, policy: createPolicy(sql, { killSwitch: false }), model: loopingModel('ping', 1), modelId: 'test/model' }).run({
      agentId: a.agentId, userId: a.userId, mode: 'chat', system: 's', messages: msgs, tools: (runId) => ((seen = runId), { ping }),
    });
    expect(seen).toBe(out.runId);
    expect(out.usage.toolCalls).toBe(1);
  });

  it('a throwing tools function ends as an error outcome, never a throw', async () => {
    const a = await activeAgent(sql);
    const out = await createRunner({ runs, policy: createPolicy(sql, { killSwitch: false }), model: loopingModel('ping', 1), modelId: 'test/model' }).run({
      agentId: a.agentId, userId: a.userId, mode: 'chat', system: 's', messages: msgs, tools: () => { throw new Error('boom'); },
    });
    expect(out).toMatchObject({ status: 'error', stop: 'error' });
  });

  it('the kill switch records a capped run and calls no model', async () => {
    const a = await activeAgent(sql);
    const m = loopingModel('ping', 1);
    const out = await createRunner({ runs, policy: createPolicy(sql, { killSwitch: true }), model: m, modelId: 'test/model' }).run({ agentId: a.agentId, userId: a.userId, mode: 'mission', system: 's', messages: msgs, tools: {} });
    expect(out).toMatchObject({ status: 'capped', stop: 'killed', text: '' });
    expect(m.calls()).toBe(0);
    expect(await runs.get(out.runId)).toMatchObject({ status: 'capped', stopReason: 'killed', mode: 'mission' });
  });

  it('a user over the daily run cap gets a capped run and no model call', async () => {
    const a = await activeAgent(sql);
    await sql`update app.users set daily_runs = ${DAILY_RUNS}, daily_reset_at = date_trunc('day', now(), 'UTC') where id = ${a.userId}`;
    const m = loopingModel('ping', 1);
    const out = await createRunner({ runs, policy: createPolicy(sql, { killSwitch: false }), model: m, modelId: 'test/model' }).run({ agentId: a.agentId, userId: a.userId, mode: 'chat', system: 's', messages: msgs, tools: {} });
    expect(out).toMatchObject({ status: 'capped', stop: 'user_cap' });
    expect(m.calls()).toBe(0);
  });

  it('charges every step and stops the run once the user crosses the daily token cap (D12 revised)', async () => {
    const a = await activeAgent(sql);
    await sql`update app.users set daily_tokens = ${DAILY_TOKENS - 100}, daily_reset_at = date_trunc('day', now(), 'UTC') where id = ${a.userId}`;
    const m = loopingModel('ping', 3);
    const out = await createRunner({ runs, policy: createPolicy(sql, { killSwitch: false }), model: m, modelId: 'test/model' }).run({ agentId: a.agentId, userId: a.userId, mode: 'chat', system: 's', messages: msgs, tools: { ping } });
    expect(out).toMatchObject({ status: 'capped', stop: 'user_cap' });
    expect(m.calls()).toBe(1);
    expect(await runs.get(out.runId)).toMatchObject({ status: 'capped', stopReason: 'user_cap' });
    expect(await tokens(a.userId)).toBeGreaterThanOrEqual(DAILY_TOKENS);
  });

  it('a final text step that crosses the cap still ends done (nothing is cut short)', async () => {
    const a = await activeAgent(sql);
    await sql`update app.users set daily_tokens = ${DAILY_TOKENS - 100}, daily_reset_at = date_trunc('day', now(), 'UTC') where id = ${a.userId}`;
    const m = loopingModel('ping', 0);
    const out = await createRunner({ runs, policy: createPolicy(sql, { killSwitch: false }), model: m, modelId: 'test/model' }).run({ agentId: a.agentId, userId: a.userId, mode: 'chat', system: 's', messages: msgs, tools: { ping } });
    expect(out).toMatchObject({ status: 'done', stop: 'done', text: 'done' });
    expect(await tokens(a.userId)).toBeGreaterThanOrEqual(DAILY_TOKENS);
  });

  it('a budget stop and a model error are recorded as budget and error, usage kept', async () => {
    const a = await activeAgent(sql);
    const policy = createPolicy(sql, { killSwitch: false });
    const capped = await createRunner({ runs, policy, model: loopingModel('ping'), modelId: 'test/model', budgets: { mission: { maxTokens: 1e6, maxOutputTokens: 4000, maxToolCalls: 2, maxSteps: 50, wallClockMs: 5000 } } }).run({
      agentId: a.agentId, userId: a.userId, mode: 'mission', system: 's', messages: msgs, tools: { ping },
    });
    expect(capped).toMatchObject({ status: 'budget', stop: 'tool_calls' });
    expect(await runs.get(capped.runId)).toMatchObject({ status: 'budget', stopReason: 'tool_calls', inputTokens: 3000, toolCalls: 2 }); // 2 tool steps + the no-tools answer step
    const failed = await createRunner({ runs, policy, model: failingModel(), modelId: 'test/model' }).run({ agentId: a.agentId, userId: a.userId, mode: 'chat', system: 's', messages: msgs, tools: {} });
    expect(failed).toMatchObject({ status: 'error', stop: 'error' });
    expect(await runs.get(failed.runId)).toMatchObject({ status: 'error', stopReason: 'error' });
  });

  describe('metered = consumed (every model call is metered from the provider usage chunk, D12)', () => {
    const slow = tool({ description: 's', inputSchema: z.object({}), execute: (_i, o) => new Promise((res, rej) => (o.abortSignal?.addEventListener('abort', () => rej(new Error('aborted'))), setTimeout(res, 3000))) });
    /** A tool turn costs 1000 in / 100 out per model call, however many parallel calls it carries. */
    async function metered(m: ReturnType<typeof loopingModel>, o: { tools: ToolSet; budget?: Budget; signal?: AbortSignal; mode?: RunMode }) {
      const a = await activeAgent(sql);
      let charged = 0;
      const real = createPolicy(sql, { killSwitch: false });
      const policy = { ...real, chargeTokens: async (u: string, t: number) => ((charged += t), real.chargeTokens(u, t)) };
      const mode = o.mode ?? 'mission';
      const out = await createRunner({ runs, policy, model: m, modelId: 'test/model', ...(o.budget ? { budgets: { [mode]: o.budget } } : {}) }).run({
        agentId: a.agentId, userId: a.userId, mode, system: 's', messages: msgs, tools: o.tools, ...(o.signal ? { signal: o.signal } : {}),
      });
      const consumed = m.calls() * 1100;
      expect(out.usage.inputTokens + out.usage.outputTokens).toBe(consumed);
      expect(charged).toBe(consumed);
      expect(await tokens(a.userId)).toBe(consumed);
      expect(out.usage.steps).toBe(m.calls());
      const row = await runs.get(out.runId);
      expect(row!.inputTokens + row!.outputTokens).toBe(consumed);
      return { out, m };
    }
    const B: Budget = { maxTokens: 1e6, maxOutputTokens: 4000, maxToolCalls: 100, maxSteps: 50, wallClockMs: 5000 };

    it('tool cap, sequential', async () => {
      const { out, m } = await metered(loopingModel('ping'), { tools: { ping }, budget: { ...B, maxToolCalls: 3 } });
      expect(out.stop).toBe('tool_calls');
      expect(m.calls()).toBe(4); // 3 tool steps + the no-tools answer step
      expect(out.usage).toMatchObject({ inputTokens: 4000, outputTokens: 400, toolCalls: 3 });
    });

    it('tool cap, parallel calls in one step (aborts during tools, no step end)', async () => {
      const { out, m } = await metered(loopingModel('ping', 100, 3), { tools: { ping }, budget: { ...B, maxToolCalls: 2 } });
      expect(out).toMatchObject({ status: 'budget', stop: 'tool_calls' });
      expect(m.calls()).toBe(1);
      expect(out.usage.toolCalls).toBe(2); // the refused third call is not counted
    });

    it('timeout during a slow tool', async () => {
      const { out } = await metered(loopingModel('slow'), { tools: { slow }, budget: { ...B, wallClockMs: 150 } });
      expect(out.stop).toBe('timeout');
    });

    it('external abort during a tool', async () => {
      const ac = new AbortController();
      const abortTool = tool({ description: 'a', inputSchema: z.object({}), execute: async () => (ac.abort(), 'p') });
      const { out } = await metered(loopingModel('abortTool', 100, 3), { tools: { abortTool }, signal: ac.signal });
      expect(out.stop).toBe('aborted');
    });
  });

  describe('faults never leave a run running', () => {
    const policy = () => createPolicy(sql, { killSwitch: false });

    it('a chargeTokens throw stops the run as error, on a tool step', async () => {
      const a = await activeAgent(sql);
      const m = loopingModel('ping');
      const p = { ...policy(), chargeTokens: async () => Promise.reject(new Error('db down')) };
      const out = await createRunner({ runs, policy: p, model: m, modelId: 'test/model' }).run({ agentId: a.agentId, userId: a.userId, mode: 'chat', system: 's', messages: msgs, tools: { ping } });
      expect(out).toMatchObject({ status: 'error', stop: 'error' });
      expect(m.calls()).toBe(1);
      expect(await runs.get(out.runId)).toMatchObject({ status: 'error', stopReason: 'error' });
    });

    it('a chargeTokens throw on the final step is still an error', async () => {
      const a = await activeAgent(sql);
      const p = { ...policy(), chargeTokens: async () => Promise.reject(new Error('db down')) };
      const out = await createRunner({ runs, policy: p, model: loopingModel('ping', 0), modelId: 'test/model' }).run({ agentId: a.agentId, userId: a.userId, mode: 'chat', system: 's', messages: msgs, tools: { ping } });
      expect(out).toMatchObject({ status: 'error', stop: 'error' });
      expect(await runs.get(out.runId)).toMatchObject({ status: 'error', stopReason: 'error' });
    });

    it('admitRun throwing finishes the row as error and returns an outcome', async () => {
      const a = await activeAgent(sql);
      const m = loopingModel('ping', 1);
      const p = { ...policy(), admitRun: async () => Promise.reject(new Error('db down')) };
      const out = await createRunner({ runs, policy: p, model: m, modelId: 'test/model' }).run({ agentId: a.agentId, userId: a.userId, mode: 'chat', system: 's', messages: msgs, tools: {} });
      expect(out).toMatchObject({ status: 'error', stop: 'error' });
      expect(m.calls()).toBe(0);
      expect(await runs.get(out.runId)).toMatchObject({ status: 'error', stopReason: 'error' });
    });

    it('finish throwing on its first call is retried as error and the usage is kept', async () => {
      const a = await activeAgent(sql);
      let n = 0;
      const spy: Pick<Runs, 'start' | 'progress' | 'finish'> = { ...runs, finish: async (id, r) => (++n === 1 ? Promise.reject(new Error('db down')) : runs.finish(id, r)) };
      const out = await createRunner({ runs: spy, policy: policy(), model: loopingModel('ping', 1), modelId: 'test/model' }).run({ agentId: a.agentId, userId: a.userId, mode: 'chat', system: 's', messages: msgs, tools: { ping } });
      expect(out).toMatchObject({ status: 'error', stop: 'error', usage: { inputTokens: 2000, outputTokens: 150 } });
      expect(await runs.get(out.runId)).toMatchObject({ status: 'error', stopReason: 'error', inputTokens: 2000 });
    });
  });
});
