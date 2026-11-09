import { describe, expect, it } from 'bun:test';
import { LOCAL_FILES, armDeadline, listTestFiles, partitionTests, postgresAnswers, remoteTestEnv } from '../scripts/test-remote.js';
import { testTimeoutMs } from './support/db.js';

const IN_NETWORK = 'postgres://postgres:test@servel-infra-agentenact-cloud-test-postgres:5432/agentenact_cloud_test';

describe('remote test runner', () => {
  it('points the suite at the in-network test database and nothing else', () => {
    expect(remoteTestEnv()).toEqual({ TEST_DATABASE_URL: IN_NETWORK });
  });

  it('has no path that syncs env files or sponsor secrets', async () => {
    const text = await Bun.file(new URL('../scripts/test-remote.ts', import.meta.url)).text();
    expect(text).not.toContain('.env');
    expect(text).not.toContain('SPONSOR_SECRET');
  });
});

describe('local/remote partition', () => {
  const apiDir = new URL('..', import.meta.url).pathname;

  it('runs every test file exactly once, in the local or the remote part', () => {
    const all = listTestFiles(apiDir);
    const { local, remote } = partitionTests(all);
    expect([...local, ...remote].sort()).toEqual(all);
    expect(local.filter((f) => remote.includes(f))).toEqual([]);
  });

  it('keeps only existing files in LOCAL_FILES', () => {
    const all = listTestFiles(apiDir);
    for (const f of LOCAL_FILES) expect(all).toContain(f);
    expect(partitionTests(all).local.sort()).toEqual([...LOCAL_FILES].sort());
  });
});

describe('testTimeoutMs', () => {
  const saved = process.env.TEST_DATABASE_URL;
  const withUrl = (url: string | undefined) => {
    if (url === undefined) delete process.env.TEST_DATABASE_URL;
    else process.env.TEST_DATABASE_URL = url;
    return testTimeoutMs();
  };
  it('allows 30 s through a port-forward and 5 s inside the network', () => {
    try {
      expect(withUrl('postgres://postgres:test@localhost:55439/agentenact_cloud_test')).toBe(30000);
      expect(withUrl('postgres://postgres:test@127.0.0.1:55439/agentenact_cloud_test')).toBe(30000);
      expect(withUrl(IN_NETWORK)).toBe(5000);
      expect(withUrl(undefined)).toBe(5000);
    } finally {
      if (saved === undefined) delete process.env.TEST_DATABASE_URL;
      else process.env.TEST_DATABASE_URL = saved;
    }
  });
});

describe('port-forward probe and part deadline', () => {
  const urlOf = (port: number) => `postgres://postgres:test@127.0.0.1:${port}/x`;
  const serve = (socket: { data?(s: { write(d: Uint8Array): number }, d: Uint8Array): void }) =>
    Bun.listen({ hostname: '127.0.0.1', port: 0, socket: { data: socket.data ?? (() => {}), open() {}, close() {}, error() {} } });

  it('is not fooled by a TCP peer that accepts and never speaks Postgres (silent, or echoing like a self-connect)', async () => {
    const silent = serve({});
    const echo = serve({ data: (s, d) => void s.write(d) });
    try {
      const t0 = Date.now();
      expect(await postgresAnswers(urlOf(silent.port), 700)).toBe(false);
      expect(await postgresAnswers(urlOf(echo.port), 700)).toBe(false);
      expect(Date.now() - t0).toBeLessThan(4000);
    } finally {
      silent.stop(true);
      echo.stop(true);
    }
  });

  it('is false when nothing listens', async () => {
    const l = serve({});
    const port = l.port;
    l.stop(true);
    expect(await postgresAnswers(urlOf(port), 700)).toBe(false);
  });

  it('the deadline kills only the children it is given, then reports timed out', async () => {
    const mine = Bun.spawn(['sleep', '30'], { stdout: 'ignore', stderr: 'ignore' });
    const other = Bun.spawn(['sleep', '30'], { stdout: 'ignore', stderr: 'ignore' });
    try {
      const guard = armDeadline(50, () => [mine]);
      await mine.exited;
      expect(guard.timedOut()).toBe(true);
      expect(other.killed).toBe(false);
      expect(other.exitCode).toBeNull();
      const quiet = armDeadline(60_000, () => [other]);
      quiet.disarm();
      expect(quiet.timedOut()).toBe(false);
    } finally {
      other.kill();
    }
  });
});
