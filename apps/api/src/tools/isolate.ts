/**
 * A small pool of long-lived child processes for untrusted CPU work (spec §7): QuickJS user code and
 * Readability over hostile HTML. A Worker cannot be stopped while it is stuck inside WASM and shares the
 * api's heap; a process can be SIGKILLed and costs the api nothing. One job per child at a time, a bounded
 * FIFO queue, a hard per-job deadline (SIGKILL, then a replacement), recycling after RECYCLE_AFTER jobs and
 * on any crash or malformed line. Children start lazily on first use and get no secrets (explicit env, no
 * .env file, a neutral cwd). Children that keep dying before `ready` trip a cooldown (no respawn storm).
 * Never throws: every failure is a fixed word.
 */
import { availableParallelism } from 'node:os';
import { fileURLToPath } from 'node:url';

/**
 * `fault` says which side failed. `code`: the job ran (or ran too long) and the user's code or markup is the
 * cause: the child's own failures, and `killed` at the per-job deadline. `platform`: the pool itself
 * (busy, unavailable, aborted, a child crash, shutdown, bad input). Only this file assigns it: a child reply
 * is never trusted for it, so user code cannot pose as a pool fault by throwing the pool's words.
 */
export type IsolateFault = 'code' | 'platform';
export type IsolateResult<T = unknown> = { ok: true; value: T } | { ok: false; error: string; fault: IsolateFault };
const platform = (error: string): IsolateResult => ({ ok: false, error, fault: 'platform' });

/** An idle child is ~94 MB and a busy one far more: never more children than cores, 4 at most. */
export const defaultPoolSize = (parallelism: number = availableParallelism()) => Math.max(1, Math.min(4, parallelism));
export const POOL_SIZE = defaultPoolSize();
/** A child whose RSS is above this after a job announces `retire` (a fresh one costs ~100 ms; a 1 GB host cannot afford a fat one). */
export const CHILD_RSS_RETIRE_BYTES = 250 * 1024 * 1024;
export const QUEUE_MAX = 16;
export const RECYCLE_AFTER = 200;
export const CHILD_BOOT_MS = 10_000;
/** A queued job that no child picks up in this long answers `busy`. */
export const QUEUE_WAIT_MS = 15_000;
const MAX_LINE_CHARS = 1_000_000;
/** This many consecutive children exiting before `ready` and the pool stops spawning for COOLDOWN_MS. */
export const BOOT_FAIL_LIMIT = 3;
export const COOLDOWN_MS = 5_000;
const CHILD_PATH = fileURLToPath(new URL('./isolate-child.ts', import.meta.url));
/** Neutral cwd: Bun looks for .env/bunfig in the cwd, and module resolution does not depend on it. */
const CHILD_CWD = '/';

interface Job {
  id: number;
  line: string;
  deadlineMs: number;
  resolve: (r: IsolateResult) => void;
  waitTimer?: ReturnType<typeof setTimeout>;
  child?: Child;
  /** Set once a child died under this job right after answering another: it is re-queued once, never twice. */
  requeued?: boolean;
}
interface Child {
  proc: Bun.Subprocess<'pipe', 'pipe', 'ignore'>;
  pid: number;
  ready: boolean;
  jobs: number;
  job?: Job;
  timer?: ReturnType<typeof setTimeout>;
  dead: boolean;
}

export type JobKind = 'js' | 'extract' | 'env' | 'spin';

export interface Pool {
  run(kind: JobKind, payload: Record<string, unknown>, deadlineMs: number, signal?: AbortSignal): Promise<IsolateResult>;
  snapshot(): { children: number; busyPids: number[]; queued: number };
  shutdown(): Promise<void>;
}

export interface PoolOptions {
  size?: number;
  queueMax?: number;
  recycleAfter?: number;
  cooldownMs?: number;
  /** Test seam: the child's RSS retirement threshold (default CHILD_RSS_RETIRE_BYTES). */
  childRssRetireBytes?: number;
  /** Receives fixed events only (never an error object). The api wires its own logger. */
  log?: (e: Record<string, string>) => void;
  /** Test seams. `testKinds` enables the child's `env` and `spin` jobs; no production caller sets it. */
  testKinds?: boolean;
  childPath?: string;
  cwd?: string;
}

