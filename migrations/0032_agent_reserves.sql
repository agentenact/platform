-- agentenact-cloud: who pays an agent's Stellar reserves (Kerem, 2026-10-31, "Rezerv devri (A)"). Every agent is born with
-- its account and USDC trustline sponsored by the platform (1.5 XLM locked). The platform keeps sponsoring one agent per
-- account; any other agent takes its own reserves over once it holds USDC: one tx swaps about 0.25 USDC (mainnet price)
-- into exactly 1.5 XLM on the agent's own account and the sponsor revokes its sponsorship (src/agents/reserve.ts).
--
-- reserve_state: free (the platform sponsors it), due (an extra agent: the handover runs at its first funding),
-- self_paid (the agent holds its own reserves; deleting it returns them to its owner).
-- Agents that exist before this migration are all free: nothing changes for them.
-- The vault's ledger and the sponsor's ledger take kind 'reserve'.
-- Additive: apply BEFORE the vault and the api that write it. Re-runnable.
-- Applied on servel with: servel infra sql @agentenact-supabase --service db ./migrations --track

ALTER TABLE app.agents ADD COLUMN IF NOT EXISTS reserve_state text NOT NULL DEFAULT 'free';
ALTER TABLE app.agents DROP CONSTRAINT IF EXISTS agents_reserve_state_check;
ALTER TABLE app.agents ADD CONSTRAINT agents_reserve_state_check CHECK (reserve_state IN ('free', 'due', 'self_paid'));
ALTER TABLE app.agents ADD COLUMN IF NOT EXISTS reserve_next_at timestamptz;
ALTER TABLE app.agents ADD COLUMN IF NOT EXISTS reserve_attempts int NOT NULL DEFAULT 0;
ALTER TABLE app.agents ADD COLUMN IF NOT EXISTS reserve_error text;
ALTER TABLE app.agents DROP CONSTRAINT IF EXISTS agents_reserve_error_check;
ALTER TABLE app.agents ADD CONSTRAINT agents_reserve_error_check CHECK (char_length(reserve_error) <= 200);
ALTER TABLE app.agents ADD COLUMN IF NOT EXISTS reserve_tx text;
-- What the swap was quoted at (USDC, 7 decimals); the tx itself is the truth.
ALTER TABLE app.agents ADD COLUMN IF NOT EXISTS reserve_usdc_units bigint;
CREATE INDEX IF NOT EXISTS agents_reserve_due ON app.agents (reserve_next_at) WHERE reserve_state = 'due';

ALTER TABLE keyvault.signatures DROP CONSTRAINT IF EXISTS vault_signatures_kind_check;
ALTER TABLE keyvault.signatures ADD CONSTRAINT vault_signatures_kind_check
  CHECK (kind IN ('birth', 'bind', 'record', 'payment', 'evm_payment', 'evm_record', 'seal', 'close', 'reserve'));
ALTER TABLE keyvault.sponsor_signatures DROP CONSTRAINT IF EXISTS sponsor_signatures_kind_check;
ALTER TABLE keyvault.sponsor_signatures ADD CONSTRAINT sponsor_signatures_kind_check CHECK (kind IN ('birth', 'registry', 'wallet', 'seal', 'close', 'reserve'));
