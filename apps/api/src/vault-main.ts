/**
 * The vault process: the only one that holds the keys master secret and opens agent keys. It answers the api over
 * an internal address with a bearer token and signs only payloads it decodes and checks itself
 * (keys/vault.ts). It runs no agent code, no model call and no tool: nothing in it reads untrusted input except
 * the payloads it checks.
 */
import { optionalSponsorFromEnv } from './chain/sponsor.js';
import { loadVaultConfig } from './config.js';
import { createDb } from './db/index.js';
import { createKeys } from './keys/index.js';
import { createVaultHandler } from './keys/rpc.js';
import { createVault } from './keys/vault.js';

/**
 * What the vault can see about its own isolation, logged once at boot: which role it runs as, and whether the api's
 * role (agentenact_api, migration 0020) could read the keys, act as the vault, or reset the vault's password. Whether
 * the api actually connects as that role is the api's own boot log (db_role). Either being wrong is an operator's
 * fix, not a reason to stop signing for agents that are already live.
 */
async function isolation(sql: ReturnType<typeof createDb>) {
  const [r] = (await sql`select current_user as role,
                                exists (select 1 from pg_roles where rolname = 'agentenact_api') as api_role_exists,
                                case when exists (select 1 from pg_roles where rolname = 'agentenact_api') then
                                  has_schema_privilege('agentenact_api', 'keyvault', 'USAGE')
                                  or has_table_privilege('agentenact_api', 'keyvault.keys', 'SELECT') end as api_role_reads_keys,
                                case when exists (select 1 from pg_roles where rolname = 'agentenact_api')
                                     then pg_has_role('agentenact_api', 'agentenact_vault', 'MEMBER') end as api_role_is_vault,
                                -- a superuser can do anything; before PG16, CREATEROLE alone resets any non-superuser's password
                                coalesce((select rolsuper or (rolcreaterole and current_setting('server_version_num')::int < 160000)
                                          from pg_roles where rolname = 'agentenact_api'), false) as api_role_can_reset_vault`) as {
    role: string;
    api_role_exists: boolean;
    api_role_reads_keys: boolean | null;
    api_role_is_vault: boolean | null;
    api_role_can_reset_vault: boolean;
  }[];
  return {
    ...r!,
    isolated:
      r!.role === 'agentenact_vault' &&
      r!.api_role_exists &&
      r!.api_role_reads_keys === false &&
      r!.api_role_is_vault === false &&
      !r!.api_role_can_reset_vault,
  };
}

const log = (e: Record<string, unknown>) => console.log(JSON.stringify({ t: new Date().toISOString(), ...e }));

let stage = 'config';
try {
  const config = loadVaultConfig();
  stage = 'wiring';
  const sql = createDb(config.databaseUrl);
  const sponsor = optionalSponsorFromEnv(process.env);
  const vault = createVault({ sql, keys: createKeys(sql), sponsor });
  const handler = createVaultHandler(vault, { log });
  const server = Bun.serve({ port: config.port, fetch: handler, maxRequestBodySize: 128 * 1024, idleTimeout: 30 });
  const stop = async () => {
    server.stop();
    await sql.close();
    process.exit(0);
  };
  process.on('SIGTERM', () => void stop());
  process.on('SIGINT', () => void stop());
  log({ event: 'vault_listening', port: config.port, sponsor: sponsor?.publicKey ?? null });
  void isolation(sql).then(
    (r) => log({ event: 'vault_isolation', ...r }),
    () => log({ event: 'vault_isolation', error: 'check_failed' }),
  );
} catch (e) {
  // A fixed event: never the error object. Only config and key messages naming a variable (never a value) are named.
  const message = (e as Error | null)?.message;
  const fixed = typeof message === 'string' && /^(config|keys|chain): [A-Z_]+ (is not set|must be|is not a valid)/.test(message);
  log({ event: 'startup_failed', stage, ...(fixed ? { reason: message } : {}) });
  process.exit(1);
}
