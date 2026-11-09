-- agentenact-cloud: schedules read in the person's time zone (Kerem, 2026-10-28: "morning" was 08:00 UTC for everyone).
-- cron_tz is the IANA zone a cron trigger's expression reads in; NULL keeps the old meaning, UTC. The spec carries it as
-- triggers[].tz; the panel fills it from the browser. Additive for the running api: apply before it ships.
-- Applied on servel with: servel infra sql @agentenact-supabase --service db ./migrations --track
ALTER TABLE app.triggers ADD COLUMN IF NOT EXISTS cron_tz text;
