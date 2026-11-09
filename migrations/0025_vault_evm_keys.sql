-- agentenact-cloud: an agent holds one live key per chain family (Kerem, 2026-10-28, "tamam yap"): its Stellar ed25519
-- seed as before, and an EVM secp256k1 key the vault creates on first use (testnet only: Base Sepolia first). Both are
-- sealed under KEYS_MASTER_SECRET; the EVM row's AAD adds '|evm' (keys/index.ts).
-- The vault's ledger takes the two EVM signature kinds: evm_payment (an EIP-3009 TransferWithAuthorization on pinned
-- USDC; amount_units is counted in 7-decimal units, like Stellar payments, so one day cap covers every chain) and
-- evm_record (an Enactment Record, EIP-191). network says which chain a row signed for.
-- Additive for the running vault (existing rows become chain_family 'stellar'): apply BEFORE the vault that reads it.
-- Applied on servel with: servel infra sql @agentenact-supabase --service db ./migrations --track
-- Re-runnable.

ALTER TABLE keyvault.keys ADD COLUMN IF NOT EXISTS chain_family text NOT NULL DEFAULT 'stellar';
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'keys_chain_family_check') THEN
    ALTER TABLE keyvault.keys ADD CONSTRAINT keys_chain_family_check CHECK (chain_family IN ('stellar', 'evm'));
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'keys_evm_address_check') THEN
    ALTER TABLE keyvault.keys ADD CONSTRAINT keys_evm_address_check CHECK (chain_family <> 'evm' OR public_key ~ '^0x[0-9a-f]{40}$');
  END IF;
END $$;
CREATE UNIQUE INDEX IF NOT EXISTS keys_one_live_per_agent_family ON keyvault.keys (agent_id, chain_family) WHERE destroyed_at IS NULL;
DROP INDEX IF EXISTS keyvault.keys_one_live_per_agent;

ALTER TABLE keyvault.signatures ADD COLUMN IF NOT EXISTS network text;
ALTER TABLE keyvault.signatures DROP CONSTRAINT IF EXISTS vault_signatures_kind_check;
ALTER TABLE keyvault.signatures ADD CONSTRAINT vault_signatures_kind_check
  CHECK (kind IN ('birth', 'bind', 'record', 'payment', 'evm_payment', 'evm_record'));
ALTER TABLE keyvault.signatures DROP CONSTRAINT IF EXISTS vault_signatures_payee_check;
ALTER TABLE keyvault.signatures ADD CONSTRAINT vault_signatures_payee_check
  CHECK (payee IS NULL OR payee ~ '^[GC][A-Z2-7]{55}$' OR payee ~ '^0x[0-9a-f]{40}$');
ALTER TABLE keyvault.signatures DROP CONSTRAINT IF EXISTS vault_signatures_payment_fields;
ALTER TABLE keyvault.signatures ADD CONSTRAINT vault_signatures_payment_fields
  CHECK ((kind IN ('payment', 'evm_payment')) = (payee IS NOT NULL AND amount_units IS NOT NULL));
ALTER TABLE keyvault.signatures DROP CONSTRAINT IF EXISTS vault_signatures_record_fields;
ALTER TABLE keyvault.signatures ADD CONSTRAINT vault_signatures_record_fields
  CHECK ((kind IN ('record', 'evm_record')) = (ref IS NOT NULL));
ALTER TABLE keyvault.signatures DROP CONSTRAINT IF EXISTS vault_signatures_evm_network;
ALTER TABLE keyvault.signatures ADD CONSTRAINT vault_signatures_evm_network
  CHECK (kind NOT IN ('evm_payment', 'evm_record') OR network ~ '^eip155:[0-9]+$');
-- One record per settlement, on any chain (an EVM tx hash is stored without 0x, lowercase).
DROP INDEX IF EXISTS keyvault.vault_signatures_one_record_per_settlement;
CREATE UNIQUE INDEX IF NOT EXISTS signatures_one_record_per_settlement ON keyvault.signatures (ref) WHERE kind IN ('record', 'evm_record');

-- The api's hire ledger says which network a hire paid on; an EVM tx hash is stored like a Stellar one (64 hex, no 0x).
ALTER TABLE app.spend ADD COLUMN IF NOT EXISTS network text NOT NULL DEFAULT 'stellar:testnet';
ALTER TABLE app.spend DROP CONSTRAINT IF EXISTS spend_payee_check;
ALTER TABLE app.spend ADD CONSTRAINT spend_payee_check CHECK (payee ~ '^G[A-Z2-7]{55}$' OR payee ~ '^0x[0-9a-f]{40}$');
