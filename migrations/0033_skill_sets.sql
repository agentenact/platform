-- agentenact-cloud skill sets (Kerem, 2026-10-30: "skill'ler set olarak profile tanimlanabilir"): named bundles of
-- skills from skills.sh on the owner's account, applied to an agent in one step (on create or later).
-- app.skill_set_items: one pinned skill per row, exactly as the owner approved it when adding it to the set: the GitHub
-- commit (`pin`), agentenact/skills' content hash of the files reviewed, the audits and findings shown, the owner's
-- "I have read the checks" for a blocked or unaudited one, and the instructions read at that commit. Applying a set
-- copies these into the agent like a one-by-one approval (app.skill_approvals); nothing is read from the network then.
-- `revision` grows on every change to a set's skills. app.agent_skill_sets remembers which revision an agent last
-- took, so a changed set is shown as changed and never reaches an agent until the owner applies it again.
-- Deleting a set leaves the agents' skills as they are. Additive and re-runnable: safe to apply before the code ships.
-- Applied on servel with: servel infra sql @agentenact-supabase --service db ./migrations --track
CREATE TABLE IF NOT EXISTS app.skill_sets (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id     uuid NOT NULL REFERENCES app.users(id),
  name        text NOT NULL CHECK (char_length(name) BETWEEN 1 AND 60),
  revision    int NOT NULL DEFAULT 1 CHECK (revision >= 1),
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now(),
  UNIQUE (user_id, name)
);
CREATE INDEX IF NOT EXISTS skill_sets_by_user ON app.skill_sets (user_id, created_at);

CREATE TABLE IF NOT EXISTS app.skill_set_items (
  set_id        uuid NOT NULL REFERENCES app.skill_sets(id) ON DELETE CASCADE,
  name          text NOT NULL CHECK (name ~ '^[a-z0-9][a-z0-9-]{0,63}$'),
  skill_id      text NOT NULL CHECK (char_length(skill_id) BETWEEN 3 AND 256),
  content_hash  text NOT NULL CHECK (content_hash ~ '^[0-9a-f]{64}$'),
  pin           jsonb NOT NULL,
  verdict       text NOT NULL CHECK (verdict IN ('clear', 'caution', 'blocked', 'unaudited')),
  audits        jsonb NOT NULL DEFAULT '[]',
  findings      text[] NOT NULL DEFAULT '{}',
  accept_risk   boolean NOT NULL DEFAULT false,
  description   text NOT NULL CHECK (char_length(description) BETWEEN 1 AND 500),
  body          text NOT NULL CHECK (char_length(body) BETWEEN 1 AND 20000),
  added_at      timestamptz NOT NULL,
  PRIMARY KEY (set_id, skill_id),
  UNIQUE (set_id, name),
  CONSTRAINT skill_set_items_risk CHECK (verdict IN ('clear', 'caution') OR accept_risk)
);

CREATE TABLE IF NOT EXISTS app.agent_skill_sets (
  agent_id    uuid NOT NULL REFERENCES app.agents(id),
  set_id      uuid NOT NULL REFERENCES app.skill_sets(id) ON DELETE CASCADE,
  revision    int NOT NULL,
  applied_at  timestamptz NOT NULL,
  PRIMARY KEY (agent_id, set_id)
);

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'agentenact_api') THEN
    GRANT SELECT, INSERT, UPDATE, DELETE ON app.skill_sets, app.skill_set_items, app.agent_skill_sets TO agentenact_api;
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'postgres') AND current_user <> 'postgres' THEN
    GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA app TO postgres;
  END IF;
END $$;
