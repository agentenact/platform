-- agentenact-cloud: owners delete their agents (Kerem, 2026-10-30, "Soft delete + cüzdanı kapat"). A deleted agent is a
-- tombstone: status 'revoked' (already understood everywhere: it holds no slot, signs nothing, sells nothing) plus when it
-- was deleted. Its Stellar wallet is then closed by the api's closer (src/agents/close.ts): what it holds goes to the
-- owner, the trustline and the account go (the sponsor's reserves come back), and the vault key is destroyed.
-- close_state: pending (the closer has work), closed (done, or nothing to close), failed (gave up; the key is kept).
-- purged_at: when the agent's private content (memory, conversations, readings) was cleared, 30 days after deletion.
-- Records and seals stay: they are what keeps past proofs checkable.
-- The vault's ledger and the sponsor's ledger take kind 'close'.
-- Additive: apply BEFORE the vault and the api that write it. Re-runnable.
-- Applied on servel with: servel infra sql @agentenact-supabase --service db ./migrations --track

ALTER TABLE app.agents ADD COLUMN IF NOT EXISTS deleted_at timestamptz;
ALTER TABLE app.agents ADD COLUMN IF NOT EXISTS close_state text;
ALTER TABLE app.agents DROP CONSTRAINT IF EXISTS agents_close_state_check;
ALTER TABLE app.agents ADD CONSTRAINT agents_close_state_check CHECK (close_state IN ('pending', 'closed', 'failed'));
ALTER TABLE app.agents ADD COLUMN IF NOT EXISTS close_attempts int NOT NULL DEFAULT 0;
ALTER TABLE app.agents ADD COLUMN IF NOT EXISTS close_next_at timestamptz;
ALTER TABLE app.agents ADD COLUMN IF NOT EXISTS close_txs text[] NOT NULL DEFAULT '{}';
ALTER TABLE app.agents ADD COLUMN IF NOT EXISTS close_error text;
ALTER TABLE app.agents DROP CONSTRAINT IF EXISTS agents_close_error_check;
ALTER TABLE app.agents ADD CONSTRAINT agents_close_error_check CHECK (char_length(close_error) <= 200);
ALTER TABLE app.agents ADD COLUMN IF NOT EXISTS purged_at timestamptz;
ALTER TABLE app.agents DROP CONSTRAINT IF EXISTS agents_deleted_fields;
ALTER TABLE app.agents ADD CONSTRAINT agents_deleted_fields CHECK (deleted_at IS NULL OR status = 'revoked');
CREATE INDEX IF NOT EXISTS agents_close_due ON app.agents (close_next_at) WHERE close_state = 'pending';
CREATE INDEX IF NOT EXISTS agents_purge_due ON app.agents (deleted_at) WHERE deleted_at IS NOT NULL AND purged_at IS NULL;

ALTER TABLE keyvault.signatures DROP CONSTRAINT IF EXISTS vault_signatures_kind_check;
ALTER TABLE keyvault.signatures ADD CONSTRAINT vault_signatures_kind_check
  CHECK (kind IN ('birth', 'bind', 'record', 'payment', 'evm_payment', 'evm_record', 'seal', 'close'));
ALTER TABLE keyvault.sponsor_signatures DROP CONSTRAINT IF EXISTS sponsor_signatures_kind_check;
ALTER TABLE keyvault.sponsor_signatures ADD CONSTRAINT sponsor_signatures_kind_check CHECK (kind IN ('birth', 'registry', 'wallet', 'seal', 'close'));
