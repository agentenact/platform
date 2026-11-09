/**
 * Who pays an agent's Stellar reserves and fees (agents/reserve.ts). `agent`: every agent pays its own, bought with its
 * first USDC, and pays the sponsor back what it fronted at birth. `sponsor`: the platform pays for one agent per account
 * and every fee. The third option Kerem kept open (the owner deposits XLM first, no sponsor) needs the library's birth
 * flow to change and is not here yet.
 */
export type FeeModel = 'agent' | 'sponsor';

/** Non-secret settings. Secrets are read only by their owning unit (keys, chain). */
export interface Config {
  port: number;
  databaseUrl: string;
  /** The web panel's canonical origin: links in email. Always the first entry of `appOrigins`. */
  appOrigin: string;
  /**
   * Every web origin the api accepts: CORS reflects one of these and WebAuthn accepts one of these in clientDataJSON.
   * `appOrigin` first, then APP_ORIGINS (comma-separated bare origins), deduplicated.
   */
  appOrigins: string[];
  /** WebAuthn relying-party id, e.g. agentenact.io. */
  rpId: string;
  /** agentURI = `${publicBaseUrl}/a/<agentUuid>/agent.json`, e.g. https://agentenact.io. Permanent once registered on chain. */
  publicBaseUrl: string;
  supabaseUrl: string;
  supabaseAnonKey: string;
  /** Spec §6 manual global kill switch: RUNTIME_KILL_SWITCH=1 stops the scheduler, owner chat and (P3b) paid services. */
  killSwitch: boolean;
  /** Sender of owner email (send_email, mission delivery, trigger notices), on the Resend-verified domain. */
  mailFrom: string;
  /**
   * ISOLATE_POOL_SIZE (1..8). Unset = min(4, os.availableParallelism()). Bun does not see a container's CPU limit
   * (measured in oven/bun:1.3.11 with --cpus 1: it reports the host's cores), so size it from servel.yaml.
   */
  isolatePoolSize?: number;
  /** AGENT_LIMIT (1..20, default 3): agents one account may hold (not revoked). */
  agentLimit: number;
  /** AGENT_CREATIONS_PER_DAY (1..50, default 3): agents one account may make in 24 hours, revoked ones included. */
  agentCreationsPerDay: number;
  /** SPONSORED_STARTS_PER_DAY (1..100, default 10): provision attempts one account may have the sponsor pay for in 24 hours. */
  sponsoredStartsPerDay: number;
  /** CHECK_SEALS (on/off, default on): seal every condition check on chain (seals/). Off stops both the queue and the worker. */
  checkSeals: boolean;
  /** FEE_MODEL (agent/sponsor, default agent): who pays an agent's reserves and fees. See FeeModel. */
  feeModel: FeeModel;
  /** TESTNET_CREDIT (on/off, default off): the sponsor keeps 1 testnet USDC in each live agent's wallet (agents/credit.ts). */
  testnetCredit: boolean;
}

/**
 * `servel link <supabase>` injects the Postgres password but its SUPABASE_HOST / SUPABASE_USER point at Kong, never
 * the database. Older links inject it as SUPABASE_POSTGRES_PASSWORD; current ones only inside SUPABASE_DB_URL, so
 * the password is taken from there and nothing else of that URL is used (its host may be the pooler). The
 * non-secret parts come from servel.yaml (DATABASE_HOST/_USER/_NAME: the stack's `db` service, reached directly
 * with no pooler, which the session advisory lock requires); building the URL here keeps the password out of
 * every command line.
 */
function linkedPassword(env: Record<string, string | undefined>): string | undefined {
  if (env.SUPABASE_POSTGRES_PASSWORD) return env.SUPABASE_POSTGRES_PASSWORD;
  if (!env.SUPABASE_DB_URL) return undefined;
  try {
    const password = new URL(env.SUPABASE_DB_URL).password;
    return password ? decodeURIComponent(password) : undefined;
  } catch {
    return undefined;
  }
}

function linkedDatabaseUrl(env: Record<string, string | undefined>): string | undefined {
  const host = env.DATABASE_HOST;
  const password = linkedPassword(env);
  if (!host || !password) return undefined;
  const user = encodeURIComponent(env.DATABASE_USER || 'postgres');
  const db = encodeURIComponent(env.DATABASE_NAME || 'postgres');
  return `postgres://${user}:${encodeURIComponent(password)}@${host}:5432/${db}`;
}

/** `value` as a bare origin (scheme://host[:port], nothing after), or a config error naming `name`. */
function bareOrigin(name: string, value: string): string {
  let origin: string;
  try {
    origin = new URL(value).origin;
  } catch {
    throw new Error(`config: ${name} must be a URL like https://agentenact.io`);
  }
  if (origin === 'null' || origin !== value) throw new Error(`config: ${name} must be a bare origin like https://agentenact.io`);
  return origin;
}