export function createPool(o: PoolOptions = {}): Pool {
  const size = o.size ?? POOL_SIZE;
  const queueMax = o.queueMax ?? QUEUE_MAX;
  const recycleAfter = o.recycleAfter ?? RECYCLE_AFTER;
  const cooldownMs = o.cooldownMs ?? COOLDOWN_MS;
  const childArgs = [process.execPath, '--no-env-file', o.childPath ?? CHILD_PATH, ...(o.testKinds ? ['--test-kinds'] : []), `--rss-retire-bytes=${o.childRssRetireBytes ?? CHILD_RSS_RETIRE_BYTES}`];
  const children = new Set<Child>();
  const queue: Job[] = [];
  let nextId = 1;
  let closed = false;
  let bootFails = 0;
  let coolUntil = 0;

  const cooling = () => Date.now() < coolUntil;

  function retire(c: Child, why: 'error' | 'killed' | 'recycle' | 'aborted'): void {
    if (c.dead) return;
    c.dead = true;
    children.delete(c);
    clearTimeout(c.timer);
    try {
      c.proc.kill('SIGKILL');
    } catch {
      // already gone
    }
    void c.proc.exited.catch(() => {}); // reaped by the runtime; the handle is released here
    const j = c.job;
    c.job = undefined;
    // A child that answered a job and then exited (e.g. a tainted heap) can take the next job down with it
    // before that job ran. Hand it back to the queue front once; a second death fails it as before.
    if (j && why === 'error' && c.jobs > 0 && !j.requeued && !closed) {
      j.requeued = true;
      j.child = undefined;
      queue.unshift(j);
      armWait(j);
    } else if (j) j.resolve(why === 'killed' ? { ok: false, error: 'killed', fault: 'code' } : platform(why === 'aborted' ? 'aborted' : 'error'));
    if (!c.ready && !closed && ++bootFails >= BOOT_FAIL_LIMIT && !cooling()) {
      coolUntil = Date.now() + cooldownMs;
      o.log?.({ event: 'isolate_pool_unavailable' });
      for (const q of queue.splice(0)) {
        clearTimeout(q.waitTimer);
        q.resolve(platform('unavailable'));
      }
    }
    pump();
  }

  function armWait(job: Job): void {
    job.waitTimer = setTimeout(() => {
      const i = queue.indexOf(job);
      if (i >= 0) {
        queue.splice(i, 1);
        job.resolve(platform('busy'));
      }
    }, QUEUE_WAIT_MS);
  }

  function onLine(c: Child, line: string): void {
    let m: { ready?: true; id?: number; ok?: boolean; value?: unknown; error?: unknown; retire?: unknown };
    try {
      m = JSON.parse(line);
    } catch {
      return retire(c, 'error');
    }
    if (m.ready === true && !c.ready) {
      c.ready = true;
      bootFails = 0;
      clearTimeout(c.timer);
      return pump();
    }
    const j = c.job;
    if (!j || m.id !== j.id || typeof m.ok !== 'boolean') return retire(c, 'error');
    clearTimeout(c.timer);
    c.job = undefined;
    c.jobs++;
    // Whatever the child says, its failures are the user's code: it never gets to choose `fault`.
    j.resolve(m.ok ? { ok: true, value: m.value } : { ok: false, error: typeof m.error === 'string' ? m.error.slice(0, 200) : 'error', fault: 'code' });
    // `retire` is the child announcing it exits after this reply: never hand it another job.
    if (m.retire === 'rss') o.log?.({ event: 'isolate_child_retired', reason: 'rss' });
    if (m.retire === true || m.retire === 'rss' || c.jobs >= recycleAfter) retire(c, 'recycle');
    else pump();
  }

  async function readLoop(c: Child): Promise<void> {
    const decoder = new TextDecoder();
    let buf = '';
    try {
      const reader = c.proc.stdout.getReader();
      for (;;) {
        const { done, value: chunk } = await reader.read();
        if (done) break;
        buf += decoder.decode(chunk, { stream: true });
        let nl: number;
        while (!c.dead && (nl = buf.indexOf('\n')) >= 0) {
          const line = buf.slice(0, nl);
          buf = buf.slice(nl + 1);
          onLine(c, line);
        }
        if (c.dead) return;
        if (buf.length > MAX_LINE_CHARS) return retire(c, 'error');
      }
    } catch {
      // fall through: the child is gone
    }
    retire(c, 'error');
  }

  function spawn(): void {
    let proc: Child['proc'];
    try {
      proc = Bun.spawn(childArgs, { stdin: 'pipe', stdout: 'pipe', stderr: 'ignore', cwd: o.cwd ?? CHILD_CWD, env: { PATH: process.env.PATH ?? '' } });
    } catch {
      return;
    }
    const c: Child = { proc, pid: proc.pid, ready: false, jobs: 0, dead: false };
    c.timer = setTimeout(() => retire(c, 'error'), CHILD_BOOT_MS);
    children.add(c);
    void readLoop(c);
    void proc.exited.then(() => retire(c, 'error'));
  }

  function pump(): void {
    if (closed) return;
    for (const c of children) {
      if (!c.ready || c.job || c.dead) continue;
      const j = queue.shift();
      if (!j) break;
      clearTimeout(j.waitTimer);
      c.job = j;
      j.child = c;
      c.timer = setTimeout(() => retire(c, 'killed'), j.deadlineMs);
      try {
        c.proc.stdin.write(j.line);
        void c.proc.stdin.flush();
      } catch {
        retire(c, 'error');
      }
    }
    // Replacements and the first start are lazy: only while a job is waiting for a child that is not coming.
    if (cooling()) return;
    const booting = [...children].filter((c) => !c.ready).length;
    for (let want = Math.min(queue.length - booting, size - children.size); want > 0; want--) spawn();
  }

  return {
    run(kind, payload, deadlineMs, signal) {
      if (closed) return Promise.resolve(platform('error'));
      if (signal?.aborted) return Promise.resolve(platform('aborted'));
      if (cooling()) return Promise.resolve(platform('unavailable'));
      if (queue.length >= queueMax && ![...children].some((c) => c.ready && !c.job)) return Promise.resolve(platform('busy'));
      return new Promise<IsolateResult>((resolveRaw) => {
        const id = nextId++;
        const onAbort = () => {
          const i = queue.indexOf(job);
          if (i >= 0) {
            queue.splice(i, 1);
            clearTimeout(job.waitTimer);
            job.resolve(platform('aborted'));
          } else if (job.child) retire(job.child, 'aborted');
        };
        const resolve = (r: IsolateResult) => {
          signal?.removeEventListener('abort', onAbort);
          resolveRaw(r);
        };
        let line: string;
        try {
          line = `${JSON.stringify({ id, kind, ...payload })}\n`;
        } catch {
          return resolve(platform('bad input'));
        }
        const job: Job = { id, line, deadlineMs, resolve };
        armWait(job);
        signal?.addEventListener('abort', onAbort, { once: true });
        queue.push(job);
        pump();
      });
    },
    snapshot: () => ({ children: children.size, busyPids: [...children].filter((c) => c.job).map((c) => c.pid), queued: queue.length }),
    async shutdown() {
      closed = true;
      for (const j of queue.splice(0)) {
        clearTimeout(j.waitTimer);
        j.resolve(platform('error'));
      }
      const exits = [...children].map((c) => c.proc.exited.catch(() => {}));
      for (const c of [...children]) retire(c, 'error');
      await Promise.all(exits);
    },
  };
}

