-- agentenact-cloud usage ledger: one row per model call, with the real dollar cost OpenRouter reports.
-- Additive and re-runnable: safe to apply before the code that needs it ships.
-- Applied on servel with: servel infra sql @agentenact-supabase --service db ./migrations --track

-- kind: draft/trial/suggest/edit are Builder calls (user_id or anon, agent_id when the agent exists); mission/chat/service are agent runs
-- (agent_id + run_id). cost_usd is OpenRouter's own figure (usage.cost, in USD) and is null when the provider sent none (never an estimate).
-- No foreign keys on purpose: the ledger outlives the agent, the user and the run it describes. Rows before this table existed are not backfilled.
CREATE TABLE IF NOT EXISTS app.model_usage (
  id                 bigserial PRIMARY KEY,
  at                 timestamptz NOT NULL DEFAULT now(),
  kind               text NOT NULL CONSTRAINT model_usage_kind_check CHECK (kind IN ('draft', 'trial', 'suggest', 'edit', 'mission', 'chat', 'service')),
  model              text NOT NULL,
  input_tokens       int NOT NULL DEFAULT 0,
  output_tokens      int NOT NULL DEFAULT 0,
  cache_read_tokens  int NOT NULL DEFAULT 0,
  cache_write_tokens int NOT NULL DEFAULT 0,
  cost_usd           numeric(12,6),
  agent_id           uuid,
  user_id            uuid,
  run_id             uuid,
  anon               boolean NOT NULL DEFAULT false
);
CREATE INDEX IF NOT EXISTS model_usage_by_time ON app.model_usage (at);
CREATE INDEX IF NOT EXISTS model_usage_by_agent ON app.model_usage (agent_id, at);
CREATE INDEX IF NOT EXISTS model_usage_by_model ON app.model_usage (model, at);

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'postgres') AND current_user <> 'postgres' THEN
    GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA app TO postgres;
    GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA app TO postgres;
  END IF;
END $$;
