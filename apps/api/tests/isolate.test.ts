import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { _resetPoolForTests, createPool, defaultPoolSize, poolSnapshot, runIsolated, shutdownPool } from '../src/tools/isolate.js';
import { runSandboxed } from '../src/tools/sandbox.js';

const alive = (pid: number) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};
const until = async (f: () => boolean, ms: number) => {
  const end = Date.now() + ms;
  while (!f() && Date.now() < end) await Bun.sleep(10);
  return f();
};

describe('isolate pool (real child processes)', () => {
  beforeAll(() => _resetPoolForTests());
  afterAll(() => shutdownPool());

  it('kills a runaway job, reaps its child, and the pool keeps serving', async () => {
    const run = runSandboxed('while (true) {}', null, { hardKillMs: 400 });
    expect(await until(() => poolSnapshot().busyPids.length > 0, 15_000)).toBe(true);
    const [pid] = poolSnapshot().busyPids as [number];
    expect(await run).toEqual({ ok: false, error: 'killed', fault: 'code' });
    expect(await until(() => !alive(pid), 1_000)).toBe(true);
    expect(await runSandboxed('return 1', null)).toEqual({ ok: true, value: 1 });
  }, 30_000);

  it('kills a job stuck inside WASM (the Worker.terminate escape)', async () => {
    const t = Date.now();
    const r = await runSandboxed('const a=new Array(300000).fill("ab"); for(;;){ a.join(",") }', null, { hardKillMs: 500 });
    expect(r.ok).toBe(false);
    expect(Date.now() - t).toBeLessThan(15_000);
  }, 30_000);

  it('does not let code break out of the wrapper (the code is never spliced)', async () => {
    const r = await runSandboxed('return 1})); (["[" + "1,".repeat(3000000) + "1]"]) || ((function(){', null);
    expect(r.ok).toBe(false);
  }, 15_000);

  it('runs at most pool-size jobs at once, queues the rest, and answers busy past the queue', async () => {
    let maxBusy = 0;
    const sampler = setInterval(() => (maxBusy = Math.max(maxBusy, poolSnapshot().busyPids.length)), 5);
    const rs = await Promise.all(Array.from({ length: 30 }, (_, i) => runSandboxed('let s = 0; for (let i = 0; i < 300000; i++) s += i; return input', i)));
    clearInterval(sampler);
    const busy = rs.filter((r) => !r.ok && r.error === 'busy' && r.fault === 'platform').length;
    const done = rs.filter((r) => r.ok).length;
    expect(busy + done).toBe(30);
    expect(busy).toBeGreaterThanOrEqual(10);
    expect(maxBusy).toBeLessThanOrEqual(4);
    expect(maxBusy).toBeGreaterThan(0);
  }, 60_000);

  it('keeps no state between jobs, even in the same child', async () => {
    for (let i = 0; i < 12; i++) await runSandboxed('globalThis.leak = 1; return 1', null);
    for (let i = 0; i < 12; i++) expect(await runSandboxed('return typeof globalThis.leak', null)).toEqual({ ok: true, value: 'undefined' });
  }, 30_000);

  it('rejects input that cannot be serialized, fast', async () => {
    const t = Date.now();
    expect(await runSandboxed('return 1', { f: () => 1 })).toEqual({ ok: false, error: 'bad input', fault: 'platform' });
    expect(await runSandboxed('return 1', () => 1)).toEqual({ ok: false, error: 'bad input', fault: 'platform' });
    expect(await runSandboxed('return 1', { n: 1n })).toEqual({ ok: false, error: 'bad input', fault: 'platform' });
    const cyc: Record<string, unknown> = {};
    cyc.self = cyc;
    expect(await runSandboxed('return 1', cyc)).toEqual({ ok: false, error: 'bad input', fault: 'platform' });
    expect(Date.now() - t).toBeLessThan(3_000);
  });

  it('reports deep recursion as a failure without printing to stderr', async () => {
    const orig = process.stderr.write.bind(process.stderr);
    let wrote = '';
    process.stderr.write = ((s: string | Uint8Array) => ((wrote += String(s)), true)) as typeof process.stderr.write;
    try {
      const r = await runSandboxed('function f(n){ return f(n+1)+1 } return f(0)', null);
      expect(r.ok).toBe(false);
      expect(await runSandboxed('return 2', null)).toEqual({ ok: true, value: 2 });
    } finally {
      process.stderr.write = orig;
    }
    expect(wrote).toBe('');
  }, 30_000);

  it('shutdown kills the children and fails queued and later jobs with a fixed error', async () => {
    const pool = createPool({ size: 1, queueMax: 4 });
    const first = pool.run('js', { code: 'return 1', input: 'null' }, 3_000);
    expect(await first).toEqual({ ok: true, value: 1 });
    const stuck = pool.run('js', { code: 'while(true){}', input: 'null' }, 30_000);
    const queued = pool.run('js', { code: 'return 2', input: 'null' }, 3_000);
    await until(() => pool.snapshot().busyPids.length === 1, 5_000);
    const [pid] = pool.snapshot().busyPids as [number];
    await pool.shutdown();
    expect(await stuck).toEqual({ ok: false, error: 'error', fault: 'platform' });
    expect(await queued).toEqual({ ok: false, error: 'error', fault: 'platform' });
    expect(await pool.run('js', { code: 'return 3', input: 'null' }, 3_000)).toEqual({ ok: false, error: 'error', fault: 'platform' });
    expect(alive(pid)).toBe(false);
  }, 30_000);

  it('recycles a child after the configured number of jobs', async () => {
    const pool = createPool({ size: 1, recycleAfter: 3 });
    // Each job holds ~100 ms inside QuickJS, so the 10 ms poll always sees the child busy (a ~1 ms job was missed, flaking the test).
    const HOLD = 'const end = Date.now() + 100; while (Date.now() < end) {} return 1';
    const pidOf = async () => {
      const r = pool.run('js', { code: HOLD, input: 'null' }, 3_000);
      await until(() => pool.snapshot().busyPids.length > 0, 10_000);
      const p = pool.snapshot().busyPids[0];
      await r;
      return p;
    };
    const a = await pidOf();
    await pidOf();
    await pidOf();
    const d = await pidOf();
    expect(d).not.toBe(a);
    expect(await until(() => !alive(a!), 1_000)).toBe(true);
    await pool.shutdown();
  }, 30_000);
});

