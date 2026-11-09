import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'bun:test';
import { createLoop, type Lock, type StageName } from '../src/loop.js';
import { freshDb } from './support/db.js';

let db: Awaited<ReturnType<typeof freshDb>>;
beforeAll(async () => {
  db = await freshDb();
});
afterAll(async () => {
  await db.drop();
});

const NOW = new Date('2026-10-12T12:00:00Z');
const meta = async (key: string) => ((await db.sql`select value from discovery.meta where key = ${key}`) as Array<{ value: string }>)[0]?.value;
const clearMeta = () => db.sql`delete from discovery.meta`;
// A halt is a persisted latch, so no test may inherit another test's marker.
beforeEach(async () => void (await clearMeta()));

const heldLock = (): Lock & { held: boolean; checks: number } => {
  const l = {
    held: true,
    checks: 0,
    async assertHeld() {
      l.checks++;
      return l.held;
    },
  };
  return l;
};

/** Polls until `cond` holds. Each stage tick costs several db round trips, so tests wait on conditions, not on fixed sleeps. */
async function waitFor(cond: () => boolean | Promise<boolean>, ms = 15_000): Promise<void> {
  const t0 = Date.now();
  while (!(await cond())) {
    if (Date.now() - t0 > ms) throw new Error('waitFor timed out');
    await Bun.sleep(10);
  }
}

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => (resolve = r));
  return { promise, resolve };
}

type Calls = Record<StageName, number>;
function harness(over: Partial<Record<StageName, () => Promise<unknown>>> = {}, extra: { lock?: Lock; every?: Partial<Record<StageName, number>> } = {}) {
  const calls: Calls = { registry: 0, events: 0, payments: 0, selfpub: 0, records: 0 };
  const logs: Array<Record<string, string | number>> = [];
  const exits: number[] = [];
  const stages = Object.fromEntries(
    (['registry', 'events', 'payments', 'selfpub', 'records'] as StageName[]).map((n) => [
      n,
      async () => {
        calls[n]++;
        return over[n] ? over[n]!() : { status: 'ok' };
      },
    ]),
  ) as Record<StageName, () => Promise<unknown>>;
  const lock = extra.lock ?? heldLock();
  const loop = createLoop({ stages, sql: db.sql, lock, exit: (c) => void exits.push(c), now: () => NOW, log: (e) => void logs.push(e), every: extra.every });
  return { loop, calls, logs, exits, lock };
}

