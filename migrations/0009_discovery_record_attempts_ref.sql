-- Discovery index (sub-project E, task 13 fixes): record_attempts learns which hosted record a row is about and how many
-- outages it has seen.
--  ref:     the app.records tx_hash of a hosted record, so the ingest scan skips permanently final rows in SQL instead of
--           reading and hashing them on every run. NULL for submitted records.
--  outages: thrown chain errors (RPC / Horizon outage, timeout, 5xx). Backoff only, never counted toward the 4 tries.

ALTER TABLE discovery.record_attempts ADD COLUMN IF NOT EXISTS ref text;
ALTER TABLE discovery.record_attempts ADD COLUMN IF NOT EXISTS outages int NOT NULL DEFAULT 0;
CREATE INDEX IF NOT EXISTS record_attempts_ref_idx ON discovery.record_attempts (ref) WHERE ref IS NOT NULL;
