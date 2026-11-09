/**
 * Runs the api suite inside servel's network, so the tests reach the test Postgres directly instead of
 * through a ~100 ms-per-query port-forward. No Docker on this machine: servel does the building.
 *
 *   bun run test:remote [bun test args]      e.g.  bun run test:remote tests/runs.test.ts
 *
 * How it works (verified 2026-10-12, servel dev, server KN, infra @agentenact-cloud-test on norastech):
 *   1. Stage a clean copy in a temp dir from an ALLOWLIST (package files, libs, src, tests, scripts,
 *      migrations/). Nothing else is copied, so no env file, no servel state and no node_modules can leave.
 *   2. `servel dev start --no-sync` uploads it, builds Dockerfile.dev on the server and starts a sandbox
 *      container. The staged files are mounted over /app, hiding anything the image installed there, so the
 *      image only warms bun's package cache (a cached layer) and `bun install --frozen-lockfile` runs in the
 *      sandbox, as the P4 brief says (cold ~13 s, warm cache faster).
 *      Sandbox containers are on the swarm network, so `servel-infra-agentenact-cloud-test-postgres:5432`
 *      resolves there (no --link-infra needed; that flag would print the infra admin credentials).
 *      The dev wrapper first apt-installs build tools and npm when missing (minutes), so the image ships them.
 *      It then attaches a healthcheck whose command is malformed (servel bug: the Test array is
 *      ["CMD-SHELL", "CMD-SHELL bash -c '</dev/tcp/127.0.0.1/3000' ..."], so the shell runs a program literally
 *      named CMD-SHELL), which fails forever and gets the container SIGKILLed ("unhealthy container", exit 137)
 *      about 45 s in, mid-suite. The image ships a CMD-SHELL shim (exec "$@") and run.sh serves a stub on :3000,
 *      so the check passes. The sandbox has 1 CPU and 6 GB.
 *   3. `servel exec <service> -- sh -c 'bun test ...'` streams the output and returns the exit code.
 *      (`servel dev logs` returns nothing for these sandboxes, so exec is the channel.)
 *   4. `servel dev stop --force` runs in a finally, on every path including SIGINT / SIGTERM.
 *
 * Hybrid: three CPU-bound files cannot meet their hard-coded deadlines on the 1-CPU sandbox, so they run on this
 * Mac (in parallel with the remote part) against the test database through the port-forward. One combined
 * summary is printed; the exit code is non-zero if either part fails. See LOCAL_FILES.
 *
 * Fallback if `servel dev` ever cannot reach the database: a one-shot container on the same network is the
 * only other servel-native route (`servel job`); document it here when it is needed.
 */
import { Glob, type Subprocess } from 'bun';
import { cp, mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { env as hostEnv } from 'node:process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const TEST_DB_URL =
  'postgres://postgres:test@servel-infra-agentenact-cloud-test-postgres:5432/agentenact_cloud_test';

/** The sandbox is capped at 1 CPU, several times slower than a laptop: bun's 5 s default is too tight there.
 * Passed as `--timeout`: a preload's setDefaultTimeout only reaches the first test file. */
const TIMEOUT_MS = 30_000;

/** Environment for the remote run: only the in-network test database URL (a test value, not a secret). */
export function remoteTestEnv(): Record<string, string> {
  return { TEST_DATABASE_URL: TEST_DB_URL };
}

/** Test files that run on this machine instead of in the sandbox.
 * CPU-bound, and the sandbox has 1 CPU: servel dev has no CPU option. Remove once servel adds one. */
export const LOCAL_FILES = ['tests/isolate.test.ts', 'tests/sandbox.test.ts', 'tests/scheduler.test.ts'];

const LOCAL_DB_URL = 'postgres://postgres:test@localhost:55439/agentenact_cloud_test';
const PORT_FORWARD_CMD = 'servel port-forward @agentenact-cloud-test:5432 55439';

/** Every test file bun would run, relative to apps/api, sorted. */
export function listTestFiles(apiDir: string): string[] {
  return [...new Glob('tests/**/*.test.ts').scanSync({ cwd: apiDir })].sort();
}

/** Splits test files into the local part and the remote part. Every file lands in exactly one. */
export function partitionTests(files: string[], local: string[] = LOCAL_FILES): { local: string[]; remote: string[] } {
  const isLocal = new Set(local);
  return { local: files.filter((f) => isLocal.has(f)), remote: files.filter((f) => !isLocal.has(f)) };
}

const API_DIR = new URL('..', import.meta.url).pathname;
const ROOT_DIR = new URL('../../..', import.meta.url).pathname;
/** Copied from apps/api. Anything not listed here never leaves this machine. */
const API_ALLOWLIST = ['package.json', 'bun.lock', 'bunfig.toml', 'tsconfig.json', 'libs', 'src', 'tests', 'scripts'];

const DOCKERFILE = `FROM oven/bun:1.3.11
RUN apt-get update -qq && apt-get install -y -qq --no-install-recommends python3 make g++ git nodejs npm && rm -rf /var/lib/apt/lists/*
RUN printf '#!/bin/sh\\nexec "$@"\\n' > /usr/local/bin/CMD-SHELL && chmod +x /usr/local/bin/CMD-SHELL
WORKDIR /opt/warm
COPY apps/api/package.json apps/api/bun.lock ./
COPY apps/api/libs ./libs
RUN bun install --frozen-lockfile
WORKDIR /app
COPY . .
CMD ["sh", "run.sh"]
`;

async function stage(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'aec-test-remote-'));
  await mkdir(join(dir, 'apps'), { recursive: true });
  for (const name of API_ALLOWLIST) {
    await cp(join(API_DIR, name), join(dir, 'apps/api', name), { recursive: true }).catch((e: NodeJS.ErrnoException) => {
      if (e.code !== 'ENOENT') throw e;
    });
  }
  await cp(join(ROOT_DIR, 'migrations'), join(dir, 'migrations'), { recursive: true });
  await writeFile(join(dir, 'Dockerfile.dev'), DOCKERFILE);
  // servel's dev wrapper health-checks TCP :3000 and kills a container that does not listen (exit 137 after ~45 s,
  // in the middle of the suite). Listen on it; the suite itself is started through `servel exec`.
  await writeFile(join(dir, 'run.sh'), `bun -e 'Bun.serve({ port: 3000, fetch: () => new Response("ok") })' &\nwait\n`);
  await writeFile(join(dir, 'package.json'), JSON.stringify({ name: 'aec-test-remote', private: true, scripts: { dev: 'sh run.sh' } }));
  await writeFile(
    join(dir, 'servel.yaml'),
    `name: ${SESSION_NAME}\ndev:\n  command: sh run.sh\n  dockerfile: Dockerfile.dev\n  build_method: dockerfile\n`,
  );
  return dir;
}

