-- agentenact-cloud: every condition check is sealed on chain (Kerem, 2026-10-29, "Her kontrolde"), and every mission's
-- decision with the transactions it produced on any chain ("kararlari dogrulanabilir sekilde stellarda da tx").
-- One row per check: the canonical `ae.check/1` document (api src/seals/format.ts, salted, owner-only), its sha256, and the
-- agent's own testnet transaction carrying that hash as MEMO_HASH once the worker has landed it (fee-bumped by the
-- sponsor). Kept after app.check_log forgets the check (7 days): the document is what makes the hash checkable.
-- The vault's ledger takes kind 'seal' (the agent's inner seal tx) and the sponsor's takes 'seal' (its fee-bump).
-- Additive: apply BEFORE the vault and the api that write it. Re-runnable.
-- Applied on servel with: servel infra sql @agentenact-supabase --service db ./migrations --track

CREATE TABLE IF NOT EXISTS app.check_seals (
  id          bigserial PRIMARY KEY,
  agent_id    uuid NOT NULL REFERENCES app.agents(id),
  -- check: one condition check (ae.check/1); decision: one finished mission (ae.decision/1), with its run.
  kind        text NOT NULL DEFAULT 'check' CONSTRAINT check_seals_kind_check CHECK (kind IN ('check', 'decision')),
  run_id      uuid,
  check_at    timestamptz NOT NULL,
  document    text NOT NULL CONSTRAINT check_seals_document_check CHECK (octet_length(document) <= 8192),
  digest      text NOT NULL CONSTRAINT check_seals_digest_check CHECK (digest ~ '^[0-9a-f]{64}$'),
  status      text NOT NULL DEFAULT 'pending' CONSTRAINT check_seals_status_check CHECK (status IN ('pending', 'sent', 'failed')),
  attempts    int NOT NULL DEFAULT 0,
  next_at     timestamptz NOT NULL DEFAULT now(),
  tx_hash     text CONSTRAINT check_seals_tx_check CHECK (tx_hash ~ '^[0-9a-f]{64}$'),
  sent_at     timestamptz,
  error       text CONSTRAINT check_seals_error_check CHECK (char_length(error) <= 200),
  created_at  timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT check_seals_sent_fields CHECK ((status = 'sent') = (tx_hash IS NOT NULL AND sent_at IS NOT NULL)),
  CONSTRAINT check_seals_decision_run CHECK ((kind = 'decision') = (run_id IS NOT NULL))
);
CREATE UNIQUE INDEX IF NOT EXISTS check_seals_one_per_run ON app.check_seals (run_id) WHERE run_id IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS check_seals_digest ON app.check_seals (digest);
CREATE INDEX IF NOT EXISTS check_seals_due ON app.check_seals (next_at) WHERE status = 'pending';
CREATE INDEX IF NOT EXISTS check_seals_by_agent_time ON app.check_seals (agent_id, check_at DESC);

ALTER TABLE keyvault.signatures DROP CONSTRAINT IF EXISTS vault_signatures_kind_check;
ALTER TABLE keyvault.signatures ADD CONSTRAINT vault_signatures_kind_check
  CHECK (kind IN ('birth', 'bind', 'record', 'payment', 'evm_payment', 'evm_record', 'seal'));
ALTER TABLE keyvault.sponsor_signatures DROP CONSTRAINT IF EXISTS sponsor_signatures_kind_check;
ALTER TABLE keyvault.sponsor_signatures ADD CONSTRAINT sponsor_signatures_kind_check CHECK (kind IN ('birth', 'registry', 'wallet', 'seal'));

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'agentenact_api') THEN
    GRANT SELECT, INSERT, UPDATE, DELETE ON app.check_seals TO agentenact_api;
    GRANT USAGE, SELECT ON SEQUENCE app.check_seals_id_seq TO agentenact_api;
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'postgres') AND current_user <> 'postgres' THEN
    GRANT SELECT, INSERT, UPDATE, DELETE ON app.check_seals TO postgres;
    GRANT USAGE, SELECT ON SEQUENCE app.check_seals_id_seq TO postgres;
  END IF;
END $$;
