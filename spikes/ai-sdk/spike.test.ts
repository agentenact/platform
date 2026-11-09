import { test, expect } from 'bun:test';
import { generateText, streamText, tool, stepCountIs, hasToolCall, jsonSchema } from 'ai';
import { createAnthropic } from '@ai-sdk/anthropic';
import { z } from 'zod';
import { loopingModel, usage } from './helpers';

const ping = (execute: (i: any, o: any) => any) =>
  tool({ description: 'ping', inputSchema: z.object({}), execute });

// Q1 ---------------------------------------------------------------
test('Q1 usage: onStepEnd, steps[], usage, totalUsage, cache fields', async () => {
  const model = loopingModel('ping', 2);
  const seen: any[] = [];
  const r = await generateText({
    model, prompt: 'x', tools: { ping: ping(async () => 'pong') },
    stopWhen: stepCountIs(10),
    onStepEnd: (s) => { seen.push(s.usage); },
  });
  expect(r.steps.length).toBe(3);
  expect(seen.length).toBe(3);
  console.log('Q1 step0.usage', JSON.stringify(r.steps[0].usage));
  console.log('Q1 totalUsage', JSON.stringify(r.totalUsage));
  expect(r.steps[0].usage.inputTokenDetails.cacheWriteTokens).toBe(800);
  expect(r.steps[1].usage.inputTokenDetails.cacheReadTokens).toBe(800);
  expect(r.totalUsage.inputTokens).toBe(3000);
  expect(r.totalUsage.outputTokens).toBe(250);
  expect(r.totalUsage.totalTokens).toBe(3250);
  // deprecated alias still fires
  let alias = 0;
  await generateText({ model: loopingModel('ping', 1), prompt: 'x', tools: { ping: ping(async () => 1) }, stopWhen: stepCountIs(5), onStepFinish: () => { alias++; } });
  expect(alias).toBe(2);
});

test('Q1 streamText: onStepEnd + await totalUsage', async () => {
  const model = loopingModel('ping', 1);
  const seen: any[] = [];
  const r = streamText({ model, prompt: 'x', tools: { ping: ping(async () => 'pong') }, stopWhen: stepCountIs(5), onStepEnd: (s) => { seen.push(s.usage.totalTokens); } });
  for await (const _ of r.fullStream) {}
  const t = await r.totalUsage;
  console.log('Q1 stream totalUsage', JSON.stringify(t), 'steps seen', seen);
  expect(seen.length).toBe(2);
  expect(t.totalTokens).toBe(2150);
});

// Q3 ---------------------------------------------------------------
test('Q3 stopWhen: stepCountIs, hasToolCall, custom token predicate (array = OR)', async () => {
  let m = loopingModel('ping');
  let r = await generateText({ model: m, prompt: 'x', tools: { ping: ping(async () => 'p') }, stopWhen: stepCountIs(3) });
  expect(r.steps.length).toBe(3); expect(m.doGenerateCalls.length).toBe(3);

  m = loopingModel('finish');
  const r2 = await generateText({ model: m, prompt: 'x', tools: { finish: ping(async () => 'p') }, stopWhen: hasToolCall('finish') });
  expect(r2.steps.length).toBe(1);

  // budget: each step 1100 tokens; cap 3000 -> stops after step 3 (3300 >= 3000), predicate sees steps incl. latest
  m = loopingModel('ping');
  const budget = (cap: number) => ({ steps }: { steps: any[] }) =>
    steps.reduce((a, s) => a + (s.usage.totalTokens ?? 0), 0) >= cap;
  const r3 = await generateText({ model: m, prompt: 'x', tools: { ping: ping(async () => 'p') }, stopWhen: [stepCountIs(50), budget(3000)] });
  console.log('Q3 budget stop: steps', r3.steps.length, 'finishReason', r3.finishReason);
  expect(r3.steps.length).toBe(3);
  expect(m.doGenerateCalls.length).toBe(3);
});

// Q4 ---------------------------------------------------------------
test('Q4 tool-call cap: throwing execute wrapper', async () => {
  let calls = 0; const CAP = 2;
  const capped = (exec: any) => async (i: any, o: any) => { if (++calls > CAP) throw new Error('TOOL_CAP_EXCEEDED'); return exec(i, o); };
  const m = loopingModel('ping');
  const errs: any[] = [];
  const r = await generateText({
    model: m, prompt: 'x', tools: { ping: ping(capped(async () => 'pong')) }, stopWhen: stepCountIs(6),
    onStepEnd: (s) => { for (const c of s.content) if ((c as any).type === 'tool-error') errs.push((c as any).error?.message); },
  });
  console.log('Q4 generateText resolved (did not reject). steps', r.steps.length, 'errors', errs);
  const last = r.steps[2].content.find((c: any) => c.type === 'tool-error') as any;
  console.log('Q4 tool-error part keys', Object.keys(last ?? {}), 'error', String(last?.error));
  expect(last?.type).toBe('tool-error');
  // loop continues: model sees the error as a tool result and is called again
  expect(m.doGenerateCalls.length).toBe(6);
});

test('Q4b abort-the-run-from-cap: capped tool trips controller -> loop stops', async () => {
  const ac = new AbortController(); let calls = 0;
  const m = loopingModel('ping');
  const p = generateText({
    model: m, prompt: 'x', abortSignal: ac.signal, stopWhen: stepCountIs(50),
    tools: { ping: ping(async () => { if (++calls > 2) { ac.abort(new Error('cap')); throw new Error('cap'); } return 'p'; }) },
  });
  let err: any; try { await p; } catch (e) { err = e; }
  console.log('Q4b outcome:', err ? `${err.name}: ${err.message}` : 'resolved', 'llm calls', m.doGenerateCalls.length);
});