describe('isolate pool: sizing and memory retirement', () => {
  it('defaults to min(4, cores), at least 1', () => {
    expect([0, 1, 2, 4, 10].map(defaultPoolSize)).toEqual([1, 1, 2, 4, 4]);
  });

  it('a child above the RSS threshold retires after its reply; the next job gets a fresh child', async () => {
    const events: Record<string, string>[] = [];
    const pool = createPool({ size: 1, childRssRetireBytes: 1, log: (e) => events.push(e) });
    const HOLD = 'const end = Date.now() + 100; while (Date.now() < end) {} return 1';
    const pidOf = async () => {
      const r = pool.run('js', { code: HOLD, input: 'null' }, 3_000);
      await until(() => pool.snapshot().busyPids.length > 0, 10_000);
      const p = pool.snapshot().busyPids[0];
      expect(await r).toEqual({ ok: true, value: 1 });
      return p;
    };
    const a = await pidOf();
    const b = await pidOf();
    expect(b).not.toBe(a);
    expect(await until(() => !alive(a!), 2_000)).toBe(true);
    expect(events.filter((e) => e.event === 'isolate_child_retired')).toEqual([{ event: 'isolate_child_retired', reason: 'rss' }, { event: 'isolate_child_retired', reason: 'rss' }]);
    await pool.shutdown();
  }, 30_000);

  it('a child under the threshold keeps serving (the default 250 MB is not hit by a small job)', async () => {
    const pool = createPool({ size: 1 });
    const HOLD = 'const end = Date.now() + 100; while (Date.now() < end) {} return 1';
    const pidOf = async () => {
      const r = pool.run('js', { code: HOLD, input: 'null' }, 3_000);
      await until(() => pool.snapshot().busyPids.length > 0, 10_000);
      const p = pool.snapshot().busyPids[0];
      await r;
      return p;
    };
    expect(await pidOf()).toBe(await pidOf());
    await pool.shutdown();
  }, 30_000);
});

