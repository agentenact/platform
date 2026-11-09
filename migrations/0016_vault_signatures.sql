-- agentenact-cloud vault: one row per signature the vault (the signer process that alone holds KEYS_MASTER_SECRET)
-- made with an agent key. It is the vault's own ledger: payment caps are counted here, independently of the
-- api's app.spend, so an api that is taken over still cannot sign past them.
-- Additive and re-runnable: safe to apply before the code that needs it ships.
-- Applied on servel with: servel infra sql @agentenact-supabase --service db ./migrations --track

-- kind: birth (the sponsored account tx), bind (set_agent_wallet auth entry), record (an Enactment Record),
-- payment (a USDC transfer auth entry). digest is the 32-byte hash the vault signed, hex.
-- payee/amount_units only on payments; ref (the settlement tx hash) only on records: one record per settlement.
-- No foreign keys on purpose: the ledger outlives the agent it describes.
CREATE TABLE IF NOT EXISTS app.vault_signatures (
  id           bigserial PRIMARY KEY,
  at           timestamptz NOT NULL DEFAULT now(),
  agent_id     uuid NOT NULL,
  kind         text NOT NULL CONSTRAINT vault_signatures_kind_check CHECK (kind IN ('birth', 'bind', 'record', 'payment')),
  digest       text NOT NULL CONSTRAINT vault_signatures_digest_check CHECK (digest ~ '^[0-9a-f]{64}$'),
  payee        text CONSTRAINT vault_signatures_payee_check CHECK (payee IS NULL OR payee ~ '^[GC][A-Z2-7]{55}$'),
  amount_units bigint CONSTRAINT vault_signatures_amount_check CHECK (amount_units IS NULL OR amount_units > 0),
  ref          text CONSTRAINT vault_signatures_ref_check CHECK (ref IS NULL OR ref ~ '^[0-9a-f]{64}$'),
  CONSTRAINT vault_signatures_payment_fields CHECK ((kind = 'payment') = (payee IS NOT NULL AND amount_units IS NOT NULL)),
  CONSTRAINT vault_signatures_record_fields CHECK ((kind = 'record') = (ref IS NOT NULL))
);
CREATE INDEX IF NOT EXISTS vault_signatures_by_agent ON app.vault_signatures (agent_id, kind, at);
CREATE UNIQUE INDEX IF NOT EXISTS vault_signatures_one_record_per_settlement ON app.vault_signatures (ref) WHERE kind = 'record';

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'postgres') AND current_user <> 'postgres' THEN
    GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA app TO postgres;
    GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA app TO postgres;
  END IF;
END $$;
