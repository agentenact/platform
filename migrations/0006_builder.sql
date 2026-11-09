-- agentenact-cloud P4 Builder: the draft view, Builder usage counters and the sign-in handoff.
-- Additive and re-runnable: safe to apply before the code that needs it ships.
-- Applied on servel with: servel infra sql @agentenact-supabase --service db ./migrations --track

-- The plain-words view of a spec version (sentence, parameters, bindings) and the service the Builder suggests.
ALTER TABLE app.agent_specs ADD COLUMN IF NOT EXISTS view jsonb;
ALTER TABLE app.agent_specs ADD COLUMN IF NOT EXISTS service_suggestion jsonb;

-- Per-scope, per-day Builder usage. scope is a user id or an anonymous visitor key.
CREATE TABLE IF NOT EXISTS app.builder_usage (
  scope  text,
  day    date,
  kind   text   CONSTRAINT builder_usage_kind_check CHECK (kind IN ('draft', 'trial', 'edit', 'handoff')),
  n      int    NOT NULL DEFAULT 0,
  tokens bigint NOT NULL DEFAULT 0,
  PRIMARY KEY (scope, day, kind)
);

-- A draft carried across sign-in: the visitor's draft waits here, short-lived, under an unguessable id.
CREATE TABLE IF NOT EXISTS app.draft_handoffs (
  id         text PRIMARY KEY CONSTRAINT draft_handoffs_id_check CHECK (id ~ '^[A-Za-z0-9_-]{22,64}$'),
  draft      jsonb NOT NULL,
  expires_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'postgres') AND current_user <> 'postgres' THEN
    GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA app TO postgres;
  END IF;
END $$;
