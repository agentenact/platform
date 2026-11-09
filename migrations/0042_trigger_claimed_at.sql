-- agentenact-cloud: "Run now" on the agent page (Kerem, 2026-11-04: "agenti elle tetikleme neden yok").
-- claimed_at is the DB time the scheduler claimed a trigger. While the claim's lease is still the trigger's next_run_at
-- (next_run_at = claimed_at + 25 min, CLAIM_LEASE_MIN), a fire is in flight and Run now refuses instead of pulling the
-- trigger forward into a second, overlapping fire. NULL = never claimed since this column existed. Additive for the
-- running api: apply before it ships. Re-runnable.
-- Applied on servel with: servel infra sql @agentenact-supabase --service db ./migrations --track
ALTER TABLE app.triggers ADD COLUMN IF NOT EXISTS claimed_at timestamptz;