describe('createLoop', () => {
  it('runs each stage on its own interval and never overlaps a stage with itself', async () => {
    let active = 0;
    let maxActive = 0;
    let slowRuns = 0;
    const h = harness(
      {
        selfpub: async () => {
          slowRuns++;
          active++;
          maxActive = Math.max(maxActive, active);
          await Bun.sleep(60); // longer than its 10 ms interval
          active--;
        },
      },
      { every: { registry: 1_000_000, events: 15, payments: 15, selfpub: 10, records: 1_000_000 } },
    );
    h.loop.start();
    await waitFor(() => slowRuns >= 3 && h.calls.events >= 3);
    await h.loop.stop();
    expect(maxActive).toBe(1);
    expect(h.calls.events).toBeGreaterThan(h.calls.registry); // the 15 ms stage ran many times, the 1000 s stage once
    expect(h.calls.registry).toBe(1);
    expect(h.calls.payments).toBeGreaterThanOrEqual(1);
    // a manual tick on a running stage returns the running one instead of starting a second
    const a = h.loop.tick('records');
    const b = h.loop.tick('records');
    await Promise.all([a, b]);
    expect(h.calls.records).toBe(2); // once at start, once for the two coalesced manual ticks
  });

  it('a failing stage is logged by name and the others keep running', async () => {
    const secret = 'postgres://user:hunter2@host/db';
    const h = harness({ events: async () => Promise.reject(new Error(secret)) });
    await h.loop.tick('events');
    await h.loop.tick('selfpub');
    expect(h.logs).toContainEqual({ event: 'stage_failed', stage: 'events' });
    expect(JSON.stringify(h.logs)).not.toContain('hunter2');
    expect(h.calls.selfpub).toBe(1);
    await clearMeta();
    await h.loop.tick('selfpub');
    expect(await meta('heartbeat_at')).toBeUndefined(); // selfpub only touches our own database and api
  });

  it('only a successful events tick writes the heartbeat; selfpub, records and registry never do', async () => {
    await clearMeta();
    const h = harness({ events: async () => Promise.reject(new Error('x')) });
    for (const n of ['registry', 'selfpub', 'records', 'events'] as StageName[]) await h.loop.tick(n);
    expect(await meta('heartbeat_at')).toBeUndefined();
    const ok = harness();
    await ok.loop.tick('events');
    expect(await meta('heartbeat_at')).toBe(NOW.toISOString());
  });

  it('an events tick that only looked at a suspect ledger is not a healthy tick', async () => {
    await clearMeta();
    const h = harness({ events: async () => ({ applied: 0, status: 'suspect' }) });
    await h.loop.tick('events');
    await h.loop.tick('payments'); // events has not proved the chain yet
    expect(await meta('heartbeat_at')).toBeUndefined();
    expect(h.calls.payments).toBe(0);
  });

  it('payments advance payments_ok_at only when no wallet was due or at least one poll succeeded', async () => {
    const cases: Array<[{ polled: number; failed: number }, boolean]> = [
      [{ polled: 0, failed: 0 }, true],
      [{ polled: 3, failed: 1 }, true],
      [{ polled: 3, failed: 3 }, false], // a Horizon outage: every poll swallowed its error
      [{ polled: 1, failed: 1 }, false],
    ];
    for (const [res, advances] of cases) {
      await clearMeta();
      const h = harness({ payments: async () => ({ ...res, inserted: 0 }) });
      await h.loop.tick('events');
      await h.loop.tick('payments');
      expect({ res, at: await meta('payments_ok_at') }).toEqual({ res, at: advances ? NOW.toISOString() : undefined });
      expect(await meta('heartbeat_at')).toBe(NOW.toISOString()); // the events heartbeat is its own
    }
  });

  it('the events stage also writes indexed_ledger (cursor ledger, else the start ledger)', async () => {
    await clearMeta();
    const h = harness();
    await db.sql`insert into discovery.meta (key, value) values ('events_ledger', '5000')`;
    await h.loop.tick('events');
    expect(await meta('indexed_ledger')).toBe('5000');
    const cursor = `${(7000n << 32n).toString().padStart(19, '0')}-0000000000`;
    await db.sql`insert into discovery.meta (key, value) values ('events_cursor', ${cursor})`;
    await h.loop.tick('events');
    expect(await meta('indexed_ledger')).toBe('7000');
    await clearMeta();
    await h.loop.tick('selfpub');
    expect(await meta('indexed_ledger')).toBeUndefined();
  });

  it('stop waits for a running stage', async () => {
    const gate = deferred();
    const h = harness({ selfpub: async () => gate.promise });
    const running = h.loop.tick('selfpub');
    let stopped = false;
    const stopping = h.loop.stop().then(() => (stopped = true));
    await Bun.sleep(50);
    expect(stopped).toBe(false);
    gate.resolve();
    await running;
    await stopping;
    expect(stopped).toBe(true);
  });

  it('stop gives up on a stuck stage after the drain time', async () => {
    const gate = deferred();
    const logs: Array<Record<string, string | number>> = [];
    const stuck = createLoop({
      stages: { registry: async () => {}, events: async () => {}, payments: async () => {}, selfpub: async () => gate.promise, records: async () => {} },
      sql: db.sql,
      lock: heldLock(),
      exit: () => {},
      drainMs: 40,
      log: (e) => void logs.push(e),
    });
    void stuck.tick('selfpub');
    const t0 = Date.now();
    await stuck.stop();
    expect(Date.now() - t0).toBeLessThan(1000);
    gate.resolve();
  });

  it('start runs the registry stage before the others', async () => {
    const order: string[] = [];
    // payments is skipped until events has had a healthy tick, so it needs a short interval to run after it
    const h = harness({}, { every: { registry: 1_000_000, events: 1_000_000, payments: 20, selfpub: 1_000_000, records: 1_000_000 } });
    const mk = (n: StageName) => async () => void order.push(n);
    const loop = createLoop({
      stages: { registry: mk('registry'), events: mk('events'), payments: mk('payments'), selfpub: mk('selfpub'), records: mk('records') },
      sql: db.sql,
      lock: h.lock,
      exit: () => {},
      log: () => {},
      every: { registry: 1_000_000, events: 1_000_000, payments: 20, selfpub: 1_000_000, records: 1_000_000 },
    });
    loop.start();
    await waitFor(() => new Set(order).size >= 5);
    await loop.stop();
    expect(order[0]).toBe('registry');
    expect(new Set(order)).toEqual(new Set(['registry', 'events', 'payments', 'selfpub', 'records']));
  });

  it('rejects an unknown stage name', async () => {
    const h = harness();
    await expect(h.loop.tick('nope')).rejects.toThrow();
  });

  it('reportStats logs ticks and wall time per stage, numbers only, then resets', async () => {
    const h = harness({ selfpub: async () => void (await Bun.sleep(20)) });
    await h.loop.tick('selfpub');
    await h.loop.tick('selfpub');
    await h.loop.tick('events');
    h.loop.reportStats();
    const self = h.logs.find((l) => l.event === 'stage_stats' && l.stage === 'selfpub')!;
    expect(self).toMatchObject({ ticks: 2 });
    expect(self.ms_total as number).toBeGreaterThanOrEqual(38);
    expect(self.ms_max as number).toBeGreaterThanOrEqual(19);
    expect(h.logs.find((l) => l.event === 'stage_stats' && l.stage === 'events')).toMatchObject({ ticks: 1 });
    const proc = h.logs.find((l) => l.event === 'process_stats')!;
    expect(Object.values(proc).every((v) => typeof v === 'string' || Number.isFinite(v))).toBe(true);
    h.logs.length = 0;
    h.loop.reportStats();
    expect(h.logs.filter((l) => l.event === 'stage_stats')).toEqual([]);
  });

  it('stop wakes every sleeping runner at once, however long the intervals', async () => {
    const h = harness({}, { every: { registry: 3_600_000, events: 3_600_000, payments: 3_600_000, selfpub: 3_600_000, records: 3_600_000 } });
    h.loop.start();
    await waitFor(() => h.calls.events >= 1 && h.calls.records >= 1);
    const t0 = Date.now();
    await h.loop.stop();
    expect(Date.now() - t0).toBeLessThan(1_000); // well inside the 5 s drain: nothing was left waiting on a timer
  });
});