const tmp = () => mkdtempSync(join(tmpdir(), 'isolate-test-'));
const BUN_INJECTED_ENV: string[] = []; // keys Bun itself adds to a child's env, listed explicitly (none observed)

describe('isolate pool: no secrets reach the children', () => {
  it('a child sees only PATH, even when the parent has secrets and the cwd holds a .env', async () => {
    process.env.FAKE_SECRET_PARENT = 'parent-secret';
    const dir = tmp();
    writeFileSync(join(dir, '.env'), 'FAKE_SECRET=from-dotenv\nFAKE_SECRET2=x\n');
    const pool = createPool({ size: 1, testKinds: true, cwd: dir });
    const r = await pool.run('env', {}, 5_000);
    const plain = createPool({ size: 1, testKinds: true });
    const r2 = await plain.run('env', {}, 5_000);
    delete process.env.FAKE_SECRET_PARENT;
    await pool.shutdown();
    await plain.shutdown();
    for (const x of [r, r2]) {
      expect(x.ok).toBe(true);
      const keys = (x as { value: string[] }).value.sort();
      expect(keys.filter((k) => k !== 'PATH' && !BUN_INJECTED_ENV.includes(k))).toEqual([]);
    }
  }, 20_000);

  it('test-only job kinds are not reachable from the shared pool', async () => {
    const r = await runIsolated('env' as never, {}, 3_000);
    expect(r.ok).toBe(false);
  });
});

describe('isolate pool: boot failures do not storm', () => {
  const failingChild = (script: string) => {
    const dir = tmp();
    const path = join(dir, 'child.ts');
    writeFileSync(path, script);
    return { path, spawns: () => { try { return readFileSync(join(dir, 'spawns.log'), 'utf8').length; } catch { return 0; } } };
  };

  it('after 3 consecutive pre-ready exits it stops spawning and fails callers fast', async () => {
    const c = failingChild("import { appendFileSync } from 'node:fs';\nappendFileSync(import.meta.dir + '/spawns.log', 'x');\nprocess.exit(1);\n");
    const events: Record<string, string>[] = [];
    const pool = createPool({ size: 4, childPath: c.path, cooldownMs: 5_000, log: (e) => events.push(e) });
    const t = Date.now();
    const job = () => pool.run('js', { code: 'x', input: 'null' }, 3_000);
    const rs = await Promise.all([job(), job()]);
    expect(rs).toEqual([{ ok: false, error: 'unavailable', fault: 'platform' }, { ok: false, error: 'unavailable', fault: 'platform' }]);
    expect(Date.now() - t).toBeLessThan(4_000);
    const spawned = c.spawns();
    expect(spawned).toBeLessThanOrEqual(6);
    expect(events).toEqual([{ event: 'isolate_pool_unavailable' }]); // logged once, fixed message
    const t2 = Date.now();
    expect(await job()).toEqual({ ok: false, error: 'unavailable', fault: 'platform' });
    expect(Date.now() - t2).toBeLessThan(100);
    await Bun.sleep(300);
    expect(c.spawns()).toBe(spawned);
    await pool.shutdown();
  }, 20_000);

  it('a successful ready resets the counter', async () => {
    // spawns 1,2 and 4,5 fail before ready; 3 and 6 are healthy. Without a reset, spawn 4 would trip the cooldown.
    const c = failingChild(`import { appendFileSync, readFileSync } from 'node:fs';
const log = import.meta.dir + '/spawns.log';
appendFileSync(log, 'x');
const n = readFileSync(log, 'utf8').length;
if ([1, 2, 4, 5].includes(n)) process.exit(1);
process.stdout.write('{"ready":true}\\n');
const reader = Bun.stdin.stream().getReader();
const dec = new TextDecoder();
for (;;) {
  const { done, value } = await reader.read();
  if (done) break;
  for (const line of dec.decode(value).split('\\n')) {
    if (!line) continue;
    const job = JSON.parse(line);
    if (job.code === 'die') process.exit(1);
    process.stdout.write(JSON.stringify({ id: job.id, ok: true, value: job.code }) + '\\n');
  }
}
`);
    const pool = createPool({ size: 1, childPath: c.path, cooldownMs: 5_000 });
    expect(await pool.run('js', { code: 'a', input: 'null' }, 3_000)).toEqual({ ok: true, value: 'a' });
    expect(await pool.run('js', { code: 'die', input: 'null' }, 3_000)).toEqual({ ok: false, error: 'error', fault: 'platform' });
    expect(await pool.run('js', { code: 'b', input: 'null' }, 3_000)).toEqual({ ok: true, value: 'b' });
    await pool.shutdown();
  }, 20_000);
});