let shared: Pool | undefined;
/** Latched by shutdownPool: nothing may start children once the process is shutting down. */
let shutDown = false;
let sharedLog: PoolOptions['log'];
/** Wires the shared pool's logger (main.ts). */
export const setIsolateLog = (log: PoolOptions['log']): void => void (sharedLog = log);
let sharedSize: number | undefined;
/** Sizes the shared pool from config (main.ts); takes effect for the pool built after this call. */
export const setIsolatePoolSize = (n: number | undefined): void => void (sharedSize = n);
const pool = () => (shared ??= createPool({ size: sharedSize, log: (e) => sharedLog?.(e) }));
export const runIsolated = (kind: 'js' | 'extract', payload: Record<string, unknown>, deadlineMs: number, signal?: AbortSignal): Promise<IsolateResult> =>
  shutDown ? Promise.resolve(platform('error')) : pool().run(kind, payload, deadlineMs, signal);
export const poolSnapshot = () => (shared ?? { snapshot: () => ({ children: 0, busyPids: [] as number[], queued: 0 }) }).snapshot();
export async function shutdownPool(): Promise<void> {
  shutDown = true;
  const p = shared;
  shared = undefined;
  await p?.shutdown();
}
/** Test-only: clears the shutdown latch so a later test file can use the shared pool again. */
export function _resetPoolForTests(): void {
  shutDown = false;
}
