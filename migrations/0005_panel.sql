-- agentenact-cloud P4: the panel schema. Additive: safe to apply before the code that needs it ships.
-- Applied on servel with: servel infra sql @agentenact-supabase --service db ./migrations --track

-- Pause (spec P4): a superset of the old statuses, swapped in one ALTER statement (atomic without a wrapping
-- transaction) so the table is never left without a status check and existing rows still validate.
-- agents_one_per_user (status <> 'revoked') is untouched, so a paused agent still holds the user's one slot.
ALTER TABLE app.agents
  DROP CONSTRAINT IF EXISTS agents_status_check,
  ADD CONSTRAINT agents_status_check
    CHECK (status IN ('draft', 'provisioning', 'active', 'paused', 'revoked'));

-- One plain-words line per run for the activity feed.
ALTER TABLE app.runs ADD COLUMN IF NOT EXISTS summary text CONSTRAINT runs_summary_check CHECK (char_length(summary) <= 400);

-- Per-day counters for checks that found nothing (quiet) and checks that fired.
CREATE TABLE IF NOT EXISTS app.check_days (
  agent_id uuid REFERENCES app.agents(id),
  day      date,
  quiet    int NOT NULL DEFAULT 0 CONSTRAINT check_days_quiet_check CHECK (quiet >= 0),
  fired    int NOT NULL DEFAULT 0 CONSTRAINT check_days_fired_check CHECK (fired >= 0),
  last_at  timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (agent_id, day)
);

-- Stored Enactment Records, keyed by settlement tx. A deleted run leaves its record behind.
CREATE TABLE IF NOT EXISTS app.records (
  tx_hash    text PRIMARY KEY CONSTRAINT records_tx_hash_check CHECK (tx_hash ~ '^[0-9a-f]{64}$'),
  agent_id   uuid NOT NULL REFERENCES app.agents(id),
  run_id     uuid REFERENCES app.runs(id) ON DELETE SET NULL,
  record     jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS records_by_agent_time ON app.records (agent_id, created_at DESC);

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'postgres') AND current_user <> 'postgres' THEN
    GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA app TO postgres;
  END IF;
END $$;
