import { applyMigrations, createDb, type Db } from '../../src/db.js';

/** Repo-root migrations/ (apps/indexer/tests/support → ../../../../). */
export const MIGRATIONS_DIR = new URL('../../../../migrations/', import.meta.url).pathname;

export const TEST_DB_NAME = 'agentenact_cloud_test';
const SETUP =
  'Forward the test Postgres:\n' +
  '  servel port-forward @agentenact-cloud-test:5432 55439\n' +
  `  export TEST_DATABASE_URL=postgres://postgres:<password>@localhost:55439/${TEST_DB_NAME}`;

/**
 * Tests create and force-drop databases, so they must never reach a real one. A local port can be a
 * `servel port-forward` to a remote production database, so localhost alone proves nothing: the URL must
 * name the dedicated test database, and the server must confirm it is connected to that database.
 */
export function assertSafeTestDbUrl(raw: string | undefined): string {
  if (!raw) throw new Error(`TEST_DATABASE_URL is not set. ${SETUP}`);
  const url = new URL(raw);
  if (!['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)) {
    throw new Error(`TEST_DATABASE_URL must point at localhost. ${SETUP}`);
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

/** A throwaway database per test file, migrated from scratch, so files never share state. */
export async function freshDb(): Promise<{ sql: Db; url: string; drop: () => Promise<void> }> {
  const base = assertSafeTestDbUrl(process.env.TEST_DATABASE_URL);
  const admin = await connectAdmin();
  const name = `t_${crypto.randomUUID().replaceAll('-', '')}`;
  await admin.unsafe(`create database ${name}`);
  const url = new URL(base);
  url.pathname = `/${name}`;
  const sql = createDb(url.toString());
  await applyMigrations(sql, MIGRATIONS_DIR);
  return {
    sql,
    url: url.toString(),
    drop: async () => {
      await sql.close();
      // `with (force)` can hit 42501 (no pg_signal_backend) or 55006 (still in use): retry, then leave the throwaway db.
      for (let i = 0; i < 3; i++) {
        try {
          await admin.unsafe(`drop database if exists ${name} with (force)`);
          break;
        } catch {
          if (i === 2) console.warn(`could not drop throwaway test database ${name}; leaving it`);
          else await Bun.sleep(300);
        }
      }
      await admin.close();
    },
  };
}
