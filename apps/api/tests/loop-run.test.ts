import { splitDetails } from '../src/loop/call-detail.js';
import { describe, expect, it } from 'bun:test';
import { tool } from 'ai';
import { z } from 'zod';
import { BUDGETS } from '../src/loop/budgets.js';
import { createModels, MODEL_IDS } from '../src/loop/models.js';
import { runLoop, type Budget } from '../src/loop/run.js';
import { failingModel, loopingModel, scriptedModel } from './support/models.js';

const ping = (f: (i: unknown, o: { abortSignal?: AbortSignal }) => Promise<unknown> = async () => 'p') => tool({ description: 'p', inputSchema: z.object({}), execute: f });
const B: Budget = { maxTokens: 1e6, maxToolCalls: 100, maxSteps: 50, wallClockMs: 5000, maxOutputTokens: 4000 };
const msgs = [{ role: 'user' as const, content: 'x' }];

describe('runLoop step calls', () => {
  it('keeps at most 8 calls per step and marks the rest', async () => {
    const m = scriptedModel([{ tool: 'ping', parallel: 11 }, { text: 'ok' }]);
    const r = await runLoop({ model: m, system: 's', messages: msgs, tools: { ping: ping() }, budget: B });
    expect(r.steps[0]!.tools.length).toBe(11);
    expect(r.steps[0]!.calls!.length).toBe(9);
    expect(r.steps[0]!.calls![8]).toEqual({ tool: 'more', line: null });
    const few = await runLoop({ model: scriptedModel([{ tool: 'ping', parallel: 8 }, { text: 'ok' }]), system: 's', messages: msgs, tools: { ping: ping() }, budget: B });
    expect(few.steps[0]!.calls!.length).toBe(8);
  });

  it('records a plain line per call, only for calls that returned', async () => {
    const mail = tool({ description: 'm', inputSchema: z.object({ subject: z.string(), text: z.string() }), execute: async () => ({ sent: true }) });
    const search = tool({ description: 's', inputSchema: z.object({ query: z.string() }), execute: async () => ({ results: [] }) });
    const bad = tool({ description: 'b', inputSchema: z.object({ subject: z.string(), text: z.string() }), execute: async (): Promise<unknown> => { throw new Error('nope'); } });
    const m = scriptedModel([{ tool: 'send_email', input: { subject: 'Hi there', text: 'secret body to bob@example.com' } }, { tool: 'web_search', input: { query: 'xlm news' }, parallel: 1 }, { text: 'ok' }]);
    const r = await runLoop({ model: m, system: 's', messages: msgs, tools: { send_email: mail, web_search: search }, budget: B });
    // The detail (what the call was about) rides along in memory; storage splits it off the redacted steps (runs.call_details).
    expect(r.steps.map((s) => s.calls)).toEqual([
      [{ tool: 'send_email', line: 'Emailed you: "Hi there"', detail: { subject: 'Hi there', body: 'secret body to bob@example.com' } }],
      [{ tool: 'web_search', line: 'Searched the web for "xlm news"', detail: { query: 'xlm news' } }],
      undefined,
    ]);
    expect(JSON.stringify(splitDetails(r.steps).steps)).not.toContain('bob@example.com');
    const f = await runLoop({ model: scriptedModel([{ tool: 'send_email', input: { subject: 'Hi', text: 'x' } }, { text: 'ok' }]), system: 's', messages: msgs, tools: { send_email: bad }, budget: B });
    expect(f.steps[0]!.calls).toEqual([{ tool: 'send_email', line: null }]);
  });
});

describe('runLoop tool events', () => {
  it('tells each call as it starts and ends, by name and state only', async () => {
    const seen: unknown[] = [];
    const bad = tool({ description: 'b', inputSchema: z.object({}), execute: async (): Promise<unknown> => { throw new Error('secret failure'); } });
    const m = scriptedModel([{ tool: 'ping' }, { tool: 'bad' }, { text: 'ok' }]);
    const r = await runLoop({ model: m, system: 's', messages: msgs, tools: { ping: ping(), bad }, budget: B, onTool: (e) => seen.push(e) });
    expect(r.stop).toBe('done');
    expect(seen).toEqual([
      { id: 1, name: 'ping', state: 'running' },
      { id: 1, name: 'ping', state: 'done' },
      { id: 2, name: 'bad', state: 'running' },
      { id: 2, name: 'bad', state: 'failed' },
    ]);
  });

  it('says nothing of a tool the model made up', async () => {
    const seen: unknown[] = [];
    await runLoop({ model: scriptedModel([{ tool: 'nope' }, { text: 'ok' }]), system: 's', messages: msgs, tools: { ping: ping() }, budget: B, onTool: (e) => seen.push(e) });
    expect(seen).toEqual([]);
  });
});

