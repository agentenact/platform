-- agentenact-cloud: one account's own agent ceiling (Kerem, 2026-10-31: one agent from every template on his account).
-- agent_limit, when set, replaces AGENT_LIMIT for that account (agents it may hold, not revoked) and lifts its daily
-- ceilings to at least the same number (AGENT_CREATIONS_PER_DAY, SPONSORED_STARTS_PER_DAY), so it can actually reach it.
-- NULL (every account today): the env defaults, as before. Only an operator sets it; nothing in the panel writes it.
-- The extra-agent reserve rule (0032) still applies: one agent waiting for its first funding at a time.
-- Additive: apply BEFORE the api that reads it. Re-runnable.
-- Applied on servel with: servel infra sql @agentenact-supabase --service db ./migrations --track

ALTER TABLE app.users ADD COLUMN IF NOT EXISTS agent_limit int;
ALTER TABLE app.users DROP CONSTRAINT IF EXISTS users_agent_limit_check;
ALTER TABLE app.users ADD CONSTRAINT users_agent_limit_check CHECK (agent_limit BETWEEN 1 AND 100);