// Q2 ---------------------------------------------------------------
test('Q2 generateText abort mid-loop (abort inside tool 2): no further LLM calls; usage?', async () => {
  const ac = new AbortController(); let calls = 0; let sawSignal = false; const steps: number[] = [];
  const m = loopingModel('ping');
  let err: any;
  try {
    await generateText({
      model: m, prompt: 'x', abortSignal: ac.signal, stopWhen: stepCountIs(50),
      tools: { ping: ping(async (_i, o) => { sawSignal = !!o.abortSignal; if (++calls === 2) ac.abort(); return 'p'; }) },
      onStepEnd: (s) => { steps.push(s.usage.totalTokens ?? 0); },
    });
  } catch (e) { err = e; }
  console.log('Q2 generateText: threw?', err ? `${err.name}: ${err.message}` : 'no', '| llm calls', m.doGenerateCalls.length, '| onStepEnd usages', steps, '| tool got signal', sawSignal);
  const before = m.doGenerateCalls.length; await Bun.sleep(50);
  expect(m.doGenerateCalls.length).toBe(before);
});

test('Q2 generateText: in-flight tool receives signal and is interrupted', async () => {
  const ac = new AbortController(); let aborted = false; let started = false; const steps: any[] = [];
  const m = loopingModel('slow');
  setTimeout(() => ac.abort(), 100);
  let err: any;
  try {
    await generateText({
      model: m, prompt: 'x', abortSignal: ac.signal, stopWhen: stepCountIs(50),
      tools: { slow: ping((_i, o) => new Promise((res, rej) => { started = true; o.abortSignal?.addEventListener('abort', () => { aborted = true; rej(new Error('tool aborted')); }); setTimeout(res, 5000); })) },
      onStepEnd: (s) => { steps.push(s.usage.totalTokens); },
    });
  } catch (e) { err = e; }
  console.log('Q2 inflight: started', started, 'tool saw abort', aborted, '| threw', err ? `${err.name}: ${err.message}` : 'no', '| steps finished', steps, '| llm calls', m.doGenerateCalls.length);
});

test('Q2 streamText abort mid-loop: onAbort steps, usage, stream behaviour', async () => {
  const ac = new AbortController(); let calls = 0; let abortEvt: any; const steps: number[] = []; let errEvt: any;
  const m = loopingModel('ping');
  const r = streamText({
    model: m, prompt: 'x', abortSignal: ac.signal, stopWhen: stepCountIs(50),
    tools: { ping: ping(async () => { if (++calls === 2) ac.abort(); return 'p'; }) },
    onStepEnd: (s) => { steps.push(s.usage.totalTokens ?? 0); },
    onAbort: (e) => { abortEvt = e; },
    onError: ({ error }) => { errEvt = error; },
  });
  const types: string[] = [];
  let thrown: any;
  try { for await (const p of r.fullStream) types.push(p.type); } catch (e) { thrown = e; }
  await Bun.sleep(50);
  let tu: any, tuErr: any;
  try { tu = await Promise.race([r.totalUsage, Bun.sleep(500).then(() => 'TIMEOUT')]); } catch (e) { tuErr = e; }
  console.log('Q2 stream: last parts', types.slice(-4), '| thrown', thrown?.name, '| onError', errEvt?.name,
    '| onAbort steps', abortEvt?.steps?.length, abortEvt?.steps?.map((s: any) => s.usage.totalTokens), 'reason', String(abortEvt?.reason),
    '| onStepEnd', steps, '| totalUsage', JSON.stringify(tu), tuErr?.name, '| llm calls', m.doStreamCalls.length);
  const before = m.doStreamCalls.length; await Bun.sleep(50);
  expect(m.doStreamCalls.length).toBe(before);
});

test('Q2 pre-aborted signal: zero LLM calls', async () => {
  const m = loopingModel('ping'); let err: any;
  try { await generateText({ model: m, prompt: 'x', abortSignal: AbortSignal.abort(), tools: { ping: ping(async () => 'p') } }); } catch (e) { err = e; }
  console.log('Q2 pre-aborted:', err?.name, '| llm calls', m.doGenerateCalls.length);
});

test('Q2 timeout option (totalMs) as wall-clock alternative', async () => {
  const m = loopingModel('slow'); let err: any; const t0 = Date.now();
  try { await generateText({ model: m, prompt: 'x', timeout: { totalMs: 150 }, stopWhen: stepCountIs(50),
    tools: { slow: ping((_i, o) => new Promise((res, rej) => { o.abortSignal?.addEventListener('abort', () => rej(new Error('aborted'))); setTimeout(res, 3000); })) } }); } catch (e) { err = e; }
  console.log('Q2 timeout totalMs: ms', Date.now() - t0, err?.name, String(err?.message).slice(0, 80));
});

// Q5 ---------------------------------------------------------------
test('Q5 model ids construct via @ai-sdk/anthropic (no network)', () => {
  const a = createAnthropic({ apiKey: 'dummy' });
  for (const id of ['claude-sonnet-5-5', 'claude-opus-5-5', 'claude-haiku-4-5-20251001']) {
    const mdl = a(id); console.log('Q5', id, '->', mdl.provider, mdl.modelId, mdl.specificationVersion);
    expect(mdl.modelId).toBe(id);
  }
});
