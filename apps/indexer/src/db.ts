import { SQL } from 'bun';
import { readdir } from 'node:fs/promises';
import { join } from 'node:path';

export type Db = SQL;

export function createDb(url: string): Db {
  return new SQL(url, { max: 5, idleTimeout: 30 });
}

/** A dedicated single connection that is never idled out or recycled: for session-level state such as an advisory lock. */
export function createDedicatedDb(url: string): Db {
  return new SQL(url, { max: 1, idleTimeout: 0, maxLifetime: 0 });
}

/** Raw apply of every NNNN_*.sql file in name order. Tests and local dev only; deployed databases use `servel infra sql --track`. */
export async function applyMigrations(sql: Db, dir: string): Promise<string[]> {
  const files = (await readdir(dir)).filter((f) => /^\d{4}_.+\.sql$/.test(f)).sort();
  for (const f of files) await sql.unsafe(await Bun.file(join(dir, f)).text());
  return files;
}
