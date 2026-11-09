import { describe, expect, it } from 'bun:test';

const ENTRYPOINT = new URL('../entrypoint.sh', import.meta.url).pathname;
const DOCKERFILE = new URL('../Dockerfile', import.meta.url).pathname;

/** Runs the entrypoint with `env` as the command: prints the environment the real process would get. */
async function childEnv(parent: Record<string, string>): Promise<Record<string, string>> {
  const p = Bun.spawn(['/bin/sh', ENTRYPOINT, '/usr/bin/env', '-0'], { env: parent, stdout: 'pipe', stderr: 'pipe' });
  const out = await new Response(p.stdout).text();
  expect(await p.exited).toBe(0);
  const vars: Record<string, string> = {};
  for (const entry of out.split('\0').filter(Boolean)) {
    const i = entry.indexOf('=');
    vars[entry.slice(0, i)] = entry.slice(i + 1);
  }
  return vars;
}

describe('indexer entrypoint', () => {
  // The names the servel infra link injects are not all known (the link output is a secret); the allowlist must hold for any of them.
  const injected = {
    SUPABASE_POSTGRES_PASSWORD: 'dummy-super-1',
    POSTGRES_PASSWORD: 'dummy-super-2',
    POSTGRES_USER: 'dummy-user',
    POSTGRES_DB: 'dummy-db',
    POSTGRES_HOST: 'db',
    POSTGRES_PORT: '5432',
    DATABASE_URL: 'postgres://dummy@db/postgres',
    PGPASSWORD: 'dummy-3',
    SERVEL_INFRA_AGENTENACT_SUPABASE_ANYTHING: 'dummy-4',
  };
  const wanted = {
    PATH: '/usr/bin:/bin',
    INDEXER_DATABASE_URL: 'postgres://discovery_indexer:dummy@db:5432/postgres',
    PUBLIC_BASE_URL: 'https://agentenact.io',
    PORT: '8080',
    INDEXER_SPONSORS: 'GAAAA,GBBBB',
    NODE_ENV: 'production',
  };

  it('drops every injected database variable and keeps exactly what the indexer reads', async () => {
    const got = await childEnv({ ...wanted, ...injected });
    expect(Object.keys(got).sort()).toEqual(Object.keys(wanted).sort());
    for (const k of Object.keys(wanted)) expect(got[k]).toBe(wanted[k as keyof typeof wanted]);
    for (const k of Object.keys(injected)) expect(got[k]).toBeUndefined();
  });

  it('passes values with spaces, quotes and dollar signs through unchanged, and leaves unset variables unset', async () => {
    const odd = `a b "c" 'd' $HOME \`x\` ;&|`;
    const got = await childEnv({ PATH: wanted.PATH, INDEXER_DATABASE_URL: wanted.INDEXER_DATABASE_URL, PUBLIC_BASE_URL: wanted.PUBLIC_BASE_URL, INDEXER_SPONSORS: odd, SUPABASE_POSTGRES_PASSWORD: 'dummy' });
    expect(got.INDEXER_SPONSORS).toBe(odd);
    expect(got.PORT).toBeUndefined();
    expect(got.SUPABASE_POSTGRES_PASSWORD).toBeUndefined();
  });

  it('keeps an empty variable that was set (an empty INDEXER_SPONSORS is a valid value)', async () => {
    const got = await childEnv({ ...wanted, INDEXER_SPONSORS: '' });
    expect(got.INDEXER_SPONSORS).toBe('');
  });

  it('the image starts the indexer through it', async () => {
    const docker = await Bun.file(DOCKERFILE).text();
    expect(docker).toMatch(/COPY[^\n]*entrypoint\.sh/);
    expect(docker).toMatch(/ENTRYPOINT \["\/app\/entrypoint\.sh"\]/);
    expect(docker).toMatch(/CMD \["bun", "run", "src\/main\.ts"\]/);
  });

  it('only reads variables the allowlist keeps', async () => {
    const config = await Bun.file(new URL('../src/config.ts', import.meta.url).pathname).text();
    const read = [...config.matchAll(/env\.([A-Z][A-Z0-9_]*)/g)].map((m) => m[1]!);
    const script = await Bun.file(ENTRYPOINT).text();
    const allow = /for v in ([A-Z_ ]+); do/.exec(script)![1]!.split(' ');
    for (const v of read) expect(allow).toContain(v);
  });
});
