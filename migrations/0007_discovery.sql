-- Discovery index (sub-project E). Mirrors stellar-8004 reads and verified records; nothing here is secret.
-- Applied on servel with: servel infra sql @agentenact-supabase --service db ./migrations --track
-- The role is NOLOGIN here; a human sets LOGIN PASSWORD out of band. It can never touch the app schema.

CREATE SCHEMA IF NOT EXISTS discovery;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'discovery_indexer') THEN
    CREATE ROLE discovery_indexer NOLOGIN;
    -- lets the migrating role (and the isolation test) SET ROLE to it. Plain GRANT works on PG15 and 16+.
    -- On PG16+ the creator's implicit grant is INHERIT FALSE; on PG15 membership inherits only if the member role has INHERIT,
    -- which is harmless: the indexer holds no privilege outside the discovery schema.
    EXECUTE format('GRANT discovery_indexer TO %I', current_user);
  END IF;
END $$;

CREATE TABLE discovery.meta (
  key   text PRIMARY KEY,
  value text NOT NULL
);

CREATE TABLE discovery.agents (
  agent_id          int PRIMARY KEY,
  owner             text NOT NULL,
  wallet            text,
  -- the wallet whose incoming USDC is polled: every non-null wallet, bound or not (decision 2026-10-12). Kept as a generated
  -- alias of wallet so the poller and its indexes keep one stable name.
  tracked_wallet    text GENERATED ALWAYS AS (wallet) STORED,
  uri               text NOT NULL DEFAULT '',
  registered_tx     text,
  registered_at     timestamptz,
  registered_ledger int,
  source            text NOT NULL CHECK (source IN ('event', 'registry_read')),
  builder           text NOT NULL DEFAULT 'external' CHECK (builder IN ('hosted', 'library', 'external')),
  hosted_uuid       uuid,
  first_seen_at     timestamptz NOT NULL DEFAULT now(),
  last_active_at    timestamptz,
  payments_cursor   text,
  next_poll_at      timestamptz NOT NULL DEFAULT now(),
  -- version of (owner, wallet, uri), bumped by the trigger below on any change to them. The registry refresh reads it
  -- before a chain read and writes only if it is unchanged, so it can never overwrite newer event data.
  updated_at        timestamptz NOT NULL DEFAULT clock_timestamp()
);
CREATE FUNCTION discovery.agents_touch() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  NEW.updated_at := clock_timestamp();
  RETURN NEW;
END $$;
CREATE TRIGGER agents_touch BEFORE UPDATE ON discovery.agents
  FOR EACH ROW WHEN (OLD.owner IS DISTINCT FROM NEW.owner OR OLD.wallet IS DISTINCT FROM NEW.wallet OR OLD.uri IS DISTINCT FROM NEW.uri)
  EXECUTE FUNCTION discovery.agents_touch();
CREATE INDEX agents_tracked_wallet ON discovery.agents (tracked_wallet);
CREATE INDEX agents_last_active ON discovery.agents (last_active_at DESC);

CREATE TABLE discovery.registry_events (
  event_id text PRIMARY KEY,
  agent_id int NOT NULL,
  kind     text NOT NULL CHECK (kind IN ('registered', 'uri_updated', 'wallet_bound', 'owner_changed')),
  tx_hash  text NOT NULL,
  ledger   int NOT NULL,
  at       timestamptz NOT NULL,
  -- a wallet_bound whose wallet equals the owner (the registration-time metadata_set): kept, but not activity (the wallet is still polled)
  inert    boolean NOT NULL DEFAULT false
);

CREATE TABLE discovery.payments (
  op_id           text NOT NULL,
  idx             int NOT NULL,
  agent_id        int NOT NULL,
  tx_hash         text NOT NULL,
  payer           text NOT NULL,
  payer_agent_id  int,
  payee           text NOT NULL,
  amount_units    bigint NOT NULL CHECK (amount_units > 0),
  asset           text NOT NULL,
  at              timestamptz NOT NULL,
  counted         boolean NOT NULL,
  excluded_reason text,
  PRIMARY KEY (op_id, idx)
);
CREATE INDEX payments_agent_time ON discovery.payments (agent_id, at DESC);
CREATE INDEX payments_tx ON discovery.payments (tx_hash);
CREATE INDEX payments_payer_agent ON discovery.payments (payer_agent_id, at);

CREATE TABLE discovery.proven_sales (
  settlement_ref text NOT NULL,
  agent_address  text NOT NULL,
  agent_id       int NOT NULL,
  digest         text NOT NULL UNIQUE,
  record         jsonb NOT NULL,
  source         text NOT NULL CHECK (source IN ('hosted', 'submitted')),
  payer          text NOT NULL,
  amount_units   bigint NOT NULL CHECK (amount_units > 0),
  asset          text NOT NULL,
  settled_at     timestamptz NOT NULL,
  verified_at    timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (settlement_ref, agent_address)
);
CREATE INDEX proven_sales_agent_time ON discovery.proven_sales (agent_id, settled_at DESC);

CREATE TABLE discovery.submissions (
  digest      text PRIMARY KEY,
  record      jsonb NOT NULL,
  received_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE discovery.record_attempts (
  digest      text PRIMARY KEY,
  tries       int NOT NULL DEFAULT 0,
  last_reason text,
  next_try_at timestamptz NOT NULL DEFAULT now(),
  final       boolean NOT NULL DEFAULT false
);

CREATE TABLE discovery.selfpub (
  agent_id    int PRIMARY KEY,
  name        text,
  description text,
  fetched_at  timestamptz NOT NULL,
  doc_hash    text
);

CREATE TABLE discovery.services (
  agent_id      int NOT NULL,
  slug          text NOT NULL,
  description   text,
  price_usdc    text,
  first_seen_at timestamptz NOT NULL,
  last_seen_at  timestamptz NOT NULL,
  PRIMARY KEY (agent_id, slug)
);

CREATE TABLE discovery.hidden (
  agent_id int PRIMARY KEY,
  reason   text,
  at       timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE discovery.feed (
  seq             bigserial PRIMARY KEY,
  kind            text NOT NULL CHECK (kind IN ('paid', 'registered', 'service_opened')),
  agent_id        int NOT NULL,
  other_agent_id  int,
  amount_units    bigint,
  label           text,
  tx_hash         text,
  at              timestamptz NOT NULL,
  self_published  boolean NOT NULL DEFAULT false,
  source_key      text NOT NULL UNIQUE
);
CREATE INDEX feed_time ON discovery.feed (at DESC);

CREATE VIEW discovery.activity (agent_id, kind, ref, at) AS
  SELECT agent_id, kind, tx_hash, at FROM discovery.registry_events WHERE NOT inert
  UNION ALL
  SELECT agent_id, 'received', tx_hash, at FROM discovery.payments WHERE counted
  UNION ALL
  SELECT payer_agent_id, 'sent', tx_hash, at FROM discovery.payments WHERE counted AND payer_agent_id IS NOT NULL
  UNION ALL
  SELECT agent_id, 'sale', settlement_ref, settled_at FROM discovery.proven_sales;

GRANT USAGE ON SCHEMA discovery TO discovery_indexer;
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA discovery TO discovery_indexer;
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA discovery TO discovery_indexer;
REVOKE ALL ON SCHEMA app FROM discovery_indexer;

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'postgres') AND current_user <> 'postgres' THEN
    GRANT ALL ON SCHEMA discovery TO postgres;
    GRANT ALL ON ALL TABLES IN SCHEMA discovery TO postgres;
    GRANT ALL ON ALL SEQUENCES IN SCHEMA discovery TO postgres;
  END IF;
END $$;
