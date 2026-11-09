import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { SQL } from 'bun';
import { INSTANCE_CLASS, type Db } from '../src/db/index.js';
import { createRuns, emptyUsage, type Runs } from '../src/runs/index.js';
import { createMemory, MEMORY_MAX_KEYS, type Memory } from '../src/runs/memory.js';
import { freshDb } from './support/db.js';
import { activeAgent } from './support/specs.js';

describe('runs and memory', () => {
  let sql: Db;
  let url: string;
  let drop: () => Promise<void>;
  let runs: Runs;
  let memory: Memory;
  beforeAll(async () => {
    ({ sql, url, drop } = await freshDb());
    runs = createRuns(sql);
    memory = createMemory(sql);
  });
  afterAll(() => drop());

  it('start → progress → finish records usage and redacted steps', async () => {
    const a = await activeAgent(sql);
    const id = await runs.start({ agentId: a.agentId, mode: 'chat' });
    expect(await runs.get(id)).toMatchObject({ status: 'running', mode: 'chat', inputTokens: 0, endedAt: null });
    const step = { n: 1, tools: ['web_read'], inputTokens: 1000, outputTokens: 100, finishReason: 'tool-calls' };
    const u = { ...emptyUsage(), inputTokens: 1000, outputTokens: 100, steps: 1, toolCalls: 1 };
    await runs.progress(id, u, [step]);
    expect(await runs.get(id)).toMatchObject({ status: 'running', inputTokens: 1000, toolCalls: 1, steps: [step] });
    await runs.finish(id, { status: 'budget', stopReason: 'tokens', usage: { ...u, inputTokens: 2000, cacheReadTokens: 800, steps: 2 }, steps: [step, { ...step, n: 2, tools: [] }] });
    const r = await runs.get(id);
    expect(r).toMatchObject({ status: 'budget', stopReason: 'tokens', inputTokens: 2000, cacheReadTokens: 800, usdcSpent: '0.0000000', settlementTx: null });
    expect(r!.steps.length).toBe(2);
    expect(r!.endedAt).toBeInstanceOf(Date);
  });

  it('keeps the model id and per-call lines; old rows come back with model null and no calls', async () => {
    const a = await activeAgent(sql);
    const id = await runs.start({ agentId: a.agentId, mode: 'chat', model: 'anthropic/claude-sonnet-5.5' });
    const step = { n: 1, tools: ['send_email'], calls: [{ tool: 'send_email', line: 'Emailed you: "Hi"' }], inputTokens: 1, outputTokens: 1, finishReason: 'stop' };
    await runs.finish(id, { status: 'done', stopReason: 'done', usage: emptyUsage(), steps: [step] });
    expect(await runs.get(id)).toMatchObject({ model: 'anthropic/claude-sonnet-5.5', steps: [step] });
    expect((await runs.getOwned(a.userId, a.agentId, id))!.model).toBe('anthropic/claude-sonnet-5.5');
    expect((await runs.recent(a.userId, a.agentId)).find((r) => r.id === id)!.model).toBe('anthropic/claude-sonnet-5.5');
    const old = await runs.start({ agentId: a.agentId, mode: 'chat' });
    await sql`update app.runs set steps = ${[{ n: 1, tools: ['x'], inputTokens: 1, outputTokens: 1, finishReason: 'stop' }]} where id = ${old}`;
    const v = (await runs.get(old))!;
    expect(v.model).toBeNull();
    expect(v.steps[0]!.calls).toBeUndefined();
  });

  it('recent is owner-scoped and newest first', async () => {
    const a = await activeAgent(sql);
    const b = await activeAgent(sql);
    const first = await runs.start({ agentId: a.agentId, mode: 'mission' });
    await sql`update app.runs set started_at = now() - interval '1 minute' where id = ${first}`;
    const second = await runs.start({ agentId: a.agentId, mode: 'chat' });
    expect((await runs.recent(a.userId, a.agentId)).map((r) => r.id)).toEqual([second, first]);
    expect(await runs.recent(b.userId, a.agentId)).toEqual([]);
    expect((await runs.recent(a.userId, a.agentId, 1)).length).toBe(1);
  });

  it('getOwned returns only the owner\'s run of that agent', async () => {
    const a = await activeAgent(sql);
    const b = await activeAgent(sql);
    const mine = await runs.start({ agentId: a.agentId, mode: 'chat' });
    const theirs = await runs.start({ agentId: b.agentId, mode: 'chat' });
    expect((await runs.getOwned(a.userId, a.agentId, mine))?.id).toBe(mine);
    expect(await runs.getOwned(b.userId, a.agentId, mine)).toBeNull(); // another user
    expect(await runs.getOwned(a.userId, b.agentId, mine)).toBeNull(); // another agent
    expect(await runs.getOwned(a.userId, a.agentId, theirs)).toBeNull(); // a run of another agent
    expect(await runs.getOwned(a.userId, a.agentId, crypto.randomUUID())).toBeNull(); // unknown id
  });

  it('annotate clips to 400 code points and is write-once', async () => {
    const a = await activeAgent(sql);
    const id = await runs.start({ agentId: a.agentId, mode: 'mission' });
    expect((await runs.get(id))!.summary).toBeNull();
    const emoji = '\u{1F600}'; // one code point, two UTF-16 units
    await runs.annotate(id, emoji.repeat(500));
    const first = (await runs.get(id))!.summary!;
    expect([...first].length).toBe(400);
    expect(first).toBe(emoji.repeat(400)); // no lone surrogate at the cut
    await runs.annotate(id, 'second');
    expect((await runs.get(id))!.summary).toBe(first);
    expect((await runs.recent(a.userId, a.agentId))[0]!.summary).toBe(first);
    const blank = await runs.start({ agentId: a.agentId, mode: 'mission' });
    await runs.annotate(blank, '  ');
    expect((await runs.get(blank))!.summary).toBeNull();
  });

  it('failInterrupted marks running rows as error/interrupted, nothing else', async () => {
    const a = await activeAgent(sql);
    const running = await runs.start({ agentId: a.agentId, mode: 'mission' });
    const done = await runs.start({ agentId: a.agentId, mode: 'chat' });
    await runs.finish(done, { status: 'done', stopReason: 'done', usage: emptyUsage(), steps: [] });
    expect(await runs.failInterrupted()).toBeGreaterThanOrEqual(1);
    expect(await runs.get(running)).toMatchObject({ status: 'error', stopReason: 'interrupted' });
    expect(await runs.get(done)).toMatchObject({ status: 'done' });
  });

  it('failInterrupted never touches a run of a live instance (another replica); it does once that instance is dead', async () => {
    const a = await activeAgent(sql);
    const live = new SQL(url, { max: 1, idleTimeout: 0, maxLifetime: 0 });
    await live`select pg_advisory_lock(${INSTANCE_CLASS}::int4, 777::int4)`;
    const other = createRuns(sql, { instance: 777 });
    const theirs = await other.start({ agentId: a.agentId, mode: 'mission' });
    await runs.failInterrupted();
    expect(await runs.get(theirs)).toMatchObject({ status: 'running' });
    await live.close(); // the replica dies
    expect(await runs.failInterrupted()).toBeGreaterThanOrEqual(1);
    expect(await runs.get(theirs)).toMatchObject({ status: 'error', stopReason: 'interrupted' });
  });

  it('memory upserts by key, refuses bad keys and long values, and caps the key count', async () => {
    const a = await activeAgent(sql);
    expect(await memory.remember(a.agentId, 'city', 'Izmir')).toBe('saved');
    expect(await memory.remember(a.agentId, 'city', 'Ankara')).toBe('saved');
    expect(await memory.all(a.agentId)).toEqual([{ key: 'city', value: 'Ankara' }]);
    expect(await memory.remember(a.agentId, 'Bad Key', 'x')).toBe('invalid');
    expect(await memory.remember(a.agentId, 'long', 'x'.repeat(2001))).toBe('invalid');
    for (let i = 1; i < MEMORY_MAX_KEYS; i++) await memory.remember(a.agentId, `k${i}`, 'v');
    expect(await memory.remember(a.agentId, 'one-too-many', 'v')).toBe('full');
    expect(await memory.remember(a.agentId, 'city', 'Bursa')).toBe('saved'); // an existing key still updates
    const other = await activeAgent(sql);
    expect(await memory.all(other.agentId)).toEqual([]);
  });

  it('memory refuses values with a NUL byte instead of throwing', async () => {
    const a = await activeAgent(sql);
    expect(await memory.remember(a.agentId, 'nul', 'a\u0000b')).toBe('invalid');
    expect(await memory.all(a.agentId)).toEqual([]);
  });

  it('the key cap holds under concurrent writes of new keys', async () => {
    const a = await activeAgent(sql);
    for (let i = 0; i < 95; i++) expect(await memory.remember(a.agentId, `s${i}`, 'v')).toBe('saved');
    const results = await Promise.all(Array.from({ length: 10 }, (_, i) => memory.remember(a.agentId, `c${i}`, 'v')));
    expect(results.filter((r) => r === 'saved').length).toBe(5);
    expect(results.filter((r) => r === 'full').length).toBe(5);
    expect((await memory.all(a.agentId)).length).toBe(MEMORY_MAX_KEYS);
  });

  it('recent falls back to the default limit for a non-integer or NaN limit', async () => {
    const a = await activeAgent(sql);
    await runs.start({ agentId: a.agentId, mode: 'chat' });
    await runs.start({ agentId: a.agentId, mode: 'chat' });
    expect((await runs.recent(a.userId, a.agentId, Number.NaN)).length).toBe(2);
    expect((await runs.recent(a.userId, a.agentId, 1.5)).length).toBe(2);
    expect((await runs.recent(a.userId, a.agentId, Number.POSITIVE_INFINITY)).length).toBe(2);
  });

  it('finish does not overwrite a run that already ended', async () => {
    const a = await activeAgent(sql);
    const id = await runs.start({ agentId: a.agentId, mode: 'chat' });
    await runs.finish(id, { status: 'done', stopReason: 'done', usage: { ...emptyUsage(), inputTokens: 5 }, steps: [] });
    await runs.finish(id, { status: 'error', stopReason: 'late', usage: { ...emptyUsage(), inputTokens: 99 }, steps: [] });
    expect(await runs.get(id)).toMatchObject({ status: 'done', stopReason: 'done', inputTokens: 5 });
  });
});
