-- agentenact-cloud access tokens: how an owner's MCP harness (Claude Code, Codex, Hermes) reaches the owner MCP server
-- at POST /mcp. The panel's own sign-in is a short-lived Supabase JWT that a harness cannot keep; a token is made in the
-- panel, shown once, and only its sha256 is stored here. It acts for its user on that user's own agents only, through
-- the owner MCP tools (never the panel routes). Revoked or expired rows stay for the audit trail.
-- Additive and re-runnable: safe to apply before the code that needs it ships.
-- Applied on servel with: servel infra sql @agentenact-supabase --service db ./migrations --track
CREATE TABLE IF NOT EXISTS app.access_tokens (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id       uuid NOT NULL REFERENCES app.users(id),
  name          text NOT NULL CHECK (char_length(name) BETWEEN 1 AND 64),
  token_sha256  text NOT NULL UNIQUE CHECK (token_sha256 ~ '^[0-9a-f]{64}$'),
  -- The first characters of the token, shown in the panel so the owner can tell tokens apart. Never enough to use one.
  hint          text NOT NULL CHECK (char_length(hint) BETWEEN 4 AND 16),
  created_at    timestamptz NOT NULL DEFAULT now(),
  expires_at    timestamptz NOT NULL,
  last_used_at  timestamptz,
  revoked_at    timestamptz,
  CHECK (expires_at > created_at)
);
CREATE INDEX IF NOT EXISTS access_tokens_by_user ON app.access_tokens (user_id, created_at DESC);

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'agentenact_api') THEN
    GRANT SELECT, INSERT, UPDATE ON app.access_tokens TO agentenact_api;
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'postgres') AND current_user <> 'postgres' THEN
    GRANT SELECT, INSERT, UPDATE, DELETE ON app.access_tokens TO postgres;
  END IF;
END $$;
