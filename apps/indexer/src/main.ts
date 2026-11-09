import { Networks, rpc } from '@stellar/stellar-sdk';
import { createHorizonReader, createRateLimiter } from './chain/horizon.js';
import { createKarmaPaymentsReader } from './chain/karma.js';
import { createRegistryReader } from './chain/registry.js';
import { libraryVerifier } from './chain/verify.js';
import { CHAIN, loadConfig } from './config.js';
import { createDb, type Db } from './db.js';
import { serveHealth } from './http.js';
import { createLoop } from './loop.js';
import { buildStages } from './stages.js';
import { acquireSingleton, SINGLETON_LOCKED } from './singleton.js';

const log = (e: Record<string, string | number>) => console.log(JSON.stringify(e));

/**
 * The database must hold testnet data. An empty `meta.network` is set to testnet; any other value is a refusal.
 * Returns true when the database may be used.
 */
export async function checkNetwork(sql: Db, expected: string = CHAIN.network): Promise<boolean> {
  await sql`insert into discovery.meta (key, value) values ('network', ${expected}) on conflict (key) do nothing`;
  const rows = (await sql`select value from discovery.meta where key = 'network'`) as Array<{ value: string }>;
  return rows[0]?.value === expected;
}

async function main(): Promise<void> {
  const config = loadConfig(process.env);

  // The URL must be a direct session connection (never a transaction pooler): the advisory lock lives on that session.
  let lock: Awaited<ReturnType<typeof acquireSingleton>>;
  try {
    lock = await acquireSingleton(config.databaseUrl);
  } catch (e) {
    log({ event: e instanceof Error && e.message === SINGLETON_LOCKED ? 'singleton-locked' : 'singleton-failed' });
    process.exit(1);
  }

  const sql = createDb(config.databaseUrl);
  try {
    if (!(await checkNetwork(sql))) {
      log({ event: 'startup_failed', reason: 'network_mismatch' });
      process.exit(1);
    }
  } catch {
    log({ event: 'startup_failed', reason: 'database' });
    process.exit(1);
  }

  const reader = createRegistryReader({ rpc: new rpc.Server(config.rpcUrl), registry: config.registry, passphrase: Networks.TESTNET });
  const horizon = createHorizonReader({ horizonUrl: config.horizonUrl, limiter: createRateLimiter(config.horizonRps) });
  const karma = config.paymentsSource === 'agentkarma' ? createKarmaPaymentsReader({ baseUrl: config.agentkarmaUrl, usdc: config.usdc }) : undefined;
  const loop = createLoop({ sql, lock, exit: (code) => process.exit(code), log, stages: buildStages({ sql, reader, horizon, karma, config, verify: libraryVerifier(), log }) });

  const server = serveHealth({ sql, port: config.port });
  loop.start();
  log({ event: 'started', network: config.network, port: config.port, payments: config.paymentsSource });

  let closing = false;
  const shutdown = async () => {
    if (closing) return;
    closing = true;
    await loop.stop(); // waits up to 5 s for a running stage
    await server.stop();
    await sql.close().catch(() => {});
    await lock.release().catch(() => {});
    process.exit(0);
  };
  process.on('SIGTERM', () => void shutdown());
  process.on('SIGINT', () => void shutdown());
}

if (import.meta.main) {
  main().catch(() => {
    log({ event: 'startup_failed', reason: 'startup' }); // config, port bind or db failure; the log stays fixed
    process.exit(1);
  });
}
