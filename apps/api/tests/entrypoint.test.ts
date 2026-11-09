import { describe, expect, it } from 'bun:test';
import { readdir } from 'node:fs/promises';
import { join } from 'node:path';

const ENTRYPOINT = new URL('../entrypoint.sh', import.meta.url).pathname;
const SRC = new URL('../src/', import.meta.url).pathname;
const DOCKERFILES = { api: new URL('../Dockerfile', import.meta.url).pathname, vault: new URL('../Dockerfile.vault', import.meta.url).pathname };

/** Runs the entrypoint with `env` as the command: prints the environment the real process would get. */
async function childEnv(mode: string, parent: Record<string, string>): Promise<Record<string, string>> {
  const p = Bun.spawn(['/bin/sh', ENTRYPOINT, mode, '/usr/bin/env', '-0'], { env: parent, stdout: 'pipe', stderr: 'pipe' });
  const out = await new Response(p.stdout).text();
  expect(await p.exited).toBe(0);
  const vars: Record<string, string> = {};
  for (const entry of out.split('\0').filter(Boolean)) {
    const i = entry.indexOf('=');
    vars[entry.slice(0, i)] = entry.slice(i + 1);
  }
  return vars;
}

/** Every NAME the source reads as env.NAME, env?.NAME, env['NAME'], need/count/onOff('NAME') or a 'MODEL_*' role name. */
async function namesReadInSrc(): Promise<Set<string>> {
  const names = new Set<string>();
  const walk = async (dir: string): Promise<void> => {
    for (const e of await readdir(dir, { withFileTypes: true })) {
      const p = join(dir, e.name);
      if (e.isDirectory()) await walk(p);
      else if (/\.ts$/.test(e.name)) {
        const text = await Bun.file(p).text();
        for (const m of text.matchAll(/\benv(?:\?\.|\.)([A-Z][A-Z0-9_]+)|\benv\[['"]([A-Z][A-Z0-9_]+)['"]\]|\b(?:need|count|onOff)\('([A-Z][A-Z0-9_]+)'|'(MODEL_[A-Z0-9_]+)'/g)) names.add(m[1] ?? m[2] ?? m[3] ?? m[4]!);
      }
    }
  };
  await walk(SRC);
  return names;
}

// What the servel link to agentenact-supabase injects (names seen on the live api, 2026-10-26; values are dummies).
const injected = {
  SUPABASE_DB_URL: 'postgres://postgres:dummy@db:5432/postgres',
  SUPABASE_POSTGRES_PASSWORD: 'dummy-1',
  SUPABASE_JWT_SECRET: 'dummy-2',
  SUPABASE_SERVICE_ROLE_KEY: 'dummy-3',
  SUPABASE_SERVICE_KEY: 'dummy-4',
  SUPABASE_KEY: 'dummy-5',
  SUPABASE_DASHBOARD_PASSWORD: 'dummy-6',
  SUPABASE_USER: 'admin',
  SUPABASE_HOST: 'kong',
  DATABASE_URL: 'postgres://postgres:dummy@db/postgres',
  PGPASSWORD: 'dummy-7',
};
// Linked fallbacks only local runs use: the containers get their own role's URL and nothing else.
const LOCAL_ONLY = ['DATABASE_URL', 'DATABASE_HOST', 'DATABASE_USER', 'DATABASE_NAME', 'SUPABASE_DB_URL', 'SUPABASE_POSTGRES_PASSWORD'];

describe('api and vault entrypoint', () => {
  it('the api gets what it reads and none of the link credentials, the master secret or the sponsor key', async () => {
    const wanted = { PATH: '/usr/bin:/bin', API_DATABASE_URL: 'postgres://agentenact_api:x@db:5432/postgres', VAULT_TOKEN: 't'.repeat(32), SUPABASE_URL: 'https://supabase.agentenact.io', PORT: '8080' };
    const got = await childEnv('api', { ...wanted, ...injected, KEYS_MASTER_SECRET: 'dummy-8', SPONSOR_SECRET: 'dummy-9', VAULT_DATABASE_URL: 'dummy-10' });
    expect(got).toEqual(wanted);
  });

  it('the vault gets its keys and its own database URL, and none of the link credentials', async () => {
    const wanted = { PATH: '/usr/bin:/bin', VAULT_DATABASE_URL: 'postgres://agentenact_vault:x@db:5432/postgres', VAULT_TOKEN: 't'.repeat(32), KEYS_MASTER_SECRET: 'k', SPONSOR_SECRET: 's' };
    const got = await childEnv('vault', { ...wanted, ...injected, OPENROUTER_API_KEY: 'dummy-11', API_DATABASE_URL: 'dummy-12' });
    expect(got).toEqual(wanted);
  });

  it('passes odd values through unchanged, keeps a set empty value, and refuses an unknown mode', async () => {
    const odd = `a b "c" 'd' $HOME \`x\` ;&|`;
    expect((await childEnv('api', { PATH: '/usr/bin:/bin', MAIL_FROM: odd })).MAIL_FROM).toBe(odd);
    expect((await childEnv('api', { PATH: '/usr/bin:/bin', MAIL_FROM: '' })).MAIL_FROM).toBe('');
    const p = Bun.spawn(['/bin/sh', ENTRYPOINT, 'indexer', '/usr/bin/env'], { stdout: 'pipe', stderr: 'pipe' });
    expect(await p.exited).toBe(64);
  });

  it('every variable the source reads is allowlisted for one of the two, except the local-only fallbacks', async () => {
    const script = await Bun.file(ENTRYPOINT).text();
    const lists = [...script.matchAll(/^\s*(?:RUNTIME|ALLOW)="([^"]*)"/gm)].map((m) => m[1]!);
    expect(lists.length).toBe(3);
    const allowed = new Set(lists.join(' ').split(/\s+/).filter((n) => /^[A-Z][A-Z0-9_]+$/.test(n)));
    for (const n of LOCAL_ONLY) expect({ n, allowed: allowed.has(n) }).toEqual({ n, allowed: false });
    const missing = [...(await namesReadInSrc())].filter((n) => !allowed.has(n) && !LOCAL_ONLY.includes(n));
    expect(missing).toEqual([]);
  });

  it('both images start through it', async () => {
    for (const [mode, file] of Object.entries(DOCKERFILES)) expect(await Bun.file(file).text()).toContain(`ENTRYPOINT ["/app/entrypoint.sh", "${mode}"]`);
  });
});
