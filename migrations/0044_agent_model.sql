-- agentenact-cloud: the model one agent runs on, picked by its owner on the agent page (Kerem, 2026-11-04: "agent
-- dashboarduna model degistirmeyi de ekleyelim"). An OpenRouter slug from the api's curated list (loop/model-choices.ts);
-- null = the platform default (MODEL_RUN). The api checks the list on write and again at run time, so a slug dropped from
-- the list later simply runs on the default. Additive for the running api: apply before it ships. Re-runnable.
-- Applied on servel with: servel infra sql @agentenact-supabase --service db ./migrations --track
ALTER TABLE app.agents ADD COLUMN IF NOT EXISTS model text;
