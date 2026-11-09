-- agentenact-cloud: an agent may also hold a Solana wallet (Kerem, 2026-11-01, "Solana devnet ekle"). Its ed25519 seed
-- is sealed like the others under KEYS_MASTER_SECRET, with AAD agent_id::text || '|solana' (keys/index.ts); public_key
-- is the base58 address. Created by the vault on first use, devnet only.
-- The vault's ledger takes solana_payment: one x402 exact TransferChecked of pinned devnet USDC (6 decimals), counted in
-- the same 7-decimal units as every other payment, so one day cap covers every chain.
-- app.spend takes a base58 payee and a base58 transaction signature (Solana's tx id, case-sensitive, 64 bytes).
-- Additive for the running vault and api: apply BEFORE the vault that writes it.
-- Applied on servel with: servel infra sql @agentenact-supabase --service db ./migrations --track
-- Re-runnable. Written as 0035 on its branch; renumbered after 0036–0040 landed first, so its kind check keeps
-- 0036's 'credit'.

ALTER TABLE keyvault.keys DROP CONSTRAINT IF EXISTS keys_chain_family_check;
ALTER TABLE keyvault.keys ADD CONSTRAINT keys_chain_family_check CHECK (chain_family IN ('stellar', 'evm', 'solana'));
ALTER TABLE keyvault.keys DROP CONSTRAINT IF EXISTS keys_solana_address_check;
ALTER TABLE keyvault.keys ADD CONSTRAINT keys_solana_address_check
  CHECK (chain_family <> 'solana' OR public_key ~ '^[1-9A-HJ-NP-Za-km-z]{32,44}$');

ALTER TABLE keyvault.signatures DROP CONSTRAINT IF EXISTS vault_signatures_kind_check;
ALTER TABLE keyvault.signatures ADD CONSTRAINT vault_signatures_kind_check
  CHECK (kind IN ('birth', 'bind', 'record', 'payment', 'evm_payment', 'evm_record', 'seal', 'close', 'reserve', 'solana_payment', 'credit'));
ALTER TABLE keyvault.signatures DROP CONSTRAINT IF EXISTS vault_signatures_payee_check;
ALTER TABLE keyvault.signatures ADD CONSTRAINT vault_signatures_payee_check
  CHECK (payee IS NULL OR payee ~ '^[GC][A-Z2-7]{55}$' OR payee ~ '^0x[0-9a-f]{40}$'
         OR (kind = 'solana_payment' AND payee ~ '^[1-9A-HJ-NP-Za-km-z]{32,44}$'));
ALTER TABLE keyvault.signatures DROP CONSTRAINT IF EXISTS vault_signatures_payment_fields;
ALTER TABLE keyvault.signatures ADD CONSTRAINT vault_signatures_payment_fields
  CHECK ((kind IN ('payment', 'evm_payment', 'solana_payment')) = (payee IS NOT NULL AND amount_units IS NOT NULL));
ALTER TABLE keyvault.signatures DROP CONSTRAINT IF EXISTS vault_signatures_solana_network;
ALTER TABLE keyvault.signatures ADD CONSTRAINT vault_signatures_solana_network
  CHECK (kind <> 'solana_payment' OR network ~ '^solana:[1-9A-HJ-NP-Za-km-z]{32}$');

ALTER TABLE app.spend DROP CONSTRAINT IF EXISTS spend_payee_check;
ALTER TABLE app.spend ADD CONSTRAINT spend_payee_check
  CHECK (payee ~ '^G[A-Z2-7]{55}$' OR payee ~ '^0x[0-9a-f]{40}$' OR (network LIKE 'solana:%' AND payee ~ '^[1-9A-HJ-NP-Za-km-z]{32,44}$'));
-- 0004's unnamed check: 64 lowercase hex (Stellar, EVM without 0x), or a Solana signature (base58 of 64 bytes).
ALTER TABLE app.spend DROP CONSTRAINT IF EXISTS spend_tx_hash_check;
ALTER TABLE app.spend ADD CONSTRAINT spend_tx_hash_check
  CHECK (tx_hash IS NULL OR tx_hash ~ '^[0-9a-f]{64}$' OR (network LIKE 'solana:%' AND tx_hash ~ '^[1-9A-HJ-NP-Za-km-z]{64,88}$'));
