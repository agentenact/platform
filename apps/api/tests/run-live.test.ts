import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { createActivity } from '../src/activity/index.js';
import type { Db } from '../src/db/index.js';
import { createRunner, liveWriter } from '../src/loop/index.js';
import { createPolicy } from '../src/policy/index.js';
import { createRuns, type Runs } from '../src/runs/index.js';
import { CLAIM_LEASE_MIN } from '../src/scheduler/index.js';
import { createSpecs } from '../src/specs/index.js';
import { freshDb } from './support/db.js';
import { loopingModel } from './support/models.js';
import { activeAgent, minimalSpec } from './support/specs.js';

describe('liveWriter', () => {
  const tick = (ms: number) => new Promise((r) => setTimeout(r, ms));
  it('writes the tail at most once per interval, catches up after a write, survives a failed one, and stops', async () => {
    const wrote: string[] = [];
    let fail = true;
    const w = liveWriter(async (s) => {
      wrote.push(s);
      await tick(5);
      if (fail) {
        fail = false;
        throw new Error('db down');
      }
    }, { flushMs: 40, max: 5 });
    w.delta('Hello');
    await tick(1);
    w.delta(' there'); // while the first write is out: held, then sent once the interval has passed
    await tick(10);
    expect(wrote).toEqual(['Hello']);
    await tick(60);
    expect(wrote).toEqual(['Hello', 'there']); // the tail only, after the failed first write
    w.delta('!');
    w.stop();
    await tick(60);
    expect(wrote).toEqual(['Hello', 'there']);
  });
});