function feeModel(raw: string | undefined): FeeModel {
  if (raw === undefined || raw === '') return 'agent';
  if (raw !== 'agent' && raw !== 'sponsor') throw new Error('config: FEE_MODEL must be agent or sponsor');
  return raw;
}

/** A comma-separated list of bare origins from `env[name]`; empty or unset is []. Empty entries ("a,,b", a trailing comma) are refused: a typo should not boot quietly. */
export function originList(name: string, env: Record<string, string | undefined> = process.env): string[] {
  const raw = env[name] ?? '';
  return raw.trim() === '' ? [] : raw.split(',').map((o) => bareOrigin(name, o.trim()));
}

export function loadConfig(env: Record<string, string | undefined> = process.env): Config {
  const need = (name: string) => {
    const v = env[name];
    if (!v) throw new Error(`config: ${name} is not set`);
    return v;
  };
  const appOrigin = bareOrigin('APP_ORIGIN', need('APP_ORIGIN'));
  const extra = originList('APP_ORIGINS', env);
  const appOrigins = [...new Set([appOrigin, ...extra])];
  const rawPort = env.PORT === undefined || env.PORT === '' ? '8080' : env.PORT;
  const port = /^\d+$/.test(rawPort) ? Number(rawPort) : NaN;
  if (!Number.isInteger(port) || port <= 0 || port >= 65536) throw new Error('config: PORT must be a port number');
  const kill = env.RUNTIME_KILL_SWITCH ?? '';
  if (!['', '0', '1'].includes(kill)) throw new Error('config: RUNTIME_KILL_SWITCH must be 0 or 1');
  const rawPool = env.ISOLATE_POOL_SIZE ?? '';
  const isolatePoolSize = rawPool === '' ? undefined : /^[1-8]$/.test(rawPool) ? Number(rawPool) : NaN;
  if (Number.isNaN(isolatePoolSize)) throw new Error('config: ISOLATE_POOL_SIZE must be an integer from 1 to 8');
  const count = (name: string, fallback: number, max: number) => {
    const raw = env[name] ?? '';
    if (raw === '') return fallback;
    const n = /^\d+$/.test(raw) ? Number(raw) : NaN;
    if (!Number.isInteger(n) || n < 1 || n > max) throw new Error(`config: ${name} must be an integer from 1 to ${max}`);
    return n;
  };
  const onOff = (name: string, dflt: boolean): boolean => {
    const raw = env[name];
    if (raw === undefined || raw === '') return dflt;
    if (raw !== 'on' && raw !== 'off') throw new Error(`config: ${name} must be on or off`);
    return raw === 'on';
  };
  return {
    port,
    // API_DATABASE_URL connects as agentenact_api (migration 0020); on servel it is the only one the entrypoint passes.
    databaseUrl: env.API_DATABASE_URL || env.DATABASE_URL || linkedDatabaseUrl(env) || need('DATABASE_URL'),
    appOrigin,
    appOrigins,
    rpId: need('RP_ID'),
    publicBaseUrl: need('PUBLIC_BASE_URL').replace(/\/+$/, ''),
    supabaseUrl: need('SUPABASE_URL').replace(/\/+$/, ''),
    supabaseAnonKey: need('SUPABASE_ANON_KEY'),
    killSwitch: kill === '1',
    mailFrom: env.MAIL_FROM || 'AgentEnact <agents@agentenact.io>',
    isolatePoolSize,
    agentLimit: count('AGENT_LIMIT', 3, 20),
    agentCreationsPerDay: count('AGENT_CREATIONS_PER_DAY', 3, 50),
    sponsoredStartsPerDay: count('SPONSORED_STARTS_PER_DAY', 10, 100),
    checkSeals: onOff('CHECK_SEALS', true),
    feeModel: feeModel(env.FEE_MODEL),
    testnetCredit: onOff('TESTNET_CREDIT', false),
  };
}

/** The vault process (src/vault-main.ts): its port and the database. The vault token and the master secret are read by `keys` itself. */
export function loadVaultConfig(env: Record<string, string | undefined> = process.env): { port: number; databaseUrl: string } {
  const rawPort = env.VAULT_PORT === undefined || env.VAULT_PORT === '' ? '8081' : env.VAULT_PORT;
  const port = /^\d+$/.test(rawPort) ? Number(rawPort) : NaN;
  if (!Number.isInteger(port) || port <= 0 || port >= 65536) throw new Error('config: VAULT_PORT must be a port number');
  // VAULT_DATABASE_URL connects as agentenact_vault (migration 0018), the only role that can read keyvault.keys. The
  // fallbacks are for local runs and the window before that role has a password; on servel they cannot read keyvault.*.
  const databaseUrl = env.VAULT_DATABASE_URL || env.DATABASE_URL || linkedDatabaseUrl(env);
  if (!databaseUrl) throw new Error('config: VAULT_DATABASE_URL is not set');
  return { port, databaseUrl };
}
