import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { tool, type ToolSet } from 'ai';
import { z } from 'zod';
import type { Db } from '../src/db/index.js';
import { BUDGETS } from '../src/loop/budgets.js';
import { createRunner, type RunOutcome } from '../src/loop/index.js';
import { createServiceRunner, parseServiceOutput, SERVICE_OUTPUT_MAX_CHARS, serviceSystem } from '../src/loop/service.js';
import { createPolicy, DAILY_RUNS } from '../src/policy/index.js';
import { createRuns, emptyUsage } from '../src/runs/index.js';
import { createMemory } from '../src/runs/memory.js';
import { createSpecs, type ServiceRow } from '../src/specs/index.js';
import { freshDb } from './support/db.js';
import { scriptedModel } from './support/models.js';
import { activeAgent, minimalSpec } from './support/specs.js';

const OUT = { type: 'object' as const, required: ['summary'], additionalProperties: false as const, properties: { summary: { type: 'string' as const, maxLength: 200 } } };

describe('service runs', () => {
  let sql: Db;
  let drop: () => Promise<void>;
  beforeAll(async () => ({ sql, drop } = await freshDb()));
  afterAll(() => drop());

  async function service(): Promise<{ svc: ServiceRow; userId: string; agentId: string }> {
    const a = await activeAgent(sql);
    const specs = createSpecs(sql);
    const spec = minimalSpec({
      persona: 'OWNER PERSONA must not leak',
      skills: [{ name: 'secret-skill', description: 'owner only', body: 'OWNER SKILL BODY' }],
      services: [{ slug: 'summary', description: 'Summarise', price_usdc: '0.01', input_schema: { type: 'object', properties: { text: { type: 'string' } }, required: ['text'] }, output_schema: OUT, persona: 'You summarise text in one sentence.', skill_body: 'Be terse.', tools: ['web_read'] }],
    });
    await specs.approve(a.userId, a.agentId, await specs.saveDraft(a.userId, a.agentId, spec));
    await createMemory(sql).remember(a.agentId, 'secret', 'OWNER MEMORY VALUE');
    return { svc: (await specs.service(a.agentId, 'summary'))!, userId: a.userId, agentId: a.agentId };
  }

  function runnerWith(model: ReturnType<typeof scriptedModel>, seen: string[][] = [], agentActive = async () => true) {
    return createServiceRunner({
      runner: createRunner({ runs: createRuns(sql), policy: createPolicy(sql, { killSwitch: false }), model, modelId: 'test/model' }),
      toolbox: { serviceTools: (_a, names): ToolSet => (seen.push([...names]), {}) },
      agentActive,
    });
  }

  it('parses one JSON value, also inside a json code fence, and validates it', () => {
    expect(parseServiceOutput('{"summary":"ok"}', OUT)).toEqual({ summary: 'ok' });
    const fence = '`'.repeat(3);
    expect(parseServiceOutput(`${fence}json\n{"summary":"ok"}\n${fence}`, OUT)).toEqual({ summary: 'ok' });
    expect(() => parseServiceOutput('Sure! {"summary":"ok"}', OUT)).toThrow(expect.objectContaining({ code: 'bad_output' }));
    expect(() => parseServiceOutput('{"summary":1}', OUT)).toThrow(expect.objectContaining({ code: 'output_mismatch' }));
    expect(() => parseServiceOutput('{"summary":"ok","extra":1}', OUT)).toThrow(expect.objectContaining({ code: 'output_mismatch' }));
  });

  it('parses only the last step: narration before a tool call does not break a service answer', async () => {
    const { svc, userId } = await service();
    const toolbox = { serviceTools: (): ToolSet => ({ web_read: tool({ description: 'r', inputSchema: z.object({}), execute: async () => 'page' }) }) };
    const run = (m: ReturnType<typeof scriptedModel>) => createServiceRunner({ runner: createRunner({ runs: createRuns(sql), policy: createPolicy(sql, { killSwitch: false }), model: m, modelId: 'test/model' }), toolbox, agentActive: async () => true })(svc, userId, { text: 'x' }, new AbortController().signal);
    const narrated = scriptedModel([{ narrate: 'Let me check.', tool: 'web_read' }, { text: '{"summary":"ok"}' }]);
    expect((await run(narrated)).output).toEqual({ summary: 'ok' });
    // two tools, then JSON
    expect((await run(scriptedModel([{ tool: 'web_read' }, { tool: 'web_read' }, { text: '{"summary":"ok"}' }]))).output).toEqual({ summary: 'ok' });
    // two parallel calls in one step, then JSON
    expect((await run(scriptedModel([{ tool: 'web_read', parallel: 2 }, { text: '{"summary":"ok"}' }]))).output).toEqual({ summary: 'ok' });
    // a model that keeps calling tools gets no tools after the cap and ends stopped
    const greedy = scriptedModel([{ tool: 'web_read' }]);
    await expect(run(greedy)).rejects.toMatchObject({ code: 'stopped' });
    expect(greedy.calls()).toBe(3);
  });

  it('checks the size cap before any scan: 60k newlines after an opening fence is refused fast', () => {
    const t0 = performance.now();
    expect(() => parseServiceOutput('`'.repeat(3) + '\n'.repeat(60_000), OUT)).toThrow(expect.objectContaining({ code: 'bad_output' }));
    expect(() => parseServiceOutput('x'.repeat(SERVICE_OUTPUT_MAX_CHARS + 1), OUT)).toThrow(expect.objectContaining({ code: 'bad_output' }));
    expect(performance.now() - t0).toBeLessThan(50);
    const fence = '`'.repeat(3);
    expect(parseServiceOutput(`${fence}\n{"summary":"ok"}${fence}`, OUT)).toEqual({ summary: 'ok' });
    expect(() => parseServiceOutput(`${fence}yaml\n{"summary":"ok"}\n${fence}`, OUT)).toThrow(expect.objectContaining({ code: 'bad_output' }));
  });

  it('runs with the service context only: no owner persona, skills or memory; only its tools', async () => {
    const { svc, userId } = await service();
    const m = scriptedModel([{ text: '{"summary":"Stellar is a network."}' }]);
    const seen: string[][] = [];
    const out = await runnerWith(m, seen)(svc, userId, { text: 'Stellar is a payments network.' }, new AbortController().signal);
    expect(out.output).toEqual({ summary: 'Stellar is a network.' });
    const prompt = m.doStreamCalls[0]!.prompt;
    const system = (prompt[0] as { content: string }).content;
    expect(system).toBe(serviceSystem(svc));
    const all = JSON.stringify(prompt);
    for (const leak of ['OWNER PERSONA', 'OWNER SKILL BODY', 'secret-skill', 'OWNER MEMORY VALUE']) expect(all).not.toContain(leak);
    expect(all).toContain('Stellar is a payments network.');
    expect(seen).toEqual([['web_read']]);
    expect('skills' in out).toBe(false); // no skills picked: the record stays v0.1
    const [row] = (await sql`select mode, service_id, status from app.runs where id = ${out.runId}`) as { mode: string; service_id: string; status: string }[];
    expect(row).toEqual({ mode: 'service', service_id: svc.id, status: 'done' });
  });

  it('a service the owner gave skills runs with exactly those, and names them for the record', async () => {
    const { svc, userId } = await service();
    const picked = { ...svc, skills: ['picked', 'gone'] };
    const asked: string[][] = [];
    const m = scriptedModel([{ text: '{"summary":"ok"}' }]);
    const run = createServiceRunner({
      runner: createRunner({ runs: createRuns(sql), policy: createPolicy(sql, { killSwitch: false }), model: m, modelId: 'test/model' }),
      toolbox: { serviceTools: (): ToolSet => ({}) },
      agentActive: async () => true,
      // 'gone' was edited or removed since: the resolver leaves it out.
      serviceSkills: async (_a, names) => (asked.push([...names]), [{ name: 'picked', description: 'Picked one', body: 'PICKED SKILL BODY', id: 'acme/skills/picked', contentHash: 'c'.repeat(64) }]),
    });
    const out = await run(picked, userId, { text: 'x' }, new AbortController().signal);
    expect(asked).toEqual([['picked', 'gone']]);
    expect(out.skills).toEqual([{ id: 'acme/skills/picked', sha256: 'c'.repeat(64) }]);
    const all = JSON.stringify(m.doStreamCalls[0]!.prompt);
    expect(all).toContain('PICKED SKILL BODY');
    for (const leak of ['OWNER SKILL BODY', 'secret-skill']) expect(all).not.toContain(leak);

    // Every picked skill gone: still a skills list (empty), so the record says "none used" rather than nothing.
    const none = createServiceRunner({
      runner: createRunner({ runs: createRuns(sql), policy: createPolicy(sql, { killSwitch: false }), model: scriptedModel([{ text: '{"summary":"ok"}' }]), modelId: 'test/model' }),
      toolbox: { serviceTools: (): ToolSet => ({}) },
      agentActive: async () => true,
      serviceSkills: async () => [],
    });
    expect((await none(picked, userId, { text: 'x' }, new AbortController().signal)).skills).toEqual([]);
  });

  it('throws on a bad output, a budget stop, an abort and the owner cap; never repairs', async () => {
    const { svc, userId } = await service();
    const bad = scriptedModel([{ text: 'I cannot help.' }]);
    await expect(runnerWith(bad)(svc, userId, { text: 'x' }, new AbortController().signal)).rejects.toMatchObject({ code: 'bad_output' });
    expect(bad.calls()).toBe(1); // no repair call

    const looping = scriptedModel([{ tool: 'web_read', input: { url: 'https://x.example' } }]);
    await expect(runnerWith(looping)(svc, userId, { text: 'x' }, new AbortController().signal)).rejects.toMatchObject({ code: 'stopped' });

    await expect(runnerWith(scriptedModel([{ text: '{"summary":"x"}' }]))(svc, userId, { text: 'x' }, AbortSignal.abort())).rejects.toMatchObject({ code: 'stopped' });

    await sql`update app.users set daily_runs = ${DAILY_RUNS}, daily_reset_at = date_trunc('day', now(), 'UTC') where id = ${userId}`;
    await expect(runnerWith(scriptedModel([{ text: '{"summary":"x"}' }]))(svc, userId, { text: 'x' }, new AbortController().signal)).rejects.toMatchObject({ code: 'capped' });
  });

  it('decides by status, never by text: an error outcome with valid-looking text and a length stop both throw', async () => {
    const { svc, userId } = await service();
    const outcome = (over: Partial<RunOutcome>): RunOutcome => ({ runId: crypto.randomUUID(), status: 'done', stop: 'done', text: 'narration', finalText: '{"summary":"ok"}', usage: emptyUsage(), ...over });
    const run = (o: RunOutcome) => createServiceRunner({ runner: { run: async () => o }, toolbox: { serviceTools: (): ToolSet => ({}) }, agentActive: async () => true })(svc, userId, { text: 'x' }, new AbortController().signal);
    expect((await run(outcome({}))).output).toEqual({ summary: 'ok' });
    await expect(run(outcome({ status: 'error', stop: 'error' }))).rejects.toMatchObject({ code: 'stopped' }); // partial text of a failed run
    await expect(run(outcome({ status: 'done', stop: 'length' }))).rejects.toMatchObject({ code: 'stopped' }); // cut off at max_tokens
    await expect(run(outcome({ status: 'budget', stop: 'tokens' }))).rejects.toMatchObject({ code: 'stopped' });
    await expect(run(outcome({ status: 'capped', stop: 'user_cap' }))).rejects.toMatchObject({ code: 'capped' });
    await expect(run(outcome({ status: 'capped', stop: 'killed' }))).rejects.toMatchObject({ code: 'capped' });
  });

  it('refuses a switched-off service and a non-active agent before any run row or model call', async () => {
    const { svc, userId, agentId } = await service();
    const m = scriptedModel([{ text: '{"summary":"x"}' }]);
    const before = async () => ((await sql`select count(*)::int as n from app.runs where agent_id = ${agentId}`) as { n: number }[])[0]!.n;
    const n0 = await before();
    await expect(runnerWith(m)({ ...svc, status: 'off' }, userId, { text: 'x' }, new AbortController().signal)).rejects.toMatchObject({ code: 'unavailable' });
    await expect(runnerWith(m, [], async () => false)(svc, userId, { text: 'x' }, new AbortController().signal)).rejects.toMatchObject({ code: 'unavailable' });
    expect(m.calls()).toBe(0);
    expect(await before()).toBe(n0);
  });

  it('the service budget bounds every model call and the whole run', () => {
    expect(BUDGETS.service).toMatchObject({ maxTokens: 20_000, maxOutputTokens: 4_000, maxToolCalls: 2, maxSteps: 3, wallClockMs: 30_000, maxUsdc: '0' });
  });
});