describe('the live view of a run', () => {
  let sql: Db;
  let drop: () => Promise<void>;
  beforeAll(async () => ({ sql, drop } = await freshDb()));
  afterAll(() => drop());
  const live = (u: string, a: string) => createActivity(sql, { publicBaseUrl: 'https://agentenact.io' }).live(u, a);

  async function cronAgent() {
    const a = await activeAgent(sql);
    const specs = createSpecs(sql);
    await specs.approve(a.userId, a.agentId, await specs.saveDraft(a.userId, a.agentId, minimalSpec({ triggers: [{ kind: 'cron', cron: '0 18 * * *', mission: 'Write.' }] })));
    await sql`update app.triggers set next_run_at = now() + interval '3 hours' where agent_id = ${a.agentId}`;
    return a;
  }

  it('walks idle, queued, starting, working, finishing, idle; lines are plain call lines, text is the live tail', async () => {
    const a = await cronAgent();
    expect(await live(a.userId, a.agentId)).toEqual({ phase: 'idle', since: null, lines: [], text: '' });
    await sql`update app.triggers set next_run_at = now() where agent_id = ${a.agentId}`;
    expect((await live(a.userId, a.agentId)).phase).toBe('queued');
    await sql`update app.triggers set next_run_at = now() + make_interval(mins => ${CLAIM_LEASE_MIN}), claimed_at = now() where agent_id = ${a.agentId}`;
    const starting = await live(a.userId, a.agentId);
    expect(starting.phase).toBe('starting');
    expect(starting.since).not.toBeNull();

    // An older run of the same agent is not this one.
    await sql`insert into app.runs (agent_id, mode, status, started_at, ended_at) values (${a.agentId}, 'mission', 'done', now() - interval '1 day', now() - interval '1 day')`;
    expect((await live(a.userId, a.agentId)).phase).toBe('starting');

    const runs = createRuns(sql);
    const id = await runs.start({ agentId: a.agentId, mode: 'mission' });
    const steps = [
      { n: 1, tools: ['web_search', 'web_read'], calls: [{ tool: 'web_search', line: 'Searched the web for "stellar defi"' }, { tool: 'web_read', line: null }], inputTokens: 1, outputTokens: 1, finishReason: 'tool-calls' },
    ];
    await runs.progress(id, { inputTokens: 1, outputTokens: 1, cacheReadTokens: 0, cacheWriteTokens: 0, steps: 1, toolCalls: 2 }, steps);
    await runs.live(id, 'Stellar DeFi today: TVL');
    expect(await live(a.userId, a.agentId)).toMatchObject({ phase: 'working', lines: ['Searched the web for "stellar defi"'], text: 'Stellar DeFi today: TVL' });

    await runs.finish(id, { status: 'done', stopReason: 'done', usage: { inputTokens: 1, outputTokens: 1, cacheReadTokens: 0, cacheWriteTokens: 0, steps: 1, toolCalls: 2 }, steps });
    expect(((await sql`select live_text from app.runs where id = ${id}`) as { live_text: string | null }[])[0]!.live_text).toBeNull();
    await runs.live(id, 'late'); // a finished run takes no more text
    expect(await live(a.userId, a.agentId)).toMatchObject({ phase: 'finishing', text: '' });

    await sql`update app.triggers set next_run_at = now() + interval '1 day' where agent_id = ${a.agentId}`;
    expect((await live(a.userId, a.agentId)).phase).toBe('idle');
  });

  it('is a 404 for a foreign agent', async () => {
    const a = await cronAgent();
    const b = await activeAgent(sql);
    await expect(live(b.userId, a.agentId)).rejects.toMatchObject({ status: 404 });
  });

  it('a mission run writes its text as it goes; a chat run does not', async () => {
    const a = await activeAgent(sql);
    const base = createRuns(sql);
    const seen: string[] = [];
    const runs: Runs = { ...base, live: async (id, t) => (seen.push(t), base.live(id, t)) };
    const runner = createRunner({ runs, policy: createPolicy(sql, { killSwitch: false }), model: loopingModel('ping', 0), modelId: 'test/model' });
    const msgs = [{ role: 'user' as const, content: 'hi' }];
    const out = await runner.run({ agentId: a.agentId, userId: a.userId, mode: 'mission', system: 's', messages: msgs, tools: {} });
    expect(out.status).toBe('done');
    expect(seen.join('')).toContain('done');
    seen.length = 0;
    await runner.run({ agentId: a.agentId, userId: a.userId, mode: 'chat', system: 's', messages: msgs, tools: {} });
    expect(seen).toEqual([]);
  });

  it('keeps the whole answer as the result for the run page, the 400-character summary for lists', async () => {
    const a = await activeAgent(sql);
    const runs = createRuns(sql);
    const id = await runs.start({ agentId: a.agentId, mode: 'mission' });
    const long = `# Digest\n\n${'word '.repeat(300)}`;
    await runs.annotate(id, long);
    const one = (await runs.getOwned(a.userId, a.agentId, id))!;
    expect(one.result).toBe(long);
    expect(one.summary!.length).toBe(400);
    expect((await runs.recent(a.userId, a.agentId)).find((r) => r.id === id)!.result).toBeUndefined();
  });

  it('keeps what each tool call was about apart from the steps, for the owner\'s one-run read only', async () => {
    const a = await activeAgent(sql);
    const runs = createRuns(sql);
    const id = await runs.start({ agentId: a.agentId, mode: 'mission' });
    const step = {
      n: 1, tools: ['web_search', 'remember'], inputTokens: 1, outputTokens: 1, finishReason: 'tool-calls',
      calls: [
        { tool: 'web_search', line: 'Searched the web', detail: { query: 'Stellar DeFi news', results: [{ title: 'News', url: 'https://example.com/a' }] } },
        { tool: 'remember', line: 'Made a note for next time' },
      ],
    };
    await runs.finish(id, { status: 'done', stopReason: 'done', usage: { inputTokens: 1, outputTokens: 1, cacheReadTokens: 0, cacheWriteTokens: 0, steps: 1, toolCalls: 2 }, steps: [step] });
    const [row] = (await sql`select steps, call_details from app.runs where id = ${id}`) as { steps: { calls: object[] }[]; call_details: unknown }[];
    expect(JSON.stringify(row!.steps)).not.toContain('Stellar DeFi news');
    expect(row!.call_details).toEqual([{ n: 1, i: 0, d: step.calls[0]!.detail }]);
    expect((await runs.getOwned(a.userId, a.agentId, id))!.steps).toEqual([step]);
    expect(JSON.stringify(await runs.recent(a.userId, a.agentId))).not.toContain('Stellar DeFi news');
    expect(JSON.stringify(await runs.get(id))).not.toContain('Stellar DeFi news');
  });
});