/** servel tags the image by project name plus a hash that ignores Dockerfile.dev, so the name carries the content. */
const SESSION_NAME = `aec-test-${new Bun.CryptoHasher('sha256').update(DOCKERFILE).digest('hex').slice(0, 8)}`;

const shq = (s: string) => `'${s.replaceAll("'", `'\\''`)}'`;

/** Runs servel with captured output (echoed), so the session id can be read from it. */
async function servelCapture(args: string[], cwd: string, live?: Set<Subprocess>): Promise<{ code: number; out: string }> {
  const proc = Bun.spawn(['servel', ...args], { cwd, stdin: 'ignore', stdout: 'pipe', stderr: 'pipe' });
  live?.add(proc);
  const [out, err] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text()]);
  const code = await proc.exited;
  live?.delete(proc);
  process.stderr.write(err);
  return { code, out: out + err };
}

type PartResult = { code: number; summary: string };

/** Sums bun's "N pass / N fail" lines from captured output. */
function tally(text: string): { pass: number; fail: number } {
  const n = (re: RegExp) => Number(re.exec(text)?.[1] ?? 0);
  return { pass: n(/^\s*(\d+) pass$/m), fail: n(/^\s*(\d+) fail$/m) };
}

/** Each part (local, remote) gets this long. Overridable for the self-test of the deadline. */
export const PART_DEADLINE_MS = Number(hostEnv.TEST_REMOTE_DEADLINE_MS) || 15 * 60_000;
const PROBE_TIMEOUT_MS = 3_000;

/**
 * True only when a real Postgres answers `select 1` through the forward. A bare TCP connect is not proof: 55439 is in
 * macOS's ephemeral port range, so with the forward down a connect to localhost:55439 can pick 55439 as its own
 * source port and "connect" to itself, then wait forever for a server that is its own socket.
 */
export async function postgresAnswers(url: string, timeoutMs = PROBE_TIMEOUT_MS): Promise<boolean> {
  const sql = new Bun.SQL(url, { max: 1, connectionTimeout: Math.ceil(timeoutMs / 1000) });
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const rows = await Promise.race([
      sql`select 1 as ok`,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error('probe timeout')), timeoutMs);
      }),
    ]);
    return rows[0]?.ok === 1;
  } catch {
    return false;
  } finally {
    clearTimeout(timer);
    // close() can itself wait on a wedged connection: never let it hold the run.
    void Promise.resolve(sql.close({ timeout: 0 })).catch(() => {});
  }
}

const portForwardUp = () => postgresAnswers(LOCAL_DB_URL);

/** Kills only the given children (the ones this runner started) when the part runs past `ms`. Returns a disarm fn and a flag. */
export function armDeadline(ms: number, children: () => Iterable<Subprocess>): { timedOut: () => boolean; disarm: () => void } {
  let fired = false;
  const timer = setTimeout(() => {
    fired = true;
    for (const c of children()) c.kill('SIGTERM');
  }, ms);
  return { timedOut: () => fired, disarm: () => clearTimeout(timer) };
}

/** Runs the CPU-bound files on this machine, output captured and echoed with a prefix-free passthrough. */
async function runLocal(files: string[]): Promise<PartResult> {
  if (files.length === 0) return { code: 0, summary: 'local: no files' };
  if (!(await portForwardUp())) {
    console.error(`local part needs the test database on localhost:55439. Start the port-forward:\n  ${PORT_FORWARD_CMD}`);
    return { code: 1, summary: 'local: port-forward is down' };
  }
  const proc = Bun.spawn(['bun', 'test', '--timeout', String(TIMEOUT_MS), ...files.map((f) => `./${f}`)], {
    cwd: API_DIR,
    stdin: 'ignore',
    stdout: 'pipe',
    stderr: 'pipe',
    env: { ...hostEnv, TEST_DATABASE_URL: LOCAL_DB_URL },
  });
  const guard = armDeadline(PART_DEADLINE_MS, () => [proc]);
  const [out, err] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text()]);
  const code = await proc.exited;
  guard.disarm();
  process.stderr.write(`--- local (${files.length} files) ---\n${err}`);
  const t = tally(err + out);
  if (guard.timedOut()) return { code: 1, summary: `local: timed out after ${Math.round(PART_DEADLINE_MS / 1000)}s (${t.pass} pass, ${t.fail} fail so far)` };
  return { code, summary: `local ${t.pass} pass, ${t.fail} fail` };
}

async function runRemote(files: string[], filtered: boolean): Promise<PartResult> {
  if (files.length === 0 && filtered) return { code: 0, summary: 'remote: no files' };
  const dir = await stage();
  let session: string | undefined;
  let stopping: Promise<void> | undefined;
  const live = new Set<Subprocess>();
  const guard = armDeadline(PART_DEADLINE_MS, () => [...live]);
  const cleanup = (): Promise<void> => {
    stopping ??= (async () => {
      if (session) {
        const stop = await servelCapture(['dev', 'stop', session, '--force'], dir);
        if (stop.code !== 0) console.error(`servel dev stop ${session} failed; run it by hand`);
      }
      await rm(dir, { recursive: true, force: true });
    })();
    return stopping;
  };
  const onSignal = () => void cleanup().finally(() => process.exit(130));
  for (const sig of ['SIGINT', 'SIGTERM'] as const) process.on(sig, onSignal);
  try {
    const started = await servelCapture(
      ['dev', 'start', '--name', SESSION_NAME, '--new', '--no-sync', '--no-public-url', '--no-claude', '--no-auth', '--yes'],
      dir,
      live,
    );
    if (guard.timedOut()) return { code: 1, summary: `remote: timed out after ${Math.round(PART_DEADLINE_MS / 1000)}s while starting the sandbox` };
    session = /session_id=(dev-[a-z0-9-]+)/.exec(started.out)?.[1] ?? /servel dev stop (dev-[a-z0-9-]+)/.exec(started.out)?.[1];
    if (started.code !== 0 || !session) {
      console.error(started.out);
      return { code: 1, summary: 'remote: sandbox did not start' };
    }
    const env = Object.entries(remoteTestEnv()).map(([k, v]) => `${k}=${shq(v)}`);
    const cmd = `cd /app/apps/api && bun install --frozen-lockfile && ${env.join(' ')} bun test --timeout ${TIMEOUT_MS} ${files.map((f) => shq(`./${f}`)).join(' ')}`;
    const exec = Bun.spawn(['servel', 'exec', `servel-dev-${session}`, '--', 'sh', '-c', cmd], {
      cwd: dir,
      stdin: 'ignore',
      stdout: 'pipe',
      stderr: 'pipe',
    });
    live.add(exec);
    const [out, err] = await Promise.all([new Response(exec.stdout).text(), new Response(exec.stderr).text()]);
    const code = await exec.exited;
    live.delete(exec);
    process.stderr.write(`--- remote (${files.length} files) ---\n${err}${out}`);
    const t = tally(err + out);
    if (guard.timedOut()) return { code: 1, summary: `remote: timed out after ${Math.round(PART_DEADLINE_MS / 1000)}s (${t.pass} pass, ${t.fail} fail so far)` };
    return { code, summary: `remote ${t.pass} pass, ${t.fail} fail` };
  } finally {
    guard.disarm();
    await cleanup();
    for (const sig of ['SIGINT', 'SIGTERM'] as const) process.off(sig, onSignal);
  }
}

/** Optional args are substring filters on file paths (like bun test); no args runs everything. */
async function main(args: string[]): Promise<number> {
  const all = listTestFiles(API_DIR);
  const files = args.length ? all.filter((f) => args.some((a) => f.includes(a.replace(/^\.\//, '')))) : all;
  if (files.length === 0) {
    console.error('no test files match');
    return 1;
  }
  const parts = partitionTests(files);
  const started = Date.now();
  const [remote, local] = await Promise.all([runRemote(parts.remote, args.length > 0), runLocal(parts.local)]);
  const secs = Math.round((Date.now() - started) / 1000);
  const code = remote.code !== 0 || local.code !== 0 ? 1 : 0;
  console.log(`\n${code === 0 ? 'OK' : 'FAILED'}: ${remote.summary}; ${local.summary}; ${secs}s wall`);
  return code;
}

if (import.meta.main) process.exit(await main(process.argv.slice(2)));
