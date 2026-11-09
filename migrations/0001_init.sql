-- agentenact-cloud P2: onboarding. Schema `app` is not exposed by Supabase PostgREST.
-- Applied on servel with: servel infra sql @agentenact-supabase --service db ./migrations --track
CREATE SCHEMA IF NOT EXISTS app;

-- Profile of a Supabase auth user (auth.users.id). No FK: tests run on plain Postgres.
CREATE TABLE app.users (
  id                            uuid PRIMARY KEY,
  email                         text NOT NULL,
  owner_address                 text UNIQUE,      -- passkey smart wallet C…
  passkey_credential_id         text UNIQUE,
  passkey_credential            jsonb,            -- smart-account-kit StoredCredential, publicKey base64url
  passkey_challenge             text,
  passkey_challenge_expires_at  timestamptz,
  passkey_claimed_at            timestamptz,      -- a wallet deploy for passkey_credential_id is in flight
  created_at                    timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE app.agents (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id          uuid NOT NULL REFERENCES app.users(id),
  name             text NOT NULL CHECK (char_length(name) BETWEEN 1 AND 64),
  stellar_address  text UNIQUE,                   -- the runtime key's G…
  agent_id         text,                          -- stellar-8004 registry id (u32)
  status           text NOT NULL DEFAULT 'provisioning'
                   CHECK (status IN ('draft', 'provisioning', 'active', 'revoked')),
  provision_state  jsonb NOT NULL DEFAULT '{"step": "pending", "attempts": []}',
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now()
);
-- Platform ceiling (spec §6): one agent per user.
CREATE UNIQUE INDEX agents_one_per_user ON app.agents (user_id) WHERE status <> 'revoked';

-- Encrypted agent keys. A retry after tx 1 rotates the key, so an agent can own several rows; one is live.
CREATE TABLE app.keys (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  agent_id      uuid NOT NULL REFERENCES app.agents(id),
  public_key    text NOT NULL,
  ciphertext    bytea NOT NULL,                  -- AES-256-GCM(seed) || tag
  nonce         bytea NOT NULL,
  key_version   int NOT NULL,
  created_at    timestamptz NOT NULL DEFAULT now(),
  destroyed_at  timestamptz
);
CREATE UNIQUE INDEX keys_one_live_per_agent ON app.keys (agent_id) WHERE destroyed_at IS NULL;

-- One owner auth entry waiting for the passkey. Spec §4 named these tx_xdr/signature; the owner signs entries.
CREATE TABLE app.sign_requests (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id             uuid NOT NULL REFERENCES app.users(id),
  agent_id            uuid NOT NULL REFERENCES app.agents(id),
  kind                text NOT NULL CHECK (kind IN ('register', 'bind')),
  entry_xdr           text NOT NULL,
  valid_until_ledger  int NOT NULL,
  network_passphrase  text NOT NULL,
  status              text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'signed', 'rejected', 'expired')),
  signed_entry_xdr    text,
  expires_at          timestamptz NOT NULL,
  created_at          timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX sign_requests_pending ON app.sign_requests (user_id) WHERE status = 'pending';

-- Supabase hardening: the anon key's roles never touch schema app. The api's own role gets access.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') THEN REVOKE ALL ON SCHEMA app FROM anon; END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN REVOKE ALL ON SCHEMA app FROM authenticated; END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'postgres') AND current_user <> 'postgres' THEN
    GRANT USAGE ON SCHEMA app TO postgres;
    GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA app TO postgres;
  END IF;
END $$;
