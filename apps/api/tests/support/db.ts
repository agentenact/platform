import { SQL } from 'bun';
import { createHash } from 'node:crypto';
import { readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { applyMigrations, createDb, type Db } from '../../src/db/index.js';

/** Repo-root migrations/ (apps/api/tests/support → ../../../../). */
export const MIGRATIONS_DIR = new URL('../../../../migrations/', import.meta.url).pathname;

export const TEST_DB_NAME = 'agentenact_cloud_test';
/** Hosts a test database may live on: local (port-forward) or the in-network servel Postgres (Task 2 runner). */
export const TEST_DB_HOSTS: readonly string[] = [
  'localhost',
  '127.0.0.1',
  '[::1]',
  'servel-infra-agentenact-cloud-test-postgres',
];
export const TEMPLATE_DB_NAME = 'agentenact_cloud_template';
const TEMPLATE_LOCK_KEY = 0x41453454;

/**
 * Default per-test timeout: bun's 5 s fits a fast runner; a port-forward costs ~100 ms per query, so it gets 30 s.
 * Caveat (verified on bun 1.3.11): setDefaultTimeout in a preload applies to the FIRST test file only, so a
 * multi-file run needs `bun test --timeout <ms>` as well; scripts/test-remote.ts passes it.
 */
export function testTimeoutMs(): number {
  const raw = process.env.TEST_DATABASE_URL;
  if (!raw) return 5000;
  try {
    return ['localhost', '127.0.0.1', '[::1]'].includes(new URL(raw).hostname) ? 30000 : 5000;
  } catch {
    return 5000;
  }
}

const SETUP =
  'Run the suite inside the network (`bun run test:remote`), or reach the test Postgres through a port-forward:\n' +
  '  servel port-forward @agentenact-cloud-test:5432 55439\n' +
  `  export TEST_DATABASE_URL=postgres://postgres:test@localhost:55439/${TEST_DB_NAME}`;

/**
 * Tests create and force-drop databases, so they must never reach a real one. A local port can be a
 * `servel port-forward` to a remote production database, so localhost alone proves nothing: the URL must
 * name the dedicated test database, and the server must confirm it is connected to that database.
 */
export function assertSafeTestDbUrl(raw: string | undefined): string {
  if (!raw) throw new Error(`TEST_DATABASE_URL is not set. ${SETUP}`);
  const url = new URL(raw);
  if (url.search) throw new Error(`TEST_DATABASE_URL must not carry query parameters (they can override the host). ${SETUP}`);
  if (!TEST_DB_HOSTS.includes(url.hostname)) {
    throw new Error(`TEST_DATABASE_URL must point at one of: ${TEST_DB_HOSTS.join(', ')}. ${SETUP}`);
  }
  if (url.pathname !== `/${TEST_DB_NAME}`) {
    throw new Error(`TEST_DATABASE_URL must name the ${TEST_DB_NAME} database. ${SETUP}`);
  }
  return raw;
}

async function connectAdmin(): Promise<Db> {
  const admin = createDb(assertSafeTestDbUrl(process.env.TEST_DATABASE_URL));
  const [row] = await admin`select current_database() as name`;
  if (row?.name !== TEST_DB_NAME) {
    await admin.close();
    throw new Error(`connected to ${String(row?.name)}, not ${TEST_DB_NAME}; refusing to create or drop databases`);
  }
  return admin;
}

/** Template name for a set of migration texts: a changed migration yields a new template, the old one is unused. */
export function templateNameFor(migrationTexts: string[]): string {
  const hash = createHash('sha256').update(migrationTexts.join('\n--\n')).digest('hex').slice(0, 10);
  return `${TEMPLATE_DB_NAME}_${hash}`;
}

let builds = 0;
export function templateStats(): { builds: number } {
  return { builds };
}

async function migrationTexts(): Promise<string[]> {
  const files = (await readdir(MIGRATIONS_DIR)).filter((f) => /^\d{4}_.+\.sql$/.test(f)).sort();
  return Promise.all(files.map((f) => Bun.file(join(MIGRATIONS_DIR, f)).text()));
}

function urlFor(base: string, dbName: string): string {
  const url = new URL(base);
  url.pathname = `/${dbName}`;
  return url.toString();
}

/** Builds the template once per process; processes are serialised by an advisory lock on a dedicated connection. */
let templateName: Promise<string> | undefined;
function ensureTemplate(): Promise<string> {
  templateName ??= buildTemplate().catch((e) => {
    templateName = undefined;
    throw e;
  });
  return templateName;
}

async function buildTemplate(): Promise<string> {
  const base = assertSafeTestDbUrl(process.env.TEST_DATABASE_URL);
  const name = templateNameFor(await migrationTexts());
  const building = `${name}_building`;
  const admin = await connectAdmin();
  const lock = new SQL(base, { max: 1, idleTimeout: 0, maxLifetime: 0 });
  try {
    await lock`select pg_advisory_lock(${TEMPLATE_LOCK_KEY})`;
    const [exists] = await admin`select 1 as one from pg_database where datname = ${name}`;
    if (!exists) {
      await admin.unsafe(`drop database if exists ${building} with (force)`);
      await admin.unsafe(`create database ${building}`);
      const tpl = createDb(urlFor(base, building));
      try {
        await applyMigrations(tpl, MIGRATIONS_DIR);
      } finally {
        await tpl.close();
      }
      await admin.unsafe(`alter database ${building} rename to ${name}`);
      builds++;
    }
    return name;
  } finally {
    await lock`select pg_advisory_unlock(${TEMPLATE_LOCK_KEY})`.catch(() => {});
    await lock.close();
    await admin.close();
  }
}

/** Builds the migrated template ahead of the first test, so a cold build is not charged to a 5 s hook timeout. */
export function warmTemplate(): Promise<unknown> {
  return process.env.TEST_DATABASE_URL ? ensureTemplate() : Promise.resolve();
}

/**
 * Force-drops a throwaway database. `with (force)` can hit 42501 (the role lacks pg_signal_backend) or 55006
 * (still in use): retry, then warn and leave the database in place, so a drop never fails a suite's afterAll.
 */
export async function dropThrowaway(
  admin: { unsafe: (q: string) => PromiseLike<unknown> },
  name: string,
  delayMs = 300,
): Promise<void> {
  for (let i = 0; i < 3; i++) {
    try {
      await admin.unsafe(`drop database if exists ${name} with (force)`);
      return;
    } catch {
      if (i === 2) console.warn(`could not drop throwaway test database ${name}; leaving it`);
      else await Bun.sleep(delayMs);
    }
  }
}

/** A throwaway database per test file, cloned from the migrated template, so files never share state. */
export async function freshDb(): Promise<{ sql: Db; url: string; drop: () => Promise<void> }> {
  const base = assertSafeTestDbUrl(process.env.TEST_DATABASE_URL);
  const template = await ensureTemplate();
  const admin = await connectAdmin();
  const name = `t_${crypto.randomUUID().replaceAll('-', '')}`;
  await admin.unsafe(`create database ${name} template ${template}`);
  const url = urlFor(base, name);
  const sql = createDb(url);
  return {
    sql,
    url,
    drop: async () => {
      await sql.close();
      await dropThrowaway(admin, name);
      await admin.close();
    },
  };
}
