-- agentenact-cloud morning note: the owner's one-time answer to "Want a short note each morning?".
-- null = not asked yet, true = yes, false = no. Additive and re-runnable: safe to apply before the code that needs it ships.
-- Applied on servel with: servel infra sql @agentenact-supabase --service db ./migrations --track
-- Storing the answer is all this does; nothing sends a note yet.
ALTER TABLE app.agents ADD COLUMN IF NOT EXISTS morning_note boolean;

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'postgres') AND current_user <> 'postgres' THEN
    GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA app TO postgres;
  END IF;
END $$;
