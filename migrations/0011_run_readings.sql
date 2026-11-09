-- agentenact-cloud run readings: per-check readings, the model a run used, and an email-bound draft handoff.
-- Additive only and re-runnable: safe to apply before the code that needs it ships.
-- Applied on servel with: servel infra sql @agentenact-supabase --service db ./migrations --track

-- One short, temporary row per condition check. reading is the per-tool extract (at most 512 bytes), never the raw fetch.
CREATE TABLE IF NOT EXISTS app.check_log (
  id         bigserial PRIMARY KEY,
  agent_id   uuid NOT NULL REFERENCES app.agents(id),
  trigger_id uuid, -- no foreign key: replacing a spec deletes its triggers, which must never scan or rewrite this log
  at         timestamptz NOT NULL DEFAULT now(),
  held       boolean,
  reading    jsonb CONSTRAINT check_log_reading_check CHECK (reading IS NULL OR octet_length(reading::text) <= 512)
);
CREATE INDEX IF NOT EXISTS check_log_by_agent_time ON app.check_log (agent_id, at DESC);
-- Serves the bounded 7-day delete (oldest rows first, across all agents).
CREATE INDEX IF NOT EXISTS check_log_by_time ON app.check_log (at);

-- The model id a run used (shown only inside Technical details).
ALTER TABLE app.runs ADD COLUMN IF NOT EXISTS model text CONSTRAINT runs_model_check CHECK (char_length(model) <= 100);

-- sha256(lowercase(trim(email))) of the visitor a parked draft belongs to; null keeps the old behaviour.
ALTER TABLE app.draft_handoffs ADD COLUMN IF NOT EXISTS email_sha256 text CONSTRAINT draft_handoffs_email_sha256_check CHECK (email_sha256 ~ '^[0-9a-f]{64}$');

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'postgres') AND current_user <> 'postgres' THEN
    GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA app TO postgres;
    GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA app TO postgres;
  END IF;
END $$;
