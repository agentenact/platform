-- agentenact-cloud: every agent pays its own way (Kerem, 2026-11-01, "Her şey agent cüzdanından"). Under FEE_MODEL=agent
-- (the default) no agent is the platform's to sponsor: each one is born 'due' and stays paused until its first USDC
-- arrives. Then one tx (src/agents/reserve-tx.ts handover) swaps its own USDC into its 1.5 XLM reserves, a fee float, and
-- the fees the sponsor fronted at its birth, which it pays back in the same tx. From then on it pays its own fees: check
-- seals go out unbumped, and a float that ran low is bought again (topup). FEE_MODEL=sponsor keeps the earlier model.
--
-- pays_own_fees: the agent's fees come from its own XLM (set by a handover that bought the float).
-- reserve_repay_stroops: what the sponsor fronted at its birth (Horizon fee_charged of its birth, register and bind txs),
-- written by the worker before the handover; the vault signs a repay of exactly this, nothing else.
-- Existing agents keep their reserve_state. Older 'due' agents (extra ones under FEE_MODEL=sponsor) also buy the float and
-- repay their birth fees at their funding, but stay live meanwhile: they were never paused_for_funds.
-- Additive: apply BEFORE the vault and the api that read it. Re-runnable.
-- Applied on servel with: servel infra sql @agentenact-supabase --service db ./migrations --track

ALTER TABLE app.agents ADD COLUMN IF NOT EXISTS pays_own_fees boolean NOT NULL DEFAULT false;
ALTER TABLE app.agents ADD COLUMN IF NOT EXISTS reserve_repay_stroops bigint;
-- paused_for_funds: born paused by provisioning for want of funds. Only these are resumed by the handover and refused a
-- manual resume; an agent its owner paused (or an older 'due' one) is never touched.
ALTER TABLE app.agents ADD COLUMN IF NOT EXISTS paused_for_funds boolean NOT NULL DEFAULT false;
ALTER TABLE app.agents DROP CONSTRAINT IF EXISTS agents_reserve_repay_check;
ALTER TABLE app.agents ADD CONSTRAINT agents_reserve_repay_check CHECK (reserve_repay_stroops IS NULL OR reserve_repay_stroops BETWEEN 0 AND 10000000);
-- The worker also looks at self-paying agents whose float ran low (reserve_next_at set by the seal worker).
DROP INDEX IF EXISTS app.agents_reserve_due;
CREATE INDEX IF NOT EXISTS agents_reserve_work ON app.agents (reserve_next_at) WHERE reserve_state = 'due' OR (pays_own_fees AND reserve_next_at IS NOT NULL);

-- The vault checks these before it signs a reserve tx as the agent (keys/vault.ts signReserve). reserve_state was read
-- there since 0032 without a grant; a vault on agentenact_vault would have refused every handover.
-- paused_for_funds: the testnet credit (0036, keys/vault.ts) may fund an agent born paused for want of funds.
GRANT SELECT (reserve_state, pays_own_fees, reserve_repay_stroops, paused_for_funds) ON app.agents TO agentenact_vault;