describe('runLoop (verified shape from spikes/ai-sdk, on streamText)', () => {
  it('runs to done, streams text, meters every step', async () => {
    const deltas: string[] = [];
    const r = await runLoop({ model: loopingModel('ping', 1), system: 's', messages: msgs, tools: { ping: ping() }, budget: B, onDelta: (d) => deltas.push(d) });
    expect(r.stop).toBe('done');
    expect(r.text).toBe('done');
    expect(deltas).toEqual(['done']);
    expect(r.usage).toEqual({ inputTokens: 2000, outputTokens: 150, cacheReadTokens: 0, cacheWriteTokens: 0, steps: 2, toolCalls: 1 });
    expect(r.steps).toEqual([
      { n: 1, tools: ['ping'], calls: [{ tool: 'ping', line: null }], inputTokens: 1000, outputTokens: 100, finishReason: 'tool-calls' },
      { n: 2, tools: [], inputTokens: 1000, outputTokens: 50, finishReason: 'stop' },
    ]);
  });

  it('caps output tokens on every model call (an uncapped step streams unmetered until the wall clock)', async () => {
    const m = loopingModel('ping', 2);
    await runLoop({ model: m, system: 's', messages: msgs, tools: { ping: ping() }, budget: { ...B, maxOutputTokens: 1234 } });
    expect(m.doStreamCalls.length).toBe(3);
    expect(m.doStreamCalls.map((c) => c.maxOutputTokens)).toEqual([1234, 1234, 1234]);
  });

  it('stops at 85% of the token budget', async () => {
    const m = loopingModel('ping');
    const r = await runLoop({ model: m, system: 's', messages: msgs, tools: { ping: ping() }, budget: { ...B, maxTokens: 3500 } });
    expect(r.stop).toBe('tokens'); // 2 steps = 2200 < 2975; the 3rd reaches 3300
    expect(m.calls()).toBe(3);
  });

  it('stops at the step cap', async () => {
    const r = await runLoop({ model: loopingModel('ping'), system: 's', messages: msgs, tools: { ping: ping() }, budget: { ...B, maxSteps: 4 } });
    expect([r.stop, r.usage.steps]).toEqual(['steps', 4]);
  });

  it('at the tool-call cap the next step runs with no tools and is the last; a 3rd call cannot execute', async () => {
    const m = loopingModel('ping');
    let executed = 0;
    const r = await runLoop({ model: m, system: 's', messages: msgs, tools: { ping: ping(async () => (executed++, 'p')) }, budget: { ...B, maxToolCalls: 2 } });
    expect(r.stop).toBe('tool_calls'); // the model still wanted a tool in its answer step
    expect(m.calls()).toBe(3); // 2 tool steps + one answer step, never a 4th
    expect(m.doStreamCalls.map((c) => c.toolChoice?.type ?? 'auto')).toEqual(['auto', 'auto', 'none']);
    expect(m.doStreamCalls.map((c) => (c.tools ?? []).length)).toEqual([1, 1, 1]); // tools stay defined for the tool history
    expect(executed).toBe(2);
    expect(r.usage).toMatchObject({ steps: 3, toolCalls: 2, inputTokens: 3000 });
  });

  it('tool, tool, then an answer ends done (the cap does not eat the answer step)', async () => {
    const m = scriptedModel([{ tool: 'ping' }, { tool: 'ping' }, { text: 'answer' }]);
    const r = await runLoop({ model: m, system: 's', messages: msgs, tools: { ping: ping() }, budget: { ...B, maxToolCalls: 2 } });
    expect([r.stop, r.finalText, r.usage.toolCalls, m.calls()]).toEqual(['done', 'answer', 2, 3]);
  });

  it('two parallel calls in one step at the cap, then an answer, ends done', async () => {
    const m = scriptedModel([{ tool: 'ping', parallel: 2 }, { text: 'answer' }]);
    const r = await runLoop({ model: m, system: 's', messages: msgs, tools: { ping: ping() }, budget: { ...B, maxToolCalls: 2 } });
    expect([r.stop, r.finalText, r.usage.toolCalls, m.calls()]).toEqual(['done', 'answer', 2, 2]);
  });

  it('no wasted call when the model answers before the cap, and maxSteps still bounds the run', async () => {
    const m = scriptedModel([{ tool: 'ping' }, { text: 'answer' }]);
    const r = await runLoop({ model: m, system: 's', messages: msgs, tools: { ping: ping() }, budget: { ...B, maxToolCalls: 5 } });
    expect([r.stop, m.calls()]).toEqual(['done', 2]);
    const s = await runLoop({ model: loopingModel('ping'), system: 's', messages: msgs, tools: { ping: ping() }, budget: { ...B, maxToolCalls: 5, maxSteps: 2 } });
    expect([s.stop, s.usage.steps]).toEqual(['steps', 2]);
  });

  it('finalText is the last step only; text keeps every step', async () => {
    const m = scriptedModel([{ narrate: 'Let me check.', tool: 'ping' }, { text: '{"a":1}' }]);
    const r = await runLoop({ model: m, system: 's', messages: msgs, tools: { ping: ping() }, budget: B });
    expect([r.text, r.finalText]).toEqual(['Let me check.{"a":1}', '{"a":1}']);
  });

  it('parallel calls past the cap abort the run and are not counted', async () => {
    const m = loopingModel('ping', 100, 3);
    const r = await runLoop({ model: m, system: 's', messages: msgs, tools: { ping: ping() }, budget: { ...B, maxToolCalls: 2 } });
    expect(r.stop).toBe('tool_calls');
    expect(m.calls()).toBe(1);
    expect(r.usage).toMatchObject({ steps: 1, toolCalls: 2, inputTokens: 1000, outputTokens: 100 });
  });

  it('meters a step cut short by an abort during tools (no step end), once', async () => {
    const used: number[] = [];
    const stepsSeen: number[] = [];
    const r = await runLoop({ model: loopingModel('ping', 100, 3), system: 's', messages: msgs, tools: { ping: ping(async () => Promise.reject(new Error('x'))) }, budget: { ...B, maxToolCalls: 1 }, onUsage: (u) => void used.push(u.inputTokens + u.outputTokens), onStep: (u) => void stepsSeen.push(u.steps) });
    expect(used).toEqual([1100]);
    expect(r.usage.inputTokens + r.usage.outputTokens).toBe(1100);
    expect(stepsSeen).toEqual([]);
  });

  it('an onUsage throw stops the run as error (fail closed), final step included', async () => {
    const r = await runLoop({ model: loopingModel('ping', 0), system: 's', messages: msgs, tools: { ping: ping() }, budget: B, onUsage: () => Promise.reject(new Error('x')) });
    expect([r.stop, r.text]).toEqual(['error', 'done']);
  });

  it('an external abort stops the run', async () => {
    const ac = new AbortController();
    let n = 0;
    const m = loopingModel('ping');
    const r = await runLoop({ model: m, system: 's', messages: msgs, tools: { ping: ping(async () => (++n === 2 && ac.abort(), 'p')) }, budget: B, signal: ac.signal });
    expect(r.stop).toBe('aborted');
    expect(m.calls()).toBe(2);
  });

  it('the wall clock stops a slow tool', async () => {
    const slow = ping((_i, o) => new Promise((res, rej) => (o.abortSignal?.addEventListener('abort', () => rej(new Error('aborted'))), setTimeout(res, 3000))));
    const r = await runLoop({ model: loopingModel('slow'), system: 's', messages: msgs, tools: { slow }, budget: { ...B, wallClockMs: 120 } });
    expect(r.stop).toBe('timeout');
  });

  it('a pre-aborted signal makes zero model calls', async () => {
    const m = loopingModel('ping');
    const r = await runLoop({ model: m, system: 's', messages: msgs, tools: { ping: ping() }, budget: B, signal: AbortSignal.abort() });
    expect(r.stop).toBe('aborted');
    expect(m.calls()).toBe(0);
  });

  it('a model error ends the run with stop=error and never throws', async () => {
    const r = await runLoop({ model: failingModel(), system: 's', messages: msgs, tools: {}, budget: B });
    expect(r.stop).toBe('error');
  });

  it('a throwing tool does not stop the run', async () => {
    const r = await runLoop({ model: loopingModel('ping', 1), system: 's', messages: msgs, tools: { ping: ping(async () => Promise.reject(new Error('boom'))) }, budget: B });
    expect(r.stop).toBe('done');
  });

  it('calls onStep after every step with the running totals', async () => {
    const seen: number[] = [];
    await runLoop({ model: loopingModel('ping', 2), system: 's', messages: msgs, tools: { ping: ping() }, budget: B, onStep: (u) => void seen.push(u.steps) });
    expect(seen).toEqual([1, 2, 3]);
  });
});

