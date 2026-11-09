-- agentenact-cloud P3b: the hire ledger (spec §4 `spend`, §5.7). A row is reserved before the paid request
-- leaves and completed with the tx hash. Caps count every decision except 'failed' (plan D4).
-- Applied on servel with: servel infra sql @agentenact-supabase --service db ./migrations --track
CREATE TABLE app.spend (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  agent_id    uuid NOT NULL REFERENCES app.agents(id),
  run_id      uuid NOT NULL REFERENCES app.runs(id),
  url         text NOT NULL CHECK (char_length(url) <= 2000),
  payee       text NOT NULL CONSTRAINT spend_payee_check CHECK (payee ~ '^G[A-Z2-7]{55}$'),
  amount_usdc numeric(20,7) NOT NULL CONSTRAINT spend_amount_usdc_check CHECK (amount_usdc > 0 AND amount_usdc <= 0.05),
  tx_hash     text CHECK (tx_hash IS NULL OR tx_hash ~ '^[0-9a-f]{64}$'),
  decision    text NOT NULL DEFAULT 'reserved' CONSTRAINT spend_decision_check CHECK (decision IN ('reserved', 'settled', 'failed', 'unknown')),
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT spend_settled_needs_tx CHECK (decision <> 'settled' OR tx_hash IS NOT NULL)
);
CREATE UNIQUE INDEX spend_tx_hash_unique ON app.spend (tx_hash) WHERE tx_hash IS NOT NULL;
CREATE INDEX spend_by_agent_time ON app.spend (agent_id, created_at);
CREATE INDEX spend_by_run ON app.spend (run_id);

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'postgres') AND current_user <> 'postgres' THEN
    GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA app TO postgres;
  END IF;
END $$;
