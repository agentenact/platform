-- agentenact-cloud P4 Task 19 fix: the selling suggestion gets its own daily cap, so builder_usage accepts kind 'suggest'.
-- A superset of the old check, swapped in ONE ALTER statement (atomic without a wrapping transaction), re-runnable.
-- Safe to apply before the code that needs it ships: old code never writes 'suggest'.
-- Applied on servel with: servel infra sql @agentenact-supabase --service db ./migrations --track
ALTER TABLE app.builder_usage
  DROP CONSTRAINT IF EXISTS builder_usage_kind_check,
  ADD CONSTRAINT builder_usage_kind_check
    CHECK (kind IN ('draft', 'trial', 'edit', 'handoff', 'suggest'));
