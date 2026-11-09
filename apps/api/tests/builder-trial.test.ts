import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { createTrial, TRIAL_BUDGET } from '../src/builder/trial.js';
import type { Db } from '../src/db/index.js';
import { RESEND_URL } from '../src/tools/deliver.js';
import { createToolbox } from '../src/tools/index.js';
import type { SandboxResult } from '../src/tools/sandbox.js';
import { xlmDrop } from '../src/builder/examples.js';
import { freshDb } from './support/db.js';
import { scriptedModel } from './support/models.js';
import { fakeSafeFetch } from './support/safe-fetch.js';
import { minimalSpec } from './support/specs.js';

const CHANGE = { symbol: 'XLM', network: 'mainnet', windowSeconds: 3600, from: { usd: '0.2000', at: '2026-10-13T10:00:00.000Z' }, to: { usd: '0.1850', at: '2026-10-13T11:00:00.000Z' }, changePct: -7.5 };
const cond = () => xlmDrop().spec;

function setup(o: { model?: ReturnType<typeof scriptedModel>; sandbox?: (code: string, input: unknown, p?: unknown) => Promise<SandboxResult>; fetchFails?: boolean } = {}) {
  const sf = fakeSafeFetch((url) => {
    if (url === RESEND_URL) return { body: { id: 'e1' } };
    if (url.startsWith('https://')) return o.fetchFails ? { status: 500, body: {} } : { body: CHANGE };
    return undefined;
  });
  const fetches: { agent: string; tool: string; args: unknown }[] = [];
  const toolbox = createToolbox({
    safeFetch: sf,
    memory: { remember: async () => 'saved' },
    specs: { skillBody: async () => null },
    policy: { delivery: () => true, egress: () => true, paidSearch: () => true, trialSearch: () => true },
    webhookSecret: () => 'ab'.repeat(32),
    mailFrom: 'x@example.com',
    env: { RESEND_API_KEY: 'k' },
  });
  const calls: { code: string; input: unknown; params: unknown }[] = [];
  const sandbox = o.sandbox ?? (async (code: string, input: unknown, p?: unknown) => (calls.push({ code, input, params: p }), { ok: true, value: true } as SandboxResult));
  const model = o.model ?? scriptedModel([{ text: 'Would tell the owner.' }]);
  const trial = createTrial({
    model,
    toolbox: {
      trialTools: toolbox.trialTools,
      conditionFetch: async (a, t, args, s) => (fetches.push({ agent: a, tool: t, args }), o.fetchFails ? Promise.reject(new Error('down')) : { ...CHANGE, signal: !!s }),
    },
    sandbox: sandbox as never,
  });
  return { trial, model, sf, fetches, calls };
}
const promptOf = (m: { doStreamCalls: { prompt: unknown }[] }) => JSON.stringify(m.doStreamCalls[0]!.prompt);

