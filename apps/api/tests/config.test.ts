import { describe, expect, it } from 'bun:test';
import { loadConfig, loadVaultConfig } from '../src/config.js';
import { httpError, isHttpError } from '../src/errors.js';

const env = {
  DATABASE_URL: 'postgres://u:p@db:5432/postgres',
  APP_ORIGIN: 'https://app.agentenact.io',
  RP_ID: 'agentenact.io',
  PUBLIC_BASE_URL: 'https://public.example.test/',
  SUPABASE_URL: 'https://supabase.agentenact.io',
  SUPABASE_ANON_KEY: 'anon-key',
};

describe('config', () => {
  it('reads the non-secret settings, defaults the port, trims a trailing slash', () => {
    expect(loadConfig(env)).toEqual({
      port: 8080,
      databaseUrl: env.DATABASE_URL,
      appOrigin: 'https://app.agentenact.io',
      appOrigins: ['https://app.agentenact.io'],
      rpId: 'agentenact.io',
      publicBaseUrl: 'https://public.example.test',
      supabaseUrl: 'https://supabase.agentenact.io',
      supabaseAnonKey: 'anon-key',
      killSwitch: false,
      mailFrom: 'AgentEnact <agents@agentenact.io>',
      agentLimit: 3,
      agentCreationsPerDay: 3,
      sponsoredStartsPerDay: 10,
      checkSeals: true,
      feeModel: 'agent',
      testnetCredit: false,
    });
  });

  it('agents pay their own way unless FEE_MODEL=sponsor, and any other word is refused', () => {
    expect(loadConfig({ ...env, FEE_MODEL: 'sponsor' }).feeModel).toBe('sponsor');
    expect(loadConfig({ ...env, FEE_MODEL: 'agent' }).feeModel).toBe('agent');
    expect(loadConfig({ ...env, FEE_MODEL: '' }).feeModel).toBe('agent');
    expect(() => loadConfig({ ...env, FEE_MODEL: 'deposit' })).toThrow('config: FEE_MODEL must be agent or sponsor');
  });

  it('seals checks unless CHECK_SEALS=off, and refuses any other word', () => {
    expect(loadConfig({ ...env, CHECK_SEALS: 'off' }).checkSeals).toBe(false);
    expect(loadConfig({ ...env, CHECK_SEALS: 'on' }).checkSeals).toBe(true);
    expect(loadConfig({ ...env, CHECK_SEALS: '' }).checkSeals).toBe(true);
    expect(() => loadConfig({ ...env, CHECK_SEALS: '0' })).toThrow('config: CHECK_SEALS must be on or off');
  });

  it('reads the agent limits and refuses anything but a small positive integer', () => {
    const c = loadConfig({ ...env, AGENT_LIMIT: '5', AGENT_CREATIONS_PER_DAY: '4', SPONSORED_STARTS_PER_DAY: '20' });
    expect([c.agentLimit, c.agentCreationsPerDay, c.sponsoredStartsPerDay]).toEqual([5, 4, 20]);
    for (const v of ['0', '-1', '2.5', 'x', '21']) expect(() => loadConfig({ ...env, AGENT_LIMIT: v })).toThrow('config: AGENT_LIMIT must be an integer from 1 to 20');
  });

  it('reads the kill switch: 1 is on; unset, blank and 0 are off', () => {
    expect(loadConfig({ ...env, RUNTIME_KILL_SWITCH: '1' }).killSwitch).toBe(true);
    expect(loadConfig({ ...env, RUNTIME_KILL_SWITCH: '0' }).killSwitch).toBe(false);
    expect(loadConfig({ ...env, RUNTIME_KILL_SWITCH: '' }).killSwitch).toBe(false);
  });

  it.each(['true', 'on', 'yes', '2'])('refuses RUNTIME_KILL_SWITCH=%s', (v) => {
    expect(() => loadConfig({ ...env, RUNTIME_KILL_SWITCH: v })).toThrow('config: RUNTIME_KILL_SWITCH must be 0 or 1');
  });

  it('reads ISOLATE_POOL_SIZE: unset and blank mean the host default; 1..8 are taken', () => {
    expect(loadConfig(env).isolatePoolSize).toBeUndefined();
    expect(loadConfig({ ...env, ISOLATE_POOL_SIZE: '' }).isolatePoolSize).toBeUndefined();
    expect(loadConfig({ ...env, ISOLATE_POOL_SIZE: '1' }).isolatePoolSize).toBe(1);
    expect(loadConfig({ ...env, ISOLATE_POOL_SIZE: '8' }).isolatePoolSize).toBe(8);
  });

  it.each(['0', '9', '-1', '2.5', 'two', '1e1', ' 2'])('refuses ISOLATE_POOL_SIZE=%s', (v) => {
    expect(() => loadConfig({ ...env, ISOLATE_POOL_SIZE: v })).toThrow('config: ISOLATE_POOL_SIZE must be an integer from 1 to 8');
  });

  it('takes MAIL_FROM when set', () => {
    expect(loadConfig({ ...env, MAIL_FROM: 'Agents <a@agentenact.io>' }).mailFrom).toBe('Agents <a@agentenact.io>');
  });

  it('names the missing variable', () => {
    const { RP_ID: _, ...rest } = env;
    expect(() => loadConfig(rest)).toThrow('config: RP_ID is not set');
  });

  it('refuses an APP_ORIGIN that is not a bare origin', () => {
    expect(() => loadConfig({ ...env, APP_ORIGIN: 'https://app.agentenact.io/x' })).toThrow(/APP_ORIGIN/);
  });

  it('reads APP_ORIGINS: extra bare origins after the canonical one, deduplicated; unset or blank adds none; appOrigin (email links) stays APP_ORIGIN', () => {
    expect(loadConfig({ ...env, APP_ORIGINS: 'https://agentenact.io, https://staging.agentenact.io' })).toMatchObject({
      appOrigin: 'https://app.agentenact.io',
      appOrigins: ['https://app.agentenact.io', 'https://agentenact.io', 'https://staging.agentenact.io'],
    });
    expect(loadConfig({ ...env, APP_ORIGINS: 'https://agentenact.io,https://app.agentenact.io,https://agentenact.io' }).appOrigins).toEqual([
      'https://app.agentenact.io',
      'https://agentenact.io',
    ]);
    expect(loadConfig({ ...env, APP_ORIGINS: '' }).appOrigins).toEqual(['https://app.agentenact.io']);
    expect(loadConfig({ ...env, APP_ORIGINS: '  ' }).appOrigins).toEqual(['https://app.agentenact.io']);
  });


  it.each(['https://agentenact.io/', 'https://agentenact.io/x', 'agentenact.io', 'https://agentenact.io,', 'https://a.io,,https://b.io', 'not a url', 'mailto:a@agentenact.io'])(
    'refuses APP_ORIGINS=%p, naming APP_ORIGINS',
    (APP_ORIGINS) => {
      expect(() => loadConfig({ ...env, APP_ORIGINS })).toThrow(/^config: APP_ORIGINS must be/);
    },
  );

  it('treats a blank PORT as unset', () => {
    expect(loadConfig({ ...env, PORT: '' }).port).toBe(8080);
    expect(loadConfig({ ...env, PORT: '3000' }).port).toBe(3000);
  });

  it.each(['abc', '0', '-1', '65536', '80.5'])('refuses PORT=%s', (PORT) => {
    expect(() => loadConfig({ ...env, PORT })).toThrow('config: PORT must be a port number');
  });

  it('builds the database url from DATABASE_HOST/_USER/_NAME plus the linked postgres password', () => {
    const { DATABASE_URL: _, ...rest } = env;
    const linked = {
      ...rest,
      DATABASE_HOST: 'db',
      DATABASE_USER: 'postgres',
      DATABASE_NAME: 'postgres',
      SUPABASE_POSTGRES_PASSWORD: 'p@ss/w:rd',
      // what `servel link` injects for supabase points at kong, never the database: it must be ignored
      SUPABASE_HOST: 'kong',
      SUPABASE_USER: 'admin',
    };
    expect(loadConfig(linked).databaseUrl).toBe('postgres://postgres:p%40ss%2Fw%3Ard@db:5432/postgres');
    expect(loadConfig({ ...linked, DATABASE_URL: 'postgres://x:y@h:1/d' }).databaseUrl).toBe('postgres://x:y@h:1/d');
    // the api's own role (migration 0020) wins over both
    expect(loadConfig({ ...linked, DATABASE_URL: 'postgres://x:y@h:1/d', API_DATABASE_URL: 'postgres://agentenact_api:z@db:5432/postgres' }).databaseUrl).toBe(
      'postgres://agentenact_api:z@db:5432/postgres',
    );
    const { SUPABASE_POSTGRES_PASSWORD: __, ...noPassword } = linked;
    expect(() => loadConfig(noPassword)).toThrow('config: DATABASE_URL is not set');
    const { DATABASE_HOST: ___, ...noHost } = linked;
    expect(() => loadConfig(noHost)).toThrow('config: DATABASE_URL is not set');
  });

  it('takes only the password from the linked SUPABASE_DB_URL when SUPABASE_POSTGRES_PASSWORD is absent', () => {
    const { DATABASE_URL: _, ...rest } = env;
    const linked = {
      ...rest,
      DATABASE_HOST: 'db',
      DATABASE_USER: 'postgres',
      DATABASE_NAME: 'postgres',
      // current links: the password lives only in this url, whose host and user may be the pooler's
      SUPABASE_DB_URL: 'postgres://postgres.tenant:p%40ss%2Fw%3Ard@supavisor:6543/other',
    };
    expect(loadConfig(linked).databaseUrl).toBe('postgres://postgres:p%40ss%2Fw%3Ard@db:5432/postgres');
    expect(loadVaultConfig(linked).databaseUrl).toBe('postgres://postgres:p%40ss%2Fw%3Ard@db:5432/postgres');
    // its own role wins over the linked postgres url, which cannot read keyvault.* (migration 0018)
    expect(loadVaultConfig({ ...linked, VAULT_DATABASE_URL: 'postgres://agentenact_vault:v@db:5432/postgres' }).databaseUrl).toBe('postgres://agentenact_vault:v@db:5432/postgres');
    expect(loadConfig({ ...linked, SUPABASE_POSTGRES_PASSWORD: 'own' }).databaseUrl).toBe('postgres://postgres:own@db:5432/postgres');
    for (const SUPABASE_DB_URL of ['postgres://postgres@supavisor:6543/x', 'not a url', '']) {
      expect(() => loadConfig({ ...linked, SUPABASE_DB_URL })).toThrow('config: DATABASE_URL is not set');
    }
  });

  it('names APP_ORIGIN when it is not a URL at all', () => {
    expect(() => loadConfig({ ...env, APP_ORIGIN: 'not a url' })).toThrow(/APP_ORIGIN/);
  });

  it('httpError carries status and code', () => {
    const e = httpError(409, 'agent_exists');
    expect(isHttpError(e)).toBe(true);
    expect([e.status, e.code, e.message]).toEqual([409, 'agent_exists', 'agent_exists']);
    expect(isHttpError(new Error('x'))).toBe(false);
  });
});
