-- agentenact-cloud vault: one row per transaction the vault signed with the platform sponsor key (moved from the api).
-- The day fee cap is counted here, so an api that is taken over can ask for sponsor signatures but not burn past it.
-- Needs 0018 (schema keyvault, role agentenact_vault). Re-runnable.
-- Applied on servel with: servel infra sql @agentenact-supabase --service db ./migrations --track

-- kind: birth (sponsored agent account), registry (register_with_uri / set_agent_wallet), wallet (passkey wallet deploy).
-- fee_stroops is the fee the tx bids, its maximum: the cap counts what could be spent, not what was.
CREATE TABLE IF NOT EXISTS keyvault.sponsor_signatures (
  id           bigserial PRIMARY KEY,
  at           timestamptz NOT NULL DEFAULT now(),
  kind         text NOT NULL CONSTRAINT sponsor_signatures_kind_check CHECK (kind IN ('birth', 'registry', 'wallet')),
  tx_hash      text NOT NULL CONSTRAINT sponsor_signatures_hash_check CHECK (tx_hash ~ '^[0-9a-f]{64}$'),
  fee_stroops  bigint NOT NULL CONSTRAINT sponsor_signatures_fee_check CHECK (fee_stroops > 0)
);
CREATE INDEX IF NOT EXISTS sponsor_signatures_by_day ON keyvault.sponsor_signatures (at);

REVOKE ALL ON keyvault.sponsor_signatures FROM PUBLIC;
GRANT SELECT, INSERT ON keyvault.sponsor_signatures TO agentenact_vault;
GRANT USAGE ON ALL SEQUENCES IN SCHEMA keyvault TO agentenact_vault;
