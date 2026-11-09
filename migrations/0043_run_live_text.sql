-- agentenact-cloud: what a mission is writing, live, and its whole answer afterwards (Kerem, 2026-11-04: "belki
-- streamingi de göstermeliyiz?", "çıktı formatını her yerde düzgün göstermeliyiz").
-- live_text: the tail of a running mission's text, written about once a second while it is `running` and cleared when it
-- finishes. result: the mission's whole answer (up to 20,000 characters), shown formatted when the owner opens the run;
-- `summary` stays the 400-character line the feed and the agent's own context use. Both are cleared with the agent's
-- private content 30 days after deletion.
-- call_details: what each tool call was about (the search and its hits, the page read, the email written, the note
-- kept), for the owner only (Kerem's call 2026-11-04); `steps` stays redacted. Read only by the owner's one-run route. Additive for the running api: apply before it ships. Re-runnable.
-- Applied on servel with: servel infra sql @agentenact-supabase --service db ./migrations --track
ALTER TABLE app.runs ADD COLUMN IF NOT EXISTS live_text text;
ALTER TABLE app.runs ADD COLUMN IF NOT EXISTS result text;
ALTER TABLE app.runs ADD COLUMN IF NOT EXISTS call_details jsonb;
