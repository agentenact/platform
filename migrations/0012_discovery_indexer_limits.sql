-- Discovery index (final review I4/M9): bound what the discovery_indexer role can cost the shared database.
-- Not applied automatically. Apply BEFORE redeploying the indexer, with:
--   servel infra sql @agentenact-supabase --service db ./migrations --track
-- Re-runnable. A no-op while the role does not exist (it is created by 0007).
--  CONNECTION LIMIT 10: the indexer holds at most 5 pooled connections plus 1 dedicated lock connection (see src/db.ts);
--                       the rest is headroom for a rolling restart whose old sessions have not been reaped yet.
--  statement_timeout:   no indexer statement should run past 30 s; a runaway one is cancelled by the server.
--  idle_in_transaction_session_timeout: a transaction left open (a stuck process) releases its row and feed locks.
--  default privileges:  a later migration that adds a discovery table or sequence is usable by the indexer at once, instead
--                       of failing at runtime. They cover objects created by the role that runs the migration.

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'discovery_indexer') THEN
    ALTER ROLE discovery_indexer CONNECTION LIMIT 10;
    ALTER ROLE discovery_indexer SET statement_timeout = '30s';
    ALTER ROLE discovery_indexer SET idle_in_transaction_session_timeout = '60s';
    ALTER DEFAULT PRIVILEGES IN SCHEMA discovery GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO discovery_indexer;
    ALTER DEFAULT PRIVILEGES IN SCHEMA discovery GRANT USAGE, SELECT ON SEQUENCES TO discovery_indexer;
  END IF;
END $$;
