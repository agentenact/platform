-- agentenact-cloud api role: the api stops connecting as postgres. On servel's Supabase (PG 15) postgres is a member of
-- pg_read_all_data and has CREATEROLE, so whatever 0018 revoked, postgres reads keyvault.keys and can reset
-- agentenact_vault's password. The api gets agentenact_api instead: the data it works on (schemas app and discovery)
-- and nothing else. No keyvault, no predefined roles, no CREATEROLE, no BYPASSRLS, no membership in other roles.
-- Applied on servel with: servel infra sql @agentenact-supabase --service db ./migrations --track
-- The role is NOLOGIN here; a human sets LOGIN PASSWORD out of band (as for agentenact_vault, 0018) and gives the api
-- DATABASE_URL=postgres://agentenact_api:<password>@db:5432/postgres, which wins over the linked postgres URL.
-- Re-runnable.

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'agentenact_api') THEN
    CREATE ROLE agentenact_api NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOBYPASSRLS NOREPLICATION;
    -- lets the migrating role (and the tests) SET ROLE to it, as in 0007. The reverse is never granted.
    EXECUTE format('GRANT agentenact_api TO %I', current_user);
  END IF;
END $$;
-- Checked, not ALTERed: servel migrates as postgres, which lacks SUPERUSER, and only a superuser may name the
-- SUPERUSER, REPLICATION or BYPASSRLS attributes in ALTER ROLE, even to turn them off.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'agentenact_api'
             AND (rolsuper OR rolcreatedb OR rolcreaterole OR rolbypassrls OR rolreplication)) THEN
    RAISE EXCEPTION '0020: agentenact_api holds a role attribute it must not have';
  END IF;
END $$;

-- What the api reads and writes today. Tables created by later migrations get the same through default privileges.
GRANT USAGE ON SCHEMA app, discovery TO agentenact_api;
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA app, discovery TO agentenact_api;
GRANT USAGE, SELECT, UPDATE ON ALL SEQUENCES IN SCHEMA app, discovery TO agentenact_api;
GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA app, discovery TO agentenact_api;
DO $$
BEGIN
  EXECUTE format('ALTER DEFAULT PRIVILEGES FOR ROLE %I IN SCHEMA app, discovery GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO agentenact_api', current_user);
  EXECUTE format('ALTER DEFAULT PRIVILEGES FOR ROLE %I IN SCHEMA app, discovery GRANT USAGE, SELECT, UPDATE ON SEQUENCES TO agentenact_api', current_user);
  EXECUTE format('ALTER DEFAULT PRIVILEGES FOR ROLE %I IN SCHEMA app, discovery GRANT EXECUTE ON FUNCTIONS TO agentenact_api', current_user);
END $$;

-- Nothing of the vault's: no grant (0018's revoke loop covers stray ones), no membership, no route through a
-- predefined role. Checked here so a drift fails the migration instead of passing silently.
DO $$
DECLARE
  r record;
BEGIN
  FOR r IN SELECT pg_get_userbyid(m.roleid) AS role FROM pg_auth_members m WHERE m.member = 'agentenact_api'::regrole LOOP
    EXECUTE format('REVOKE %I FROM agentenact_api', r.role);
  END LOOP;
  IF has_schema_privilege('agentenact_api', 'keyvault', 'USAGE')
     OR has_table_privilege('agentenact_api', 'keyvault.keys', 'SELECT')
     OR pg_has_role('agentenact_api', 'agentenact_vault', 'MEMBER') THEN
    RAISE EXCEPTION '0020: agentenact_api reaches keyvault';
  END IF;
END $$;
