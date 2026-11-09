/**
 * Agent memory (spec §5.3): key → value notes the agent writes only through the `remember` tool, and
 * reads back in owner chat and missions. Service runs never see it (spec §5.6).
 */
import type { Db } from '../db/index.js';

/** Namespace (first key) of the per-agent memory write lock: 'AEM1'. */
const MEMORY_LOCK_NAMESPACE = 0x41454d31;
export const MEMORY_MAX_KEYS = 100;
export const MEMORY_KEY = /^[a-z0-9][a-z0-9_.-]{0,63}$/;
export const MEMORY_MAX_VALUE = 2000;

export interface Memory {
  all(agentId: string): Promise<{ key: string; value: string }[]>;
  remember(agentId: string, key: string, value: string): Promise<'saved' | 'full' | 'invalid'>;
}

export function createMemory(sql: Db): Memory {
  return {
    async all(agentId) {
      return (await sql`select key, value from app.memory where agent_id = ${agentId} order by key`) as { key: string; value: string }[];
    },

    async remember(agentId, key, value) {
      if (!MEMORY_KEY.test(key) || value.length > MEMORY_MAX_VALUE || value.includes('\u0000')) return 'invalid';
      // An existing key always updates; a new key only while the agent is under the cap. Writes are
      // serialized per agent by a transaction-scoped advisory lock, so the count check and the insert are
      // atomic and the cap holds under concurrency.
      return sql.begin(async (tx) => {
        // Two-key form: its own namespace, so it can never collide with the one-key SINGLE_REPLICA_KEY lock.
        await tx`select pg_advisory_xact_lock(${MEMORY_LOCK_NAMESPACE}, hashtext(${agentId}::text))`;
        const rows = (await tx`insert into app.memory (agent_id, key, value)
                               select ${agentId}, ${key}, ${value}
                               where exists (select 1 from app.memory where agent_id = ${agentId} and key = ${key})
                                  or (select count(*) from app.memory where agent_id = ${agentId}) < ${MEMORY_MAX_KEYS}
                               on conflict (agent_id, key) do update set value = excluded.value, updated_at = now()
                               returning key`) as unknown[];
        return rows.length > 0 ? ('saved' as const) : ('full' as const);
      });
    },
  };
}