describe('chain_reset halts for good', () => {
  for (const source of ['registry', 'events'] as const) {
    it(`a chain_reset from the ${source} stage stops the events and payments stages and logs indexer_halted once`, async () => {
      await clearMeta();
      const h = harness({ [source]: async () => ({ status: 'chain_reset' }) });
      await h.loop.tick(source);
      const before = { events: h.calls.events, payments: h.calls.payments };
      for (let i = 0; i < 3; i++) {
        await h.loop.tick('events');
        await h.loop.tick('payments');
        await h.loop.tick(source);
      }
      // events and payments never ran again (the events stage counts its own reset call once)
      expect(h.calls.payments).toBe(before.payments);
      expect(h.calls.events).toBe(before.events);
      expect(h.logs.filter((l) => l.event === 'indexer_halted')).toEqual([{ event: 'indexer_halted', reason: 'chain_reset' }]);
      // the other stages keep running and report healthy
      await h.loop.tick('selfpub');
      await h.loop.tick('records'); // records writes proven sales against the index: it stops too
      expect(h.calls.selfpub).toBe(1);
      expect(h.calls.records).toBe(0);
      expect(await meta('heartbeat_at')).toBeUndefined(); // selfpub and records ticks never make a halted index look fresh
      expect(await meta('halted')).toBe('chain_reset');
    });

    it(`a ${source} reset is not a healthy tick`, async () => {
      await clearMeta();
      const h = harness({ [source]: async () => ({ status: 'chain_reset' }) });
      await h.loop.tick(source);
      expect(await meta('heartbeat_at')).toBeUndefined();
      expect(await meta('indexed_ledger')).toBeUndefined();
    });
  }

  it('a running loop stops polling events and payments after a reset and keeps the rest going', async () => {
    let resetNow = false;
    const h = harness(
      { registry: async () => (resetNow ? { status: 'chain_reset' } : { status: 'ok' }) },
      { every: { registry: 20, events: 10, payments: 10, selfpub: 10, records: 10 } },
    );
    h.loop.start();
    await waitFor(() => h.calls.events >= 2 && h.calls.payments >= 2);
    resetNow = true;
    await waitFor(() => h.logs.some((l) => l.event === 'indexer_halted'));
    await Bun.sleep(300); // let a stage that was already running at the halt finish
    const frozen = { events: h.calls.events, payments: h.calls.payments, selfpub: h.calls.selfpub, records: h.calls.records };
    await waitFor(() => h.calls.selfpub >= frozen.selfpub + 2);
    await h.loop.stop();
    expect(h.calls.events).toBe(frozen.events);
    expect(h.calls.payments).toBe(frozen.payments);
    expect(h.calls.records).toBe(frozen.records);
    expect(h.calls.selfpub).toBeGreaterThan(frozen.selfpub);
    expect(h.logs.filter((l) => l.event === 'indexer_halted').length).toBe(1);
  });

  const SLOW = { registry: 1_000_000, events: 1_000_000, payments: 1_000_000, selfpub: 1_000_000, records: 1_000_000 };

  it('a halt survives a restart: neither events, payments nor records run', async () => {
    await clearMeta();
    await db.sql`insert into discovery.meta (key, value) values ('halted', 'chain_reset')`;
    const h = harness({}, { every: SLOW });
    h.loop.start();
    await waitFor(() => h.calls.selfpub >= 1);
    await h.loop.stop();
    expect(h.calls.events + h.calls.payments + h.calls.records).toBe(0);
    expect(h.logs).toContainEqual({ event: 'indexer_halted', reason: 'chain_reset' });
    expect(await meta('halted')).toBe('chain_reset'); // never cleared by the process
  });

  it('an unreadable halted marker fails closed', async () => {
    const calls = { events: 0, payments: 0, registry: 0 };
    const logs: Array<Record<string, string | number>> = [];
    const failing = ((strings: TemplateStringsArray, ...v: unknown[]) => {
      if (strings.join('?').includes("key = 'halted'")) return Promise.reject(new Error('db down'));
      return (db.sql as unknown as (s: TemplateStringsArray, ...v: unknown[]) => unknown)(strings, ...v);
    }) as unknown as typeof db.sql;
    const ok = async () => ({ status: 'ok' });
    const loop = createLoop({
      stages: { registry: async () => (calls.registry++, ok()), events: async () => (calls.events++, ok()), payments: async () => (calls.payments++, ok()), selfpub: ok, records: ok },
      sql: failing,
      lock: heldLock(),
      exit: () => {},
      every: SLOW,
      log: (e) => void logs.push(e),
    });
    loop.start();
    await Bun.sleep(300);
    await loop.stop();
    expect(calls).toEqual({ events: 0, payments: 0, registry: 0 });
    expect(logs).toContainEqual({ event: 'indexer_halted', reason: 'halt_marker_unreadable' });
  });

  it('a follower-detected reset stays halted after restart', async () => {
    await clearMeta();
    const first = harness({ events: async () => ({ status: 'chain_reset' }) });
    await first.loop.tick('events');
    expect(await meta('halted')).toBe('chain_reset');
    const second = harness({}, { every: SLOW });
    second.loop.start();
    await waitFor(() => second.calls.selfpub >= 1);
    await second.loop.stop();
    expect(second.calls.events + second.calls.payments + second.calls.registry + second.calls.records).toBe(0);
    expect(second.logs).toContainEqual({ event: 'indexer_halted', reason: 'chain_reset' });
  });

  it('after a follower-raised halt the registry stage writes nothing more', async () => {
    await clearMeta();
    const h = harness({ events: async () => ({ status: 'chain_reset' }) });
    await h.loop.tick('events');
    const before = h.calls.registry;
    await h.loop.tick('registry');
    await h.loop.tick('registry');
    expect(h.calls.registry).toBe(before);
  });

  it('a halt whose marker write fails is retried', async () => {
    await clearMeta();
    let fails = 2;
    const flaky = ((strings: TemplateStringsArray, ...v: unknown[]) => {
      if (strings.join('?').includes('insert into discovery.meta') && v[0] === 'halted' && fails-- > 0) return Promise.reject(new Error('blip'));
      return (db.sql as unknown as (s: TemplateStringsArray, ...v: unknown[]) => unknown)(strings, ...v);
    }) as unknown as typeof db.sql;
    const loop = createLoop({
      stages: { registry: async () => ({ status: 'chain_reset' }), events: async () => ({}), payments: async () => ({}), selfpub: async () => ({}), records: async () => ({}) },
      sql: flaky,
      lock: heldLock(),
      exit: () => {},
      sleep: async () => {},
      log: () => {},
    });
    await loop.tick('registry');
    await waitFor(async () => (await meta('halted')) === 'chain_reset');
    expect(fails).toBe(-1);
    await loop.stop();
  });

  it('a halt marker write that fails 10+ times keeps retrying, stays halted in memory, and persists once the db recovers', async () => {
    await clearMeta();
    let fails = 12;
    const sleeps: number[] = [];
    const logs: Array<Record<string, string | number>> = [];
    const exits: number[] = [];
    const calls = { events: 0, records: 0 };
    const flaky = ((strings: TemplateStringsArray, ...v: unknown[]) => {
      if (strings.join('?').includes('insert into discovery.meta') && v[0] === 'halted' && fails-- > 0) return Promise.reject(new Error('db down'));
      return (db.sql as unknown as (s: TemplateStringsArray, ...v: unknown[]) => unknown)(strings, ...v);
    }) as unknown as typeof db.sql;
    const loop = createLoop({
      stages: { registry: async () => ({ status: 'chain_reset' }), events: async () => (calls.events++, {}), payments: async () => ({}), selfpub: async () => ({}), records: async () => (calls.records++, {}) },
      sql: flaky,
      lock: heldLock(),
      exit: (c) => void exits.push(c),
      sleep: async (ms) => void sleeps.push(ms),
      every: { registry: 1_000_000, events: 1_000_000, payments: 1_000_000, selfpub: 1_000_000, records: 1_000_000 },
      log: (e) => void logs.push(e),
    });
    await loop.tick('registry');
    await waitFor(async () => (await meta('halted')) === 'chain_reset');
    expect(fails).toBeLessThan(0);
    expect(logs.filter((l) => l.event === 'halt_marker_failed').length).toBe(12);
    expect(sleeps.length).toBe(12);
    expect(Math.max(...sleeps)).toBeLessThanOrEqual(30_000);
    expect(sleeps[1]).toBeGreaterThan(sleeps[0]!); // backs off
    await loop.tick('events'); // stayed halted
    await loop.tick('records'); // the in-memory latch alone stops records
    expect(calls.events).toBe(0);
    expect(calls.records).toBe(0);
    expect(exits).toEqual([]);
    await loop.stop();
  });

  it('payments does not tick before the first successful events tick', async () => {
    await clearMeta();
    let eventsOk = false;
    const h = harness({ events: async () => { if (!eventsOk) throw new Error('rpc down'); return { status: 'ok' }; } });
    await h.loop.tick('payments');
    await h.loop.tick('events'); // throws inside, logged
    await h.loop.tick('payments');
    expect(h.calls.payments).toBe(0);
    eventsOk = true;
    await h.loop.tick('events');
    await h.loop.tick('payments');
    expect(h.calls.payments).toBe(1);
  });

  it('a throwing first registry tick starts nothing', async () => {
    await clearMeta();
    let fail = true;
    const h = harness({ registry: async () => { if (fail) throw new Error('rpc down'); return { status: 'ok' }; } }, { every: { ...SLOW, registry: 20 } });
    h.loop.start();
    await waitFor(() => h.calls.registry >= 3); // retried, not skipped
    expect(h.calls.events + h.calls.payments + h.calls.selfpub + h.calls.records).toBe(0);
    fail = false;
    await waitFor(() => h.calls.events >= 1 && h.calls.records >= 1);
    await h.loop.stop();
  });

  it('stop() with an unpersisted halt makes one bounded final write and logs halt_lost_on_shutdown when it fails', async () => {
    await clearMeta();
    let haltWrites = 0;
    const logs: Array<Record<string, string | number>> = [];
    const flaky = ((strings: TemplateStringsArray, ...v: unknown[]) => {
      if (strings.join('?').includes('insert into discovery.meta') && v[0] === 'halted') {
        haltWrites++;
        return Promise.reject(new Error('db down'));
      }
      return (db.sql as unknown as (s: TemplateStringsArray, ...v: unknown[]) => unknown)(strings, ...v);
    }) as unknown as typeof db.sql;
    const mk = () =>
      createLoop({
        stages: { registry: async () => ({ status: 'chain_reset' }), events: async () => ({}), payments: async () => ({}), selfpub: async () => ({}), records: async () => ({}) },
        sql: flaky,
        lock: heldLock(),
        exit: () => {},
        sleep: () => Bun.sleep(1_000_000), // the background retry never fires again before stop()
        log: (e) => void logs.push(e),
        finalWriteMs: 200,
      });
    const loop = mk();
    await loop.tick('registry'); // one inline failed write; the retry is parked in its sleep
    expect(haltWrites).toBe(1);
    await loop.stop();
    expect(haltWrites).toBe(2); // exactly one final write
    expect(logs.filter((l) => l.event === 'halt_lost_on_shutdown').length).toBe(1);
    expect(JSON.stringify(logs)).not.toContain('db down');
  });

  it('stop() with an unpersisted halt persists it when the final write succeeds', async () => {
    await clearMeta();
    let fails = 1;
    const logs: Array<Record<string, string | number>> = [];
    const flaky = ((strings: TemplateStringsArray, ...v: unknown[]) => {
      if (strings.join('?').includes('insert into discovery.meta') && v[0] === 'halted' && fails-- > 0) return Promise.reject(new Error('blip'));
      return (db.sql as unknown as (s: TemplateStringsArray, ...v: unknown[]) => unknown)(strings, ...v);
    }) as unknown as typeof db.sql;
    const loop = createLoop({
      stages: { registry: async () => ({ status: 'chain_reset' }), events: async () => ({}), payments: async () => ({}), selfpub: async () => ({}), records: async () => ({}) },
      sql: flaky,
      lock: heldLock(),
      exit: () => {},
      sleep: () => Bun.sleep(1_000_000),
      log: (e) => void logs.push(e),
    });
    await loop.tick('registry');
    expect(await meta('halted')).toBeUndefined();
    await loop.stop();
    expect(await meta('halted')).toBe('chain_reset');
    expect(logs.some((l) => l.event === 'halt_lost_on_shutdown')).toBe(false);
  });

  it('lock loss with an unpersisted halt makes the final write, logs halt_lost_on_shutdown on failure, and still exits 1', async () => {
    await clearMeta();
    const logs: Array<Record<string, string | number>> = [];
    const exits: number[] = [];
    const lock = heldLock();
    const flaky = ((strings: TemplateStringsArray, ...v: unknown[]) => {
      if (strings.join('?').includes('insert into discovery.meta') && v[0] === 'halted') return Promise.reject(new Error('db down'));
      return (db.sql as unknown as (s: TemplateStringsArray, ...v: unknown[]) => unknown)(strings, ...v);
    }) as unknown as typeof db.sql;
    const loop = createLoop({
      stages: { registry: async () => ({ status: 'chain_reset' }), events: async () => ({}), payments: async () => ({}), selfpub: async () => ({}), records: async () => ({}) },
      sql: flaky,
      lock,
      exit: (c) => void exits.push(c),
      sleep: () => Bun.sleep(1_000_000),
      log: (e) => void logs.push(e),
      finalWriteMs: 200,
    });
    await loop.tick('registry');
    lock.held = false;
    await loop.tick('selfpub');
    expect(exits).toEqual([1]);
    expect(logs.filter((l) => l.event === 'halt_lost_on_shutdown').length).toBe(1);
    await loop.stop();
  });
});

