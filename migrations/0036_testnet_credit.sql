-- agentenact-cloud: testnet credit (Kerem, 2026-11-01). The platform sponsor sends a hosted agent 1 testnet USDC, bought
-- with its own XLM on the DEX, so the agent's hire_agent can pay other agents. Re-runnable.
-- Applied on servel with: servel infra sql @agentenact-supabase --service db ./migrations --track
--
-- Numbering: 0035 is taken by branch claude/project-thread-hojjuc (0035_vault_solana_keys); this file keeps its
-- 'solana_payment' kind so the order of the two does not matter. Renumber if another migration lands first.

-- The leader's credit worker: when it looks at the agent next, and what it last sent.
ALTER TABLE app.agents ADD COLUMN IF NOT EXISTS credit_next_at timestamptz;
ALTER TABLE app.agents ADD COLUMN IF NOT EXISTS credit_at timestamptz;
ALTER TABLE app.agents ADD COLUMN IF NOT EXISTS credit_tx text;
ALTER TABLE app.agents DROP CONSTRAINT IF EXISTS agents_credit_tx_check;
ALTER TABLE app.agents ADD CONSTRAINT agents_credit_tx_check CHECK (credit_tx IS NULL OR credit_tx ~ '^[0-9a-f]{64}$');
CREATE INDEX IF NOT EXISTS agents_credit_next ON app.agents (credit_next_at) WHERE status = 'active';

-- The vault counts credits per agent (keyvault.signatures, digest = the credit tx hash) and the sponsor signs kind 'credit'.
ALTER TABLE keyvault.signatures DROP CONSTRAINT IF EXISTS vault_signatures_kind_check;
ALTER TABLE keyvault.signatures ADD CONSTRAINT vault_signatures_kind_check
  CHECK (kind IN ('birth', 'bind', 'record', 'payment', 'evm_payment', 'evm_record', 'seal', 'close', 'reserve', 'solana_payment', 'credit'));
CREATE INDEX IF NOT EXISTS vault_signatures_credit ON keyvault.signatures (at) WHERE kind = 'credit';
ALTER TABLE keyvault.sponsor_signatures DROP CONSTRAINT IF EXISTS sponsor_signatures_kind_check;
ALTER TABLE keyvault.sponsor_signatures ADD CONSTRAINT sponsor_signatures_kind_check
  CHECK (kind IN ('birth', 'registry', 'wallet', 'seal', 'close', 'reserve', 'credit'));
