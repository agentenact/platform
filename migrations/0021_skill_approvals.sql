-- agentenact-cloud skills from skills.sh: what the owner approved, pinned. One row per skill the agent holds from
-- skills.sh; the skill's text itself lives in the spec (and app.skills) like any other skill. Hand-written skills have
-- no row. `content_hash` is agentenact/skills' hash of the exact files reviewed; `pin` names the GitHub commit they
-- were read at; `audits` and `findings` are what the owner was shown when approving; `body_sha256` is the sha256 of the
-- instructions copied into the description, so a later hand edit shows as "changed since approval". Deleted with the skill.
-- app.services.skills: the approved skills the owner picked for that paid service (names in the agent's skills). A paid
-- run gets their instructions and its Enactment Record (v0.2) lists them by skill_id and content_hash.
-- Additive and re-runnable: safe to apply before the code that needs it ships.
-- Applied on servel with: servel infra sql @agentenact-supabase --service db ./migrations --track
CREATE TABLE IF NOT EXISTS app.skill_approvals (
  agent_id      uuid NOT NULL REFERENCES app.agents(id),
  name          text NOT NULL,
  skill_id      text NOT NULL CHECK (char_length(skill_id) BETWEEN 3 AND 256),
  content_hash  text NOT NULL CHECK (content_hash ~ '^[0-9a-f]{64}$'),
  pin           jsonb NOT NULL,
  verdict       text NOT NULL CHECK (verdict IN ('clear', 'caution', 'blocked', 'unaudited')),
  audits        jsonb NOT NULL DEFAULT '[]',
  findings      text[] NOT NULL DEFAULT '{}',
  body_sha256   text NOT NULL CHECK (body_sha256 ~ '^[0-9a-f]{64}$'),
  approved_by   uuid NOT NULL REFERENCES app.users(id),
  approved_at   timestamptz NOT NULL,
  spec_version  int NOT NULL,
  PRIMARY KEY (agent_id, name),
  UNIQUE (agent_id, skill_id)
);

ALTER TABLE app.services ADD COLUMN IF NOT EXISTS skills text[] NOT NULL DEFAULT '{}';

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'postgres') AND current_user <> 'postgres' THEN
    GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA app TO postgres;
  END IF;
END $$;
