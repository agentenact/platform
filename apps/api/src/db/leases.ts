/**
 * Short exclusive claims shared by every replica (app.leases, migration 0027): one owner conversation per agent, one
 * provision start per agent, one copy of a payment signature in flight. A lease is free once it expires or once the
 * instance that took it is dead (its lock session is gone), so a crashed replica never strands one.
 */
import type { Db } from './index.js';

export interface Leases {
  /** Takes `key` for `ttlMs`; returns its release, or null while someone else holds it. */
  take(key: string, ttlMs: number): Promise<(() => Promise<void>) | null>;
  /** Drops leases of dead instances and expired ones (the leader's sweep). Returns how many. */
  sweep(): Promise<number>;
}

export function createLeases(sql: Db, instance: number): Leases {
  return {
    async take(key, ttlMs) {
      const token = crypto.randomUUID();
      const rows = (await sql`insert into app.leases (key, instance, token, until)
                              values (${key}, ${instance}, ${token}, now() + make_interval(secs => ${ttlMs / 1000}))
                              on conflict (key) do update set instance = excluded.instance, token = excluded.token, until = excluded.until
                                where app.leases.until <= now() or not app.instance_alive(app.leases.instance)
                              returning token`) as { token: string }[];
      if (rows[0]?.token !== token) return null;
      let done: Promise<void> | undefined;
      return () =>
        (done ??= (async () => {
          await sql`delete from app.leases where key = ${key} and token = ${token}`;
        })());
    },
    async sweep() {
      const rows = (await sql`delete from app.leases where until <= now() or not app.instance_alive(instance) returning key`) as unknown[];
      return rows.length;
    },
  };
}

/** A process-local stand-in for tests and single-process wiring: same contract, no database. */
export function createMemoryLeases(now: () => number = Date.now): Leases {
  const held = new Map<string, { token: symbol; until: number }>();
  return {
    async take(key, ttlMs) {
      const cur = held.get(key);
      if (cur && cur.until > now()) return null;
      const token = Symbol(key);
      held.set(key, { token, until: now() + ttlMs });
      return async () => {
        if (held.get(key)?.token === token) held.delete(key);
      };
    },
    async sweep() {
      let n = 0;
      for (const [k, v] of held) if (v.until <= now()) (held.delete(k), n++);
      return n;
    },
  };
}