describe('budgets and models', () => {
  it('match spec §6', () => {
    expect(BUDGETS.chat).toEqual({ maxTokens: 120_000, maxOutputTokens: 8_000, maxToolCalls: 30, maxSteps: 32, wallClockMs: 120_000, maxUsdc: '0.10' });
    expect(BUDGETS.mission).toEqual({ maxTokens: 300_000, maxOutputTokens: 16_000, maxToolCalls: 60, maxSteps: 62, wallClockMs: 300_000, maxUsdc: '0.25' });
    expect(BUDGETS.service).toEqual({ maxTokens: 20_000, maxOutputTokens: 4_000, maxToolCalls: 2, maxSteps: 3, wallClockMs: 30_000, maxUsdc: '0' });
  });

  it('builds every role on OpenRouter, off Anthropic by default, and refuses to start without a key', () => {
    const m = createModels({ OPENROUTER_API_KEY: 'test-key' });
    expect([m.builder, m.builderAnon, m.run, m.cheap].map((x) => (x as { modelId: string }).modelId)).toEqual([MODEL_IDS.builder, MODEL_IDS.builderAnon, MODEL_IDS.run, MODEL_IDS.cheap]);
    expect(MODEL_IDS).toEqual({ builder: 'deepseek/deepseek-v4.1-flash', builderAnon: 'deepseek/deepseek-v4.1-flash', run: 'deepseek/deepseek-v4.1-flash', cheap: 'deepseek/deepseek-v4.1-flash' });
    expect(() => createModels({})).toThrow('loop: OPENROUTER_API_KEY is not set');
    expect(() => createModels({ ANTHROPIC_API_KEY: 'x' })).toThrow('loop: OPENROUTER_API_KEY is not set');
  });
});

