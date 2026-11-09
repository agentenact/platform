-- agentenact-cloud (0046): the owner can archive a chat (hidden from the open tabs, words kept) and delete one.
-- A chat with no seal is removed outright. A chat with any seal is soft-deleted: deleted_at set, its words emptied and its
-- title nulled (the same as the 30-day purge of a deleted agent, agents/close.ts), while the session row, each turn's leaf
-- and every app.check_seals row stay, so what went on chain can still be checked by whoever kept the words.
-- Additive: apply BEFORE the api that reads it. Re-runnable.
-- Applied on servel with: servel infra sql @agentenact-supabase --service db ./migrations --track

ALTER TABLE app.chat_sessions ADD COLUMN IF NOT EXISTS archived_at timestamptz;
ALTER TABLE app.chat_sessions ADD COLUMN IF NOT EXISTS deleted_at timestamptz;

-- The owner's tabs (open) and the Archived list; a soft-deleted chat is in neither.
CREATE INDEX IF NOT EXISTS chat_sessions_shown ON app.chat_sessions (agent_id, user_id, updated_at DESC) WHERE deleted_at IS NULL;