describe('builder trial', () => {
  it('has the brief budget', () => {
    expect(TRIAL_BUDGET).toEqual({ maxTokens: 60_000, maxOutputTokens: 4_000, maxToolCalls: 8, maxSteps: 10, wallClockMs: 90_000 });
  });

  it('a held condition runs the mission with the fetched data and returns held true', async () => {
    const { trial, model, fetches, calls } = setup();
    const r = await trial.run({ spec: cond(), scope: 'ip:9' });
    expect(r.status).toBe('done');
    expect(r.condition!.held).toBe(true);
    expect(JSON.parse(r.condition!.data)).toMatchObject({ changePct: -7.5 });
    // The same extractor the scheduler uses, so the trial and the feed show the same numbers.
    expect(r.condition!.reading).toEqual({ symbol: 'XLM', changePct: -7.5, from: 0.2, to: 0.185 });
    expect(r.condition!.line).toBe('XLM moved \u22127.50% in the last hour');
    expect(r.text).toBe('Would tell the owner.');
    expect(fetches).toEqual([{ agent: 'trial:ip:9', tool: 'stellar_price_change', args: { symbol: 'XLM', window_s: 3600 } }]);
    // Params reach the sandbox as data, only because the trigger has params.
    expect(calls[0]!.params).toEqual({ params: { drop_pct: 5 } });
    expect(promptOf(model)).toContain('-7.5');
    expect(promptOf(model)).toContain('XLM is sharply cheaper');
    // The model is told the person's settings, so it never invents its own threshold.
    expect(promptOf(model)).toContain('drop_pct = 5');
  });

  it('a trigger without params passes no params to the sandbox', async () => {
    const s = cond();
    const t = s.triggers[0]!;
    if (t.kind !== 'condition') throw new Error('x');
    delete t.params;
    const { trial, calls, model } = setup();
    await trial.run({ spec: s, scope: 'ip:9' });
    expect(calls[0]!.params).toBeUndefined();
    expect(promptOf(model)).not.toContain("person's settings");
  });

  it('a false condition still runs the mission and reports held false', async () => {
    const { trial, model } = setup({ sandbox: async () => ({ ok: true, value: false }) });
    const r = await trial.run({ spec: cond(), scope: 'ip:9' });
    expect([r.status, r.condition!.held, model.calls()]).toEqual(['done', false, 1]);
    expect(promptOf(model)).toMatch(/did not hold/);
    // The panel hides a reply with a technical word, so the trial's own words never lead the model to one, and the
    // model is told its final reply is the message itself: plain words, no Markdown.
    const userTurn = JSON.stringify((model.doStreamCalls[0]!.prompt as { role: string }[]).filter((m) => m.role === 'user'));
    expect(userTurn.replace(/XLM is sharply cheaper[^"]*/, '')).not.toMatch(/\bconditions?\b/i);
    expect(promptOf(model)).toContain('no Markdown');
    // The panel shows the reply as "If it happens, this is what you'd get": it must be that email, not a report on the check.
    expect(promptOf(model)).toContain('reply with only the message you would send if it happened');
    expect(promptOf(model)).toContain('no placeholders');
    expect(promptOf(model)).toContain('never these words: passkey, smart wallet, spec');
  });

  it('a failed fetch gives held null and still runs', async () => {
    const { trial, model, calls } = setup({ fetchFails: true });
    const r = await trial.run({ spec: cond(), scope: 'ip:9' });
    expect([r.status, r.condition!.held, model.calls(), calls.length]).toEqual(['done', null, 1, 0]);
    expect([r.condition!.line, r.condition!.reading]).toEqual([null, null]);
  });

  it('failing condition code gives held null', async () => {
    const { trial } = setup({ sandbox: async () => ({ ok: false, error: 'boom', fault: 'code' } as never) });
    expect((await trial.run({ spec: cond(), scope: 'ip:9' })).condition!.held).toBeNull();
    const t2 = setup({ sandbox: async () => ({ ok: true, value: 'yes' }) });
    expect((await t2.trial.run({ spec: cond(), scope: 'ip:9' })).condition!.held).toBeNull();
  });

  it('condition data is clipped to 2000 characters', async () => {
    const big = createTrial({
      model: scriptedModel([{ text: 'ok' }]),
      toolbox: { trialTools: () => ({}), conditionFetch: async () => ({ blob: 'x'.repeat(10_000) }) },
      sandbox: async () => ({ ok: true, value: true }),
    });
    expect((await big.run({ spec: cond(), scope: 's' })).condition!.data.length).toBeLessThanOrEqual(2000);
  });

  it('a model that tries send_email ends with wouldHave email and no delivery', async () => {
    const model = scriptedModel([{ tool: 'send_email', input: { subject: 'XLM fell', text: 'it fell' } }, { text: 'Emailed (preview).' }]);
    const { trial, sf } = setup({ model });
    const r = await trial.run({ spec: cond(), scope: 'ip:9' });
    expect(r.wouldHave).toEqual([{ kind: 'email', summary: expect.stringContaining('XLM fell') }]);
    expect(sf.calls.filter((c) => c.url === RESEND_URL)).toHaveLength(0);
    expect(r.steps.length).toBeGreaterThan(0);
  });

  it('usage and steps are returned', async () => {
    const model = scriptedModel([{ tool: 'compute', input: { code: 'return 1' } }, { text: 'done' }]);
    const { trial } = setup({ model });
    const r = await trial.run({ spec: minimalSpec({ tools: ['compute'] }), scope: 's' });
    expect(r.usage.inputTokens).toBe(2000);
    expect(r.usage.outputTokens).toBe(150);
    expect(r.steps.map((s) => s.tools)).toEqual([['compute'], []]);
  });

  it('a spec with no trigger still runs once, and condition is null', async () => {
    const { trial, model, fetches } = setup();
    const r = await trial.run({ spec: minimalSpec(), scope: 's' });
    expect([r.status, r.condition, model.calls(), fetches.length]).toEqual(['done', null, 1, 0]);
    expect(promptOf(model)).toMatch(/would do now/);
  });

  it('a cron trigger runs its mission with no condition', async () => {
    const spec = minimalSpec({ triggers: [{ kind: 'cron', cron: '0 9 * * *', mission: 'Daily digest please.' }] });
    const { trial, model } = setup();
    const r = await trial.run({ spec, scope: 's' });
    expect(r.condition).toBeNull();
    expect(promptOf(model)).toContain('Daily digest please.');
  });

  it('a run that exhausts its budget reports budget', async () => {
    const model = scriptedModel(Array.from({ length: 20 }, () => ({ tool: 'compute', input: { code: 'return 1' } })));
    const { trial } = setup({ model });
    expect((await trial.run({ spec: minimalSpec({ tools: ['compute'] }), scope: 's' })).status).toBe('budget');
  });

  it('a model failure reports error and never throws', async () => {
    const { failingModel } = await import('./support/models.js');
    const { trial } = setup({ model: failingModel() as never });
    expect((await trial.run({ spec: minimalSpec(), scope: 's' })).status).toBe('error');
  });

  describe('side effects', () => {
    let sql: Db;
    let drop: () => Promise<void>;
    beforeAll(async () => ({ sql, drop } = await freshDb()));
    afterAll(() => drop());

    it('the run writes no runs row and touches no user counter (row counts unchanged; structural guarantee: trial.ts imports no db)', async () => {
      const count = async () => JSON.stringify(await sql`select (select count(*) from app.runs) as runs, (select count(*) from app.memory) as mem, (select count(*) from app.agents) as agents, (select coalesce(sum(daily_runs + daily_tokens), 0) from app.users) as ctr`);
      const before = await count();
      const model = scriptedModel([{ tool: 'remember', input: { key: 'k', value: 'v' } }, { text: 'ok' }]);
      const { trial } = setup({ model });
      await trial.run({ spec: cond(), scope: 'ip:9' });
      expect(await count()).toBe(before);
    });
  });
});