describe('isolate pool: a tainted child never takes down the next job', () => {
  const TAINT = 'let a=[]; for(let i=0;i<30000;i++) a=[a]; return a';
  const job = (pool: ReturnType<typeof createPool>, code: string) => pool.run('js', { code, input: 'null' }, 10_000);

  it('size 1, back to back: the tainting job is a code fault, the next one succeeds', async () => {
    const pool = createPool({ size: 1 });
    const r1 = await job(pool, TAINT);
    expect(r1).toMatchObject({ ok: false, fault: 'code' });
    expect(await job(pool, 'return 42')).toEqual({ ok: true, value: 42 });
    await pool.shutdown();
  }, 30_000);

  it('size 1, concurrent: the queued job behind the tainting one succeeds', async () => {
    const pool = createPool({ size: 1 });
    const [r1, r2] = await Promise.all([job(pool, TAINT), job(pool, 'return 42')]);
    expect(r1).toMatchObject({ ok: false, fault: 'code' });
    expect(r2).toEqual({ ok: true, value: 42 });
    await pool.shutdown();
  }, 30_000);

  const exitingChild = (diesOnJobs: string) => {
    const dir = tmp();
    const path = join(dir, 'child.ts');
    writeFileSync(path, `import { appendFileSync, readFileSync } from 'node:fs';
const log = import.meta.dir + '/spawns.log';
appendFileSync(log, 'x');
const spawn = readFileSync(log, 'utf8').length;
process.stdout.write('{"ready":true}\\n');
const reader = Bun.stdin.stream().getReader();
const dec = new TextDecoder();
for (;;) {
  const { done, value } = await reader.read();
  if (done) break;
  for (const line of dec.decode(value).split('\\n')) {
    if (!line) continue;
    const j = JSON.parse(line);
    if (${diesOnJobs}) process.exit(0); // exits without replying
    process.stdout.write(JSON.stringify({ id: j.id, ok: true, value: j.code }) + '\\n');
    if (j.code === 'a' && spawn === 1) process.exit(0); // replies, then exits WITHOUT announcing retirement
  }
}
`);
    return path;
  };

  it('a child that exits right after a reply without announcing it: the next job is re-queued once and succeeds', async () => {
    const pool = createPool({ size: 1, childPath: exitingChild('false') });
    const [a, b] = await Promise.all([job(pool, 'a'), job(pool, 'b')]);
    expect(a).toEqual({ ok: true, value: 'a' });
    expect(b).toEqual({ ok: true, value: 'b' });
    await pool.shutdown();
  }, 20_000);

  it('the re-queue is bounded: a job whose children keep dying fails as platform after one retry', async () => {
    const pool = createPool({ size: 1, childPath: exitingChild("j.code === 'b'") });
    expect(await job(pool, 'a')).toEqual({ ok: true, value: 'a' });
    const t = Date.now();
    expect(await job(pool, 'b')).toEqual({ ok: false, error: 'error', fault: 'platform' });
    expect(Date.now() - t).toBeLessThan(10_000);
    expect(await job(pool, 'c')).toEqual({ ok: true, value: 'c' });
    await pool.shutdown();
  }, 20_000);
});

