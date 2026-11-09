-- agentenact-cloud: several agents per account (Kerem, 2026-10-28; replaces plan D14's one per user).
-- The ceiling moves to the api (AGENT_LIMIT, AGENT_CREATIONS_PER_DAY), counted under a lock on the user row, so the
-- unique index that settled concurrent creates goes. creation_key makes a create idempotent: a browser whose answer
-- got lost asks again with the same key and gets the same agent. Additive for the running api: apply before it ships.
-- Applied on servel with: servel infra sql @agentenact-supabase --service db ./migrations --track
DROP INDEX IF EXISTS app.agents_one_per_user;
CREATE INDEX IF NOT EXISTS agents_live_by_user ON app.agents (user_id) WHERE status <> 'revoked';
ALTER TABLE app.agents ADD COLUMN IF NOT EXISTS creation_key uuid;
CREATE UNIQUE INDEX IF NOT EXISTS agents_creation_key ON app.agents (user_id, creation_key) WHERE creation_key IS NOT NULL;
