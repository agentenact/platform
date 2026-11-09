import type { Db } from './db/index.js';
import { NOT_COMMUNITY_EMAIL_REGEX } from './test-accounts.js';

/**
 * The CTEs behind the home page's "on-chain txs": `community_txs` (h, at) is every seal, registry event and payment of the
 * agents created here, the automated test accounts left out. One definition for the public count and the operator's list of it,
 * so the two cannot disagree. Follows a `with`; `community_seals`, `community_reg`, `test_users`, `test_agents` and `test_reg` come along.
 */
export const communityTxCtes = (sql: Db) => sql`
  test_users as (select id from app.users where lower(email) ~ ${NOT_COMMUNITY_EMAIL_REGEX}),
  test_agents as (select id, agent_id from app.agents where user_id in (select id from test_users)),
  -- registry ids of test agents; a non-numeric agent_id cannot name a registry entry
  test_reg as (select agent_id::int as id from test_agents where agent_id ~ '^[0-9]{1,9}$'),
  -- registry ids of the agents the community count covers (created here, not a test account's); a payment or registry
  -- event of an agent built elsewhere is the network's, not ours, so it stays out of the community txs
  community_reg as (
    select agent_id::int as id from app.agents
    where status <> 'draft' and user_id not in (select id from test_users) and agent_id ~ '^[0-9]{1,9}$'
  ),
  community_seals as (select tx_hash, sent_at as at from app.check_seals where status = 'sent' and agent_id not in (select id from test_agents)),
  community_txs as (
    select tx_hash as h, at from community_seals
    union all select tx_hash, at from discovery.registry_events where agent_id in (select id from community_reg)
    union all select tx_hash, at from discovery.payments
      where (agent_id in (select id from community_reg) or payer_agent_id in (select id from community_reg))
        and agent_id not in (select id from test_reg) and (payer_agent_id is null or payer_agent_id not in (select id from test_reg))
  )`;