describe('isolate pool: watchdog', () => {
  it('a child stuck in a main-thread spin dies within ~2 s of its parent being SIGKILLed', async () => {
    const parent = Bun.spawn([process.execPath, '--no-env-file', join(import.meta.dir, 'support/pool-parent.ts')], { stdout: 'pipe', stderr: 'ignore' });
    const reader = parent.stdout.getReader();
    let seen = '';
    while (!/PID \d+/.test(seen)) {
      const { done, value } = await reader.read();
      if (done) break;
      seen += new TextDecoder().decode(value);
    }
    const pid = Number(/PID (\d+)/.exec(seen)?.[1]);
    expect(pid).toBeGreaterThan(0);
    expect(alive(pid)).toBe(true);
    parent.kill('SIGKILL');
    await parent.exited;
    const t = Date.now();
    const died = await until(() => !alive(pid), 4_000);
    if (!died) process.kill(pid, 'SIGKILL');
    expect(died).toBe(true);
    expect(Date.now() - t).toBeLessThan(3_000);
  }, 30_000);
});

describe('isolate pool: abort and shutdown latch', () => {
  it('an aborted queued job leaves the queue; an aborted running job is SIGKILLed and answers aborted', async () => {
    const pool = createPool({ size: 1, queueMax: 4 });
    const ac1 = new AbortController();
    const running = pool.run('js', { code: 'while(true){}', input: 'null' }, 30_000, ac1.signal);
    const ac2 = new AbortController();
    const queued = pool.run('js', { code: 'return 1', input: 'null' }, 30_000, ac2.signal);
    await until(() => pool.snapshot().busyPids.length === 1, 10_000);
    const [pid] = pool.snapshot().busyPids as [number];
    expect(pool.snapshot().queued).toBe(1);
    ac2.abort();
    expect(await queued).toEqual({ ok: false, error: 'aborted', fault: 'platform' });
    expect(pool.snapshot().queued).toBe(0);
    ac1.abort();
    expect(await running).toEqual({ ok: false, error: 'aborted', fault: 'platform' });
    expect(await until(() => !alive(pid), 2_000)).toBe(true);
    const pre = new AbortController();
    pre.abort();
    expect(await pool.run('js', { code: 'return 1', input: 'null' }, 3_000, pre.signal)).toEqual({ ok: false, error: 'aborted', fault: 'platform' });
    expect(await pool.run('js', { code: 'return 5', input: 'null' }, 5_000)).toEqual({ ok: true, value: 5 });
    await pool.shutdown();
  }, 40_000);

  it('after shutdownPool the shared pool answers error and builds no new pool until reset', async () => {
    _resetPoolForTests();
    expect(await runIsolated('js', { code: 'return 1', input: 'null' }, 5_000)).toEqual({ ok: true, value: 1 });
    await shutdownPool();
    expect(await runIsolated('js', { code: 'return 1', input: 'null' }, 5_000)).toEqual({ ok: false, error: 'error', fault: 'platform' });
    expect(poolSnapshot().children).toBe(0);
    _resetPoolForTests();
    expect(await runIsolated('js', { code: 'return 2', input: 'null' }, 5_000)).toEqual({ ok: true, value: 2 });
    await shutdownPool();
  }, 30_000);
});
