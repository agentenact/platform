-- agentenact-cloud vault isolation: the vault's tables leave schema app for their own schema (keyvault: Supabase's own
-- Vault extension already owns a schema named vault), and the vault gets its own
-- database role. The api's role (postgres on servel) loses every privilege on them, so a taken-over api can neither read
-- the encrypted seeds nor rewrite the payment ledger the vault counts its caps from.
-- Applied on servel with: servel infra sql @agentenact-supabase --service db ./migrations --track
-- The role is NOLOGIN here; a human sets LOGIN PASSWORD out of band (as for discovery_indexer, 0007) and gives the vault
-- VAULT_DATABASE_URL. Deploy this together with the vault that reads keyvault.*: the vault before it reads app.keys.
-- Re-runnable.

CREATE SCHEMA IF NOT EXISTS keyvault;
REVOKE ALL ON SCHEMA keyvault FROM PUBLIC;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'agentenact_vault') THEN
    CREATE ROLE agentenact_vault NOLOGIN;
    -- lets the migrating role (and the isolation test) SET ROLE to it, as in 0007.
    EXECUTE format('GRANT agentenact_vault TO %I', current_user);
  END IF;
END $$;

-- SET SCHEMA carries the indexes, constraints and owned sequences along. The foreign key keys.agent_id → app.agents stays.
ALTER TABLE IF EXISTS app.keys SET SCHEMA keyvault;
ALTER TABLE IF EXISTS app.vault_signatures SET SCHEMA keyvault;
ALTER TABLE IF EXISTS keyvault.vault_signatures RENAME TO signatures;

-- Nobody but the owner and the vault role keeps a privilege on the vault's tables: the grants that schema app handed out
-- (postgres in 0016 and every migration's closing block, PUBLIC, any platform role) are taken back.
DO $$
DECLARE
  r record;
BEGIN
  FOR r IN SELECT DISTINCT grantee, table_name FROM information_schema.role_table_grants
           WHERE table_schema = 'keyvault' AND grantee NOT IN ('agentenact_vault', 'PUBLIC')
             AND grantee <> (SELECT tableowner FROM pg_tables WHERE schemaname = 'keyvault' AND tablename = table_name)
  LOOP
    EXECUTE format('REVOKE ALL ON keyvault.%I FROM %I', r.table_name, r.grantee);
  END LOOP;
  FOR r IN SELECT DISTINCT pg_get_userbyid(a.grantee) AS grantee
           FROM pg_namespace n, aclexplode(n.nspacl) a
           WHERE n.nspname = 'keyvault' AND a.grantee <> 0 AND a.grantee <> n.nspowner
             AND pg_get_userbyid(a.grantee) <> 'agentenact_vault'
  LOOP
    EXECUTE format('REVOKE ALL ON SCHEMA keyvault FROM %I', r.grantee);
  END LOOP;
  REVOKE ALL ON ALL TABLES IN SCHEMA keyvault FROM PUBLIC;
  REVOKE ALL ON ALL SEQUENCES IN SCHEMA keyvault FROM PUBLIC;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'postgres') AND current_user <> 'postgres' THEN
    REVOKE ALL ON ALL SEQUENCES IN SCHEMA keyvault FROM postgres;
  END IF;
END $$;

-- The vault: its keys (no delete: a destroyed key is wiped in place), its append-only ledger.
GRANT USAGE ON SCHEMA keyvault TO agentenact_vault;
GRANT SELECT, INSERT, UPDATE ON keyvault.keys TO agentenact_vault;
GRANT SELECT, INSERT ON keyvault.signatures TO agentenact_vault;
GRANT USAGE ON ALL SEQUENCES IN SCHEMA keyvault TO agentenact_vault;
-- What it checks before it signs: the agent's status and on-chain id, and its owner. Read-only, these columns only.
GRANT USAGE ON SCHEMA app TO agentenact_vault;
GRANT SELECT (id, user_id, status, agent_id) ON app.agents TO agentenact_vault;
GRANT SELECT (id, owner_address) ON app.users TO agentenact_vault;
