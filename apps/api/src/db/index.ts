import { SQL } from 'bun';
import { readdir } from 'node:fs/promises';
import { join } from 'node:path';

export type Db = SQL;

export function createDb(url: string): Db {
  return new SQL(url, { max: 10, idleTimeout: 30 });
}

/**
 * Raw apply of every NNNN_*.sql file in name order. For tests and local dev only:
 * deployed databases are migrated by `servel infra sql --track`, which records what ran.
 */
export async function applyMigrations(sql: Db, dir: string): Promise<string[]> {
  const files = (await readdir(dir)).filter((f) => /^\d{4}_.+\.sql$/.test(f)).sort();
  for (const f of files) await sql.unsafe(await Bun.file(join(dir, f)).text());
  return files;
}

/**
 * Which role this process runs as, and whether it could read the vault's keys (it must not: migration 0020). The keys
 * table is found through pg_class, not the text 'keyvault.keys': resolving that text needs USAGE on keyvault, so for an
 * isolated role has_table_privilege would raise instead of answering false.
 */
export async function dbRole(sql: Db): Promise<{ role: string; superuser: boolean; reads_keys: boolean }> {
  const [r] = (await sql`select current_user as role,
                               (select rolsuper from pg_roles where rolname = current_user) as superuser,
                               has_schema_privilege('keyvault', 'USAGE')
                                 or exists (select 1 from pg_class c join pg_namespace n on n.oid = c.relnamespace
                                            where n.nspname = 'keyvault' and c.relname = 'keys'
                                              and has_table_privilege(c.oid, 'SELECT')) as reads_keys`) as {
    role: string;
    superuser: boolean;
    reads_keys: boolean;
  }[];
  return r!;
}

export * from './replica.js';