describe('OpenRouter wire (fake fetch, no network)', () => {
  const sse = (...events: (object | string)[]) => events.map((e) => (typeof e === 'string' ? e : `data: ${JSON.stringify(e)}`) + '\n\n').join('');
  // OpenRouter's documented chat-completions stream: comment keep-alive, content deltas, a finish_reason chunk,
  // then a final chunk with empty `choices` and `usage` (incl. cost and prompt_tokens_details), then [DONE].
  const body = (usage: object) =>
    sse(
      ': OPENROUTER PROCESSING',
      { id: 'gen-1', provider: 'Anthropic', model: 'anthropic/claude-sonnet-5.5', object: 'chat.completion.chunk', created: 1, choices: [{ index: 0, delta: { role: 'assistant', content: 'O' }, finish_reason: null }] },
      { id: 'gen-1', provider: 'Anthropic', model: 'anthropic/claude-sonnet-5.5', object: 'chat.completion.chunk', created: 1, choices: [{ index: 0, delta: { role: 'assistant', content: 'K' }, finish_reason: null }] },
      { id: 'gen-1', provider: 'Anthropic', model: 'anthropic/claude-sonnet-5.5', object: 'chat.completion.chunk', created: 1, choices: [{ index: 0, delta: { role: 'assistant', content: '' }, finish_reason: 'stop' }] },
      { id: 'gen-1', provider: 'Anthropic', model: 'anthropic/claude-sonnet-5.5', object: 'chat.completion.chunk', created: 1, choices: [], usage },
      '[DONE]',
    );
  const fake = (usage: object) => {
    const calls: { url: string; headers: Headers; body: Record<string, unknown> }[] = [];
    const f = (async (input: RequestInfo | URL, init?: RequestInit) => {
      calls.push({ url: String(input), headers: new Headers(init?.headers), body: JSON.parse(String(init?.body)) });
      return new Response(body(usage), { status: 200, headers: { 'content-type': 'text/event-stream' } });
    }) as unknown as typeof fetch;
    return { f, calls };
  };
  const usage = { prompt_tokens: 120, completion_tokens: 7, total_tokens: 127, cost: 0.00123, prompt_tokens_details: { cached_tokens: 100, cache_write_tokens: 20 }, completion_tokens_details: { reasoning_tokens: 0 }, cost_details: { upstream_inference_cost: 0.001 } };

  it('meters the usage chunk exactly and sends max_tokens, usage accounting and attribution headers', async () => {
    const { f, calls } = fake(usage);
    const models = createModels({ OPENROUTER_API_KEY: 'test-key' }, { fetch: f });
    const seen: unknown[] = [];
    const r = await runLoop({ model: models.run, system: 's', messages: msgs, tools: {}, budget: { ...B, maxOutputTokens: 777 }, onUsage: (u) => void seen.push(u) });
    expect(r.stop).toBe('done');
    expect(r.text).toBe('OK');
    expect(r.usage).toMatchObject({ inputTokens: 120, outputTokens: 7, cacheReadTokens: 100, cacheWriteTokens: 20, steps: 1 });
    expect(seen).toEqual([{ inputTokens: 120, outputTokens: 7, cacheReadTokens: 100, cacheWriteTokens: 20 }]);
    expect(calls).toHaveLength(1);
    const c = calls[0]!;
    expect(c.url).toBe('https://openrouter.ai/api/v1/chat/completions');
    expect(c.body.model).toBe(MODEL_IDS.run);
    expect(c.body.max_tokens).toBe(777);
    expect(c.body.stream).toBe(true);
    expect(c.body.usage).toEqual({ include: true });
    expect(c.body.stream_options).toEqual({ include_usage: true });
    expect(c.headers.get('authorization')).toBe('Bearer test-key');
    expect(c.headers.get('http-referer')).toBe('https://agentenact.io');
    expect(c.headers.get('x-openrouter-title')).toBe('AgentEnact');
  });

  const chunk = (choices: object[], extra: object = {}) => ({ id: 'gen-1', provider: 'Anthropic', model: 'anthropic/claude-sonnet-5.5', object: 'chat.completion.chunk', created: 1, choices, ...extra });
  const fakeBody = (text: string) => {
    const f = (async () => new Response(text, { status: 200, headers: { 'content-type': 'text/event-stream' } })) as unknown as typeof fetch;
    return createModels({ OPENROUTER_API_KEY: 'k' }, { fetch: f }).run;
  };

  it('fails closed when the stream ends cleanly but never sent a usage chunk (not a free step)', async () => {
    const m = fakeBody(sse(chunk([{ index: 0, delta: { role: 'assistant', content: 'OK' }, finish_reason: null }]), chunk([{ index: 0, delta: { content: '' }, finish_reason: 'stop' }]), '[DONE]'));
    const used: unknown[] = [];
    const r = await runLoop({ model: m, system: 's', messages: msgs, tools: {}, budget: B, onUsage: (u) => void used.push(u) });
    expect(r.stop).toBe('error');
    expect(r.stop).not.toBe('done');
    expect(used).toEqual([]);
  });

  it('a mid-stream error chunk with no usage ends as error', async () => {
    const m = fakeBody(sse(chunk([{ index: 0, delta: { role: 'assistant', content: 'O' }, finish_reason: null }]), { error: { code: 'server_error', message: 'Provider disconnected' }, choices: [{ index: 0, delta: { content: '' }, finish_reason: 'error' }] }, '[DONE]'));
    const r = await runLoop({ model: m, system: 's', messages: msgs, tools: {}, budget: B });
    expect(r.stop).toBe('error');
  });

  it('a max_tokens cut-off (finish_reason length) ends as stop=length, recorded on the step, still metered', async () => {
    const m = fakeBody(body({ prompt_tokens: 10, completion_tokens: 4, total_tokens: 14 }).replace('"finish_reason":"stop"', '"finish_reason":"length"'));
    const r = await runLoop({ model: m, system: 's', messages: msgs, tools: {}, budget: B });
    expect(r.stop).toBe('length');
    expect(r.steps.map((s) => s.finishReason)).toEqual(['length']);
    expect(r.usage).toMatchObject({ inputTokens: 10, outputTokens: 4, steps: 1 });
  });

  it('meters a stream whose usage has no cache details as zero cache tokens', async () => {
    const { f } = fake({ prompt_tokens: 10, completion_tokens: 3, total_tokens: 13 });
    const r = await runLoop({ model: createModels({ OPENROUTER_API_KEY: 'k' }, { fetch: f }).cheap, system: 's', messages: msgs, tools: {}, budget: B });
    expect(r.usage).toMatchObject({ inputTokens: 10, outputTokens: 3, cacheReadTokens: 0, cacheWriteTokens: 0, steps: 1 });
  });

  it('exposes the per-call USD cost in the finish part provider metadata', async () => {
    const { f } = fake(usage);
    const model = createModels({ OPENROUTER_API_KEY: 'k' }, { fetch: f }).run;
    if (typeof model === 'string') throw new Error('unreachable');
    const { stream } = await model.doStream({ prompt: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }] });
    let finish: { providerMetadata?: { openrouter?: { usage?: { cost?: number } } } } | undefined;
    const reader = (stream as ReadableStream<{ type: string }>).getReader();
    for (let x = await reader.read(); !x.done; x = await reader.read()) if (x.value.type === 'finish') finish = x.value as typeof finish;
    expect(finish?.providerMetadata?.openrouter?.usage?.cost).toBe(0.00123);
  });
});
