-- agentenact-cloud: prices on "For hire" cards (Kerem, 2026-11-02, "hizmet ucretlerini de listede yazabilir miyiz?"). An
-- external x402 agent may publish its service prices in a stellar-agent-services manifest named by its registration
-- document. `manifest`: the agent's document points at one, so the indexer reads it again every few minutes (prices
-- change without a new registration uri). x402 documents are parsed again (doc_hash cleared) to pick their manifests up.
-- Additive: apply with 0038, BEFORE the indexer that writes it. Re-runnable.
-- Applied on servel with: servel infra sql @agentenact-supabase --service db ./migrations --track

ALTER TABLE discovery.selfpub ADD COLUMN IF NOT EXISTS manifest boolean NOT NULL DEFAULT false;
UPDATE discovery.selfpub SET doc_hash = NULL WHERE doc_hash IS NOT NULL AND x402;
