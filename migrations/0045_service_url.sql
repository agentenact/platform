-- agentenact-cloud: hire only what can really be called (Kerem, 2026-11-04: external agents showed on Hire with nothing to
-- hire). `url`: the https address a service says it answers at, from the agent's own registration document (`url` or
-- `endpoint`), kept only when it is https on 443 with a public-looking host name (no IP literal, no localhost). The
-- indexer's parser version moves to p3 with this column, so every document is read again and the column fills in.
-- Nothing new is fetched. Additive: apply BEFORE the indexer and the api that read it. Re-runnable.
-- Applied on servel with: servel infra sql @agentenact-supabase --service db ./migrations --track

ALTER TABLE discovery.services ADD COLUMN IF NOT EXISTS url text;
