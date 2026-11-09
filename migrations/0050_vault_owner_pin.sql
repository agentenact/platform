-- agentenact-cloud: the vault pins each agent's owner in its own schema (Kerem, 2026-11-07). A deleted agent's close
-- (sweep, merge) used to go to app.users.owner_address, read through app.agents.user_id: both are api-writable (0020), so
-- a taken-over api could point a sweep at an address of its own. The vault now writes the owner it signs into the bind
-- entry (keyvault.keys.owner_address, which the api cannot read or write) and closes only to that address.
-- Backfill: existing Stellar keys take their user's owner address as it stands when this runs (a one-time trust, testnet
-- only). Additive and re-runnable: safe to apply before the code that needs it ships (the old vault ignores the column).
-- Applied on servel with: servel infra sql @agentenact-supabase --service db ./migrations --track

ALTER TABLE keyvault.keys ADD COLUMN IF NOT EXISTS owner_address text;

UPDATE keyvault.keys k
   SET owner_address = u.owner_address
  FROM app.agents a JOIN app.users u ON u.id = a.user_id
 WHERE k.agent_id = a.id
   AND k.chain_family = 'stellar'
   AND k.owner_address IS NULL
   AND u.owner_address IS NOT NULL;
