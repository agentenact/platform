-- agentenact-cloud P3a: the runtime. Specs, skills, memory, services, triggers, runs, per-user daily caps.
-- Applied on servel with: servel infra sql @agentenact-supabase --service db ./migrations --track

-- Spec §6 per-user daily caps. The epoch default makes the first admission start a fresh day.
ALTER TABLE app.users
  ADD COLUMN daily_tokens   int         NOT NULL DEFAULT 0,
  ADD COLUMN daily_runs     int         NOT NULL DEFAULT 0,
  ADD COLUMN daily_reset_at timestamptz NOT NULL DEFAULT 'epoch';

-- The approved spec version the agent runs on (null: none approved yet).
ALTER TABLE app.agents ADD COLUMN active_spec_version int;

CREATE TABLE app.agent_specs (
  agent_id     uuid  NOT NULL REFERENCES app.agents(id),
  version      int   NOT NULL CHECK (version > 0),
  status       text  NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'approved')),
  spec         jsonb NOT NULL,
  build_prompt text,
  created_at   timestamptz NOT NULL DEFAULT now(),
  approved_at  timestamptz,
  PRIMARY KEY (agent_id, version)
);

-- The approved spec's skills (agentskills.io: name, description, body). Replaced on every approval.
CREATE TABLE app.skills (
  agent_id    uuid NOT NULL REFERENCES app.agents(id),
  name        text NOT NULL,
  description text NOT NULL,
  body        text NOT NULL,
  version     int  NOT NULL,   -- the spec version it came from
  PRIMARY KEY (agent_id, name)
);

-- Written only through the `remember` tool. Never read by service runs.
CREATE TABLE app.memory (
  agent_id   uuid NOT NULL REFERENCES app.agents(id),
  key        text NOT NULL CHECK (key ~ '^[a-z0-9][a-z0-9_.-]{0,63}$'),
  value      text NOT NULL CHECK (char_length(value) <= 2000),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (agent_id, key)
);

-- Paid services (spec §4). Never deleted (runs point at them); a service dropped from the spec goes 'off'.
-- output_schema is spec §4's output_template: a JSON Schema (subset) the output must match (plan D4).
CREATE TABLE app.services (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  agent_id      uuid NOT NULL REFERENCES app.agents(id),
  slug          text NOT NULL CHECK (slug ~ '^[a-z0-9][a-z0-9-]{0,39}$'),
  description   text NOT NULL,
  input_schema  jsonb NOT NULL,
  output_schema jsonb NOT NULL,
  price_usdc    numeric(20,7) NOT NULL CHECK (price_usdc > 0 AND price_usdc <= 10),
  persona       text NOT NULL,
  skill_body    text NOT NULL DEFAULT '',
  tools         jsonb NOT NULL DEFAULT '[]',
  spec_version  int  NOT NULL,
  status        text NOT NULL DEFAULT 'off' CHECK (status IN ('off', 'live')),
  updated_at    timestamptz NOT NULL DEFAULT now(),
  UNIQUE (agent_id, slug)
);

-- Cron and condition triggers of the approved spec. Replaced on every approval.
CREATE TABLE app.triggers (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  agent_id      uuid NOT NULL REFERENCES app.agents(id),
  spec_version  int  NOT NULL,
  kind          text NOT NULL CHECK (kind IN ('cron', 'condition')),
  cron_expr     text,
  condition     jsonb,          -- { fetch: { tool, args }, code, every_s }
  mission       text NOT NULL,
  next_run_at   timestamptz NOT NULL,
  cooldown_s    int  NOT NULL DEFAULT 0,
  enabled       boolean NOT NULL DEFAULT true,
  last_fired_at timestamptz,
  error_streak  int  NOT NULL DEFAULT 0,
  CHECK ((kind = 'cron') = (cron_expr IS NOT NULL)),
  CHECK ((kind = 'condition') = (condition IS NOT NULL))
);
CREATE INDEX triggers_due ON app.triggers (next_run_at) WHERE enabled;

-- One budgeted run. steps is redacted: tool names and token counts, never tool inputs or results.
CREATE TABLE app.runs (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  agent_id           uuid NOT NULL REFERENCES app.agents(id),
  mode               text NOT NULL CONSTRAINT runs_mode_check CHECK (mode IN ('chat', 'mission', 'service')),
  trigger_id         uuid REFERENCES app.triggers(id) ON DELETE SET NULL,
  service_id         uuid REFERENCES app.services(id),
  status             text NOT NULL DEFAULT 'running' CONSTRAINT runs_status_check CHECK (status IN ('running', 'done', 'budget', 'capped', 'error')),
  stop_reason        text,
  steps              jsonb NOT NULL DEFAULT '[]',
  input_tokens       int NOT NULL DEFAULT 0,
  output_tokens      int NOT NULL DEFAULT 0,
  cache_read_tokens  int NOT NULL DEFAULT 0,
  cache_write_tokens int NOT NULL DEFAULT 0,
  tool_calls         int NOT NULL DEFAULT 0,
  usdc_spent         numeric(20,7) NOT NULL DEFAULT 0,
  usdc_earned        numeric(20,7) NOT NULL DEFAULT 0,
  settlement_tx      text CONSTRAINT runs_settlement_tx_check CHECK (settlement_tx IS NULL OR settlement_tx ~ '^[0-9a-f]{64}$'),
  started_at         timestamptz NOT NULL DEFAULT now(),
  ended_at           timestamptz
);
CREATE INDEX runs_by_agent ON app.runs (agent_id, started_at DESC);

-- 0001 granted on the tables that existed then; grant again for the new ones.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'postgres') AND current_user <> 'postgres' THEN
    GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA app TO postgres;
  END IF;
END $$;
