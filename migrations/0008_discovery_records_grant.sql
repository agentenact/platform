-- Discovery index (sub-project E, task 13): lets the indexer read the hosted agents' stored Enactment Records.
-- MUST be applied after the app migration that creates app.records (P4, 0005). If the table is absent when this runs the
-- block does nothing and the indexer simply ingests submitted records only; re-apply this file once app.records exists.
-- Nothing else in the app schema becomes readable: the role gets USAGE on the schema (needed to name the table) and
-- SELECT on this one table.
-- Caveat: USAGE on schema app makes any function later added to app executable by the role (PUBLIC has EXECUTE by default);
-- when one is added, REVOKE EXECUTE ON FUNCTION it FROM PUBLIC. The indexer logs records_grant_missing once per process
-- when the table exists but SELECT is denied (this file ran before the table, or was skipped by migration tracking).

DO $$
BEGIN
  IF to_regclass('app.records') IS NOT NULL AND EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'discovery_indexer') THEN
    GRANT USAGE ON SCHEMA app TO discovery_indexer;
    GRANT SELECT ON app.records TO discovery_indexer;
  END IF;
END $$;