describe('singleton lock', () => {
  it('the loop calls assertHeld every tick and exits non-zero when the lock is lost', async () => {
    const lock = heldLock();
    const h = harness({}, { lock });
    await h.loop.tick('selfpub');
    await h.loop.tick('records');
    expect(lock.checks).toBe(2);
    expect(h.exits).toEqual([]);

    lock.held = false;
    const ran = h.calls.registry + h.calls.events + h.calls.payments + h.calls.selfpub + h.calls.records;
    await h.loop.tick('events');
    expect(h.exits).toEqual([1]);
    expect(h.logs).toContainEqual({ event: 'singleton_lost' });
    // no stage ran after the failed check, and later ticks stay dead without re-reporting
    await h.loop.tick('selfpub');
    await h.loop.tick('payments');
    expect(h.calls.registry + h.calls.events + h.calls.payments + h.calls.selfpub + h.calls.records).toBe(ran);
    expect(h.exits).toEqual([1]);
    expect(h.logs.filter((l) => l.event === 'singleton_lost').length).toBe(1);
  });

  it('a running loop stops by itself when the lock is lost', async () => {
    const lock = heldLock();
    const h = harness({}, { lock, every: { registry: 10, events: 10, payments: 10, selfpub: 10, records: 10 } });
    h.loop.start();
    await waitFor(() => h.calls.selfpub >= 2);
    lock.held = false;
    await waitFor(() => h.exits.length > 0);
    expect(h.exits).toEqual([1]);
    await Bun.sleep(300); // a stage already past its lock check may still finish
    const frozen = h.calls.selfpub;
    await Bun.sleep(300);
    expect(h.calls.selfpub).toBe(frozen);
    await h.loop.stop();
  });

  it('an assertHeld that throws counts as lost (fail closed)', async () => {
    const h = harness({}, { lock: { assertHeld: () => Promise.reject(new Error('boom')) } });
    await h.loop.tick('selfpub');
    expect(h.exits).toEqual([1]);
    expect(h.calls.selfpub).toBe(0);
  });
});

