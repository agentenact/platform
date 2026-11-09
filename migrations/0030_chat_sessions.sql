-- agentenact-cloud (0030): owner chat conversations kept on the server (new chat, history) and sealed on chain (Kerem,
-- 2026-10-30: "yeni chat acilabiliyor mu ... butun bunlarin onchain olabilmesi lazim").
-- app.chat_sessions: one conversation of an owner with one agent. app.chat_turns: its turns, question and answer text
-- (owner-only, like app.memory) and the turn's canonical `ae.chat-turn/1` leaf (api src/seals/format.ts), whose
-- RFC 6962 Merkle root over the conversation goes on chain as an `ae.chat/1` seal (app.check_seals kind 'chat').
-- The owner may also have every message sealed on its own (app.agents.chat_seal_each, ON by default: Kerem 2026-10-30 "by default acik olsun"):
-- kind 'chat_turn', whose document is the turn's leaf itself.
-- sealed_turns: how many turns the newest queued chat seal covers; a conversation that goes on gets another seal.
-- Additive: apply BEFORE the api that writes it. Re-runnable.
-- Applied on servel with: servel infra sql @agentenact-supabase --service db ./migrations --track

CREATE TABLE IF NOT EXISTS app.chat_sessions (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  agent_id      uuid NOT NULL REFERENCES app.agents(id),
  user_id       uuid NOT NULL REFERENCES app.users(id),
  title         text CONSTRAINT chat_sessions_title_check CHECK (char_length(title) <= 80),
  turns         int NOT NULL DEFAULT 0 CONSTRAINT chat_sessions_turns_check CHECK (turns >= 0),
  sealed_turns  int NOT NULL DEFAULT 0 CONSTRAINT chat_sessions_sealed_check CHECK (sealed_turns >= 0 AND sealed_turns <= turns),
  -- The owner left it (a new chat): seal what it holds without waiting for it to go quiet.
  seal_due      boolean NOT NULL DEFAULT false,
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS chat_sessions_by_agent ON app.chat_sessions (agent_id, updated_at DESC);
CREATE INDEX IF NOT EXISTS chat_sessions_unsealed ON app.chat_sessions (updated_at) WHERE turns > sealed_turns;

CREATE TABLE IF NOT EXISTS app.chat_turns (
  session_id  uuid NOT NULL REFERENCES app.chat_sessions(id) ON DELETE CASCADE,
  seq         int NOT NULL CONSTRAINT chat_turns_seq_check CHECK (seq >= 1),
  at          timestamptz NOT NULL DEFAULT now(),
  run_id      uuid,
  status      text NOT NULL CONSTRAINT chat_turns_status_check CHECK (status ~ '^[a-z_]{1,20}$'),
  question    text NOT NULL CONSTRAINT chat_turns_question_check CHECK (char_length(question) <= 3000),
  answer      text NOT NULL DEFAULT '' CONSTRAINT chat_turns_answer_check CHECK (char_length(answer) <= 64000),
  leaf        text NOT NULL CONSTRAINT chat_turns_leaf_check CHECK (octet_length(leaf) <= 4096),
  PRIMARY KEY (session_id, seq)
);

-- check_seals takes the conversation seal: kind 'chat', with its conversation and how many turns its root covers.
ALTER TABLE app.check_seals ADD COLUMN IF NOT EXISTS session_id uuid REFERENCES app.chat_sessions(id);
ALTER TABLE app.check_seals ADD COLUMN IF NOT EXISTS turns int;
ALTER TABLE app.check_seals DROP CONSTRAINT IF EXISTS check_seals_kind_check;
ALTER TABLE app.check_seals ADD CONSTRAINT check_seals_kind_check CHECK (kind IN ('check', 'decision', 'chat', 'chat_turn'));
ALTER TABLE app.check_seals DROP CONSTRAINT IF EXISTS check_seals_chat_session;
-- chat: turns = how many turns the root covers; chat_turn: turns = the turn's seq.
ALTER TABLE app.check_seals ADD CONSTRAINT check_seals_chat_session CHECK ((kind IN ('chat', 'chat_turn')) = (session_id IS NOT NULL AND turns IS NOT NULL));
CREATE UNIQUE INDEX IF NOT EXISTS check_seals_one_per_chat_turns ON app.check_seals (kind, session_id, turns) WHERE session_id IS NOT NULL;

ALTER TABLE app.agents ADD COLUMN IF NOT EXISTS chat_seal_each boolean NOT NULL DEFAULT true;

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'agentenact_api') THEN
    GRANT SELECT, INSERT, UPDATE, DELETE ON app.chat_sessions, app.chat_turns TO agentenact_api;
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'postgres') AND current_user <> 'postgres' THEN
    GRANT SELECT, INSERT, UPDATE, DELETE ON app.chat_sessions, app.chat_turns TO postgres;
  END IF;
END $$;
