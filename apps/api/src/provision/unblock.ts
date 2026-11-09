/**
 * Operator unblock for the orphan limit (gateway MAX_ORPHANS): an agent whose attempts kept timing out has one
 * abandoned on-chain account per attempt recorded in provision_state.orphans, and at the limit a retry is refused.
 * Unblocking moves those records into orphans_archived (kept, never deleted, so the accounts stay traceable) and
 * stamps unblocked_at; the next retry starts a fresh attempt. A foreign-owner binding is a real security case and is
 * never unblocked here. Run it with scripts/unblock-agent.ts (read-only unless --apply); tests run the same statements.
 */
import type { Db } from '../db/index.js';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export type UnblockResult = 'unblocked' | 'refused' | 'nothing_to_do' | 'not_found';
export type CheckResult = 'would_unblock' | 'refused' | 'nothing_to_do' | 'not_found';

/** The agent id, inlined into a statement only after it passed the uuid check (the script hands it to `servel infra sql`). */
const idOf = (agentId: string): string => {
  if (!UUID.test(agentId)) throw new Error('not an agent id');
  return agentId.toLowerCase();
};

/** Read-only: what unblockStatement would do, so an operator looks before writing. */
export function checkStatement(agentId: string): string {
  const id = idOf(agentId);
  return `with a as (select provision_state s from app.agents where id = '${id}')
select case
  when not exists (select 1 from a) then 'not_found'
  when (select s->>'error' from a) = 'bound_foreign_owner' then 'refused'
  when (select jsonb_array_length(coalesce(s->'orphans', '[]'::jsonb)) from a) > 0 then 'would_unblock'
  else 'nothing_to_do' end as result;`;
}

/** The one update: archive the orphans and stamp unblocked_at, never for a foreign-owner binding. */
export function unblockStatement(agentId: string): string {
  const id = idOf(agentId);
  return `with a as (select id, provision_state s from app.agents where id = '${id}'),
u as (
  update app.agents g set provision_state = (a.s - 'orphans') || jsonb_build_object(
    'orphans_archived', coalesce(a.s->'orphans_archived', '[]'::jsonb) || (a.s->'orphans'),
    'unblocked_at', now()::text)
  from a
  where g.id = a.id and jsonb_array_length(coalesce(a.s->'orphans', '[]'::jsonb)) > 0
    and coalesce(a.s->>'error', '') <> 'bound_foreign_owner'
  returning g.id)
select case
  when not exists (select 1 from a) then 'not_found'
  when exists (select 1 from u) then 'unblocked'
  when (select s->>'error' from a) = 'bound_foreign_owner' then 'refused'
  else 'nothing_to_do' end as result;`;
}

export async function unblockAgent(sql: Db, agentId: string): Promise<UnblockResult> {
  const rows = (await sql.unsafe(unblockStatement(agentId))) as { result: UnblockResult }[];
  return rows[0]!.result;
}

export async function checkAgent(sql: Db, agentId: string): Promise<CheckResult> {
  const rows = (await sql.unsafe(checkStatement(agentId))) as { result: CheckResult }[];
  return rows[0]!.result;
}
