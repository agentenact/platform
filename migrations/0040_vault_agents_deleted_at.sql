-- agentenact-cloud: the vault reads app.agents.deleted_at (Kerem, 2026-11-02). The testnet credit check in
-- src/keys/vault.ts signs only for a live agent (`a.deleted_at is null`), but 0018/0037 granted the vault role only the
-- columns it read before, so every credit failed inside the vault ("vault_failed"). Column grant only. Re-runnable.
-- Applied on servel with: servel infra sql @agentenact-supabase --service db ./migrations --track

GRANT SELECT (deleted_at) ON app.agents TO agentenact_vault;
