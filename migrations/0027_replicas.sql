-- agentenact-cloud: the api runs as several replicas (thread "Split api so it can run 2 replicas", 2026-10-29).
-- Plan D12 kept one replica because some state lived in one process. This moves what must be shared into Postgres:
--
-- * Instance liveness. Each api process takes a numbered instance id and holds the advisory lock
--   (INSTANCE_CLASS 'AEC4', id) on its lock session for its whole life. A process that dies loses its session and so
--   the lock: `app.instance_alive(id)` is false at once, with no heartbeat table to go stale.
-- * Rows a process owns while it works carry its instance id (runs, spend reservations, sign requests, a provision
--   in `creating`). The leader's recovery sweep fails only rows whose instance is dead, never a live replica's work.
--   NULL means "made before this migration": no process of that version can still run (they need the exclusive
--   single-replica lock, which every new process holds in shared mode), so NULL counts as dead.
-- * Leases: short exclusive claims (one owner conversation per agent, one provision start per agent, one copy of a
--   payment signature in flight). Free when expired or when the holder's instance is dead.
-- * Rate windows: the fixed-window counters every replica shares. UNLOGGED: a crash loses them, which (as a
--   restart did before) only lets a little more through.
-- * The AgentKarma snapshot the leader pulls, so followers serve it without calling AgentKarma themselves.
-- * The last provision start outcome per agent (the status endpoint read it from one process's memory).
-- Re-runnable.

CREATE SEQUENCE IF NOT EXISTS app.api_instance_seq AS integer MINVALUE 1 MAXVALUE 2147483647 CYCLE;

-- 'AEC4' = 0x41454334 = 1095058228. Must match INSTANCE_CLASS in apps/api/src/db/replica.ts.
CREATE OR REPLACE FUNCTION app.instance_alive(instance integer) RETURNS boolean
LANGUAGE sql STABLE AS $$
  SELECT instance IS NOT NULL AND EXISTS (
    SELECT 1 FROM pg_locks
    WHERE locktype = 'advisory' AND classid::int8 = 1095058228 AND objid::int8 = instance AND objsubid = 2 AND granted
      AND database = (SELECT oid FROM pg_database WHERE datname = current_database()))
$$;

ALTER TABLE app.runs ADD COLUMN IF NOT EXISTS instance integer;
ALTER TABLE app.spend ADD COLUMN IF NOT EXISTS instance integer;
ALTER TABLE app.sign_requests ADD COLUMN IF NOT EXISTS instance integer;
ALTER TABLE app.agents ADD COLUMN IF NOT EXISTS provision_instance integer;

CREATE TABLE IF NOT EXISTS app.leases (
  key text PRIMARY KEY CONSTRAINT leases_key_check CHECK (char_length(key) BETWEEN 1 AND 200),
  instance integer NOT NULL,
  token uuid NOT NULL,
  until timestamptz NOT NULL
);

CREATE UNLOGGED TABLE IF NOT EXISTS app.rate_windows (
  key text PRIMARY KEY CONSTRAINT rate_windows_key_check CHECK (char_length(key) BETWEEN 1 AND 300),
  started timestamptz NOT NULL,
  count integer NOT NULL
);
CREATE INDEX IF NOT EXISTS rate_windows_started_idx ON app.rate_windows (started);

CREATE TABLE IF NOT EXISTS app.karma_snapshot (
  id smallint PRIMARY KEY CONSTRAINT karma_snapshot_one CHECK (id = 1),
  taken_at timestamptz NOT NULL,
  facts jsonb NOT NULL
);

CREATE TABLE IF NOT EXISTS app.provision_starts (
  agent_id uuid PRIMARY KEY REFERENCES app.agents (id) ON DELETE CASCADE,
  outcome jsonb NOT NULL,
  no_agent_streak integer NOT NULL DEFAULT 0,
  at timestamptz NOT NULL DEFAULT now()
);

-- 0020's default privileges cover new tables when the same role migrates; granted explicitly so a run as another role
-- still leaves the api able to use them.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'agentenact_api') THEN
    GRANT SELECT, INSERT, UPDATE, DELETE ON app.leases, app.rate_windows, app.karma_snapshot, app.provision_starts TO agentenact_api;
    GRANT USAGE, SELECT, UPDATE ON SEQUENCE app.api_instance_seq TO agentenact_api;
    GRANT EXECUTE ON FUNCTION app.instance_alive(integer) TO agentenact_api;
  END IF;
END $$;
