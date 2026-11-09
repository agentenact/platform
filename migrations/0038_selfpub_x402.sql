-- agentenact-cloud: "For hire" on Explore (Kerem, 2026-11-02). An agent can be hired when its registration document says it
-- takes x402 payments (ERC-8004 `x402support`, or the `x402` flag stellar-8004 agents publish) or it lists a service with
-- a price. The flag is read by the indexer from the same document as the name and services; nothing new is fetched.
-- Existing rows get their document parsed again (doc_hash cleared) so the flag fills in on the next selfpub ticks.
-- Additive: apply BEFORE the indexer and the api that read it. Re-runnable.
-- Applied on servel with: servel infra sql @agentenact-supabase --service db ./migrations --track

ALTER TABLE discovery.selfpub ADD COLUMN IF NOT EXISTS x402 boolean NOT NULL DEFAULT false;
UPDATE discovery.selfpub SET doc_hash = NULL WHERE doc_hash IS NOT NULL AND NOT x402;