describe('hung tick', () => {
  const mk = (over: Partial<Record<StageName, () => Promise<unknown>>>, lock: Lock = heldLock()) => {
    const logs: Array<Record<string, string | number>> = [];
    const exits: number[] = [];
    const ok = async () => ({ status: 'ok' });
    const loop = createLoop({
      stages: { registry: ok, events: ok, payments: ok, selfpub: ok, records: ok, ...over },
      sql: db.sql,
      lock,
      exit: (c) => void exits.push(c),
      tickTimeoutMs: 50,
      log: (e) => void logs.push(e),
    });
    return { loop, logs, exits };
  };

  // Seen live 2026-10-20: an events call that never settled froze heartbeat_at for a week without a single log line.
  it('a stage that never settles is logged by name and exits 1, and the heartbeat is not written', async () => {
    const h = mk({ events: () => new Promise(() => {}) });
    await h.loop.tick('events');
    expect(h.logs).toContainEqual({ event: 'tick_hung', stage: 'events' });
    expect(h.exits).toEqual([1]);
    expect(await meta('heartbeat_at')).toBeUndefined();
  });

  it('a lock check that never settles is a hang too', async () => {
    const h = mk({}, { assertHeld: () => new Promise<boolean>(() => {}) });
    await h.loop.tick('selfpub');
    expect(h.logs).toContainEqual({ event: 'tick_hung', stage: 'selfpub' });
    expect(h.exits).toEqual([1]);
  });

  it('after a hang no further tick runs and the exit is reported once', async () => {
    let selfpub = 0;
    const h = mk({ events: () => new Promise(() => {}), selfpub: async () => void selfpub++ });
    await h.loop.tick('events');
    await h.loop.tick('selfpub');
    expect(selfpub).toBe(0);
    expect(h.exits).toEqual([1]);
    expect(h.logs.filter((l) => l.event === 'tick_hung').length).toBe(1);
  });

  it('a slow tick inside the deadline is not a hang', async () => {
    const h = mk({ selfpub: () => Bun.sleep(10) });
    await h.loop.tick('selfpub');
    await Bun.sleep(80); // past the deadline: the cleared timer must not fire
    expect(h.exits).toEqual([]);
    expect(h.logs).toEqual([]);
  });
});
