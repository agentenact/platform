-- Community templates: an open index of `agentenact.template/1` documents anyone can push (library `agentenact/community`).
-- A row holds the signed document as submitted after the api verified it (format, author signature, optional agent identity,
-- the Builder's draft checks and scope) and found its sha256 anchored on the author's own Stellar account (manage_data
-- `ae.tpl:<slug>`). Nothing here is secret and nothing here is the source of truth: the documents and the anchors are, so
-- the index can be rebuilt by anyone. Hiding a template only removes it from this index.
-- Applied on servel with: servel infra sql @agentenact-supabase --service db ./migrations --track

CREATE TABLE IF NOT EXISTS discovery.community_templates (
  sha256          text PRIMARY KEY CHECK (sha256 ~ '^[0-9a-f]{64}$'),
  network         text NOT NULL,
  author          text NOT NULL,
  slug            text NOT NULL,
  version         int NOT NULL CHECK (version >= 1),
  agent_id        int,
  -- the author's signed handle in this document, if any (library AUTHOR_NAME); shown beside the address, never alone
  author_name     text,
  title           text NOT NULL,
  summary         text NOT NULL,
  kind            text NOT NULL,
  document        jsonb NOT NULL,
  -- anchored: the author's account holds this hash now. superseded: it holds another (a newer version, usually) or none.
  anchor          text NOT NULL CHECK (anchor IN ('anchored', 'superseded')),
  anchor_checked_at timestamptz NOT NULL DEFAULT now(),
  -- listed, or hidden by reports (auto) or an operator. Only an operator un-hides.
  status          text NOT NULL DEFAULT 'listed' CHECK (status IN ('listed', 'hidden')),
  hidden_reason   text,
  reports         int NOT NULL DEFAULT 0,
  received_at     timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS community_templates_listed ON discovery.community_templates (received_at DESC) WHERE status = 'listed' AND anchor = 'anchored';
CREATE INDEX IF NOT EXISTS community_templates_author_slug ON discovery.community_templates (network, author, slug);
CREATE INDEX IF NOT EXISTS community_templates_recheck ON discovery.community_templates (anchor_checked_at) WHERE anchor = 'anchored';

-- Handles in this index: one key per handle and one handle per key, first come. A key that signs a new handle renames
-- itself and frees the old one. Local to this index (another index may decide otherwise); the signature is the proof.
CREATE TABLE IF NOT EXISTS discovery.community_authors (
  network     text NOT NULL,
  address     text NOT NULL,
  name        text UNIQUE, -- null: the key dropped its handle; the row stays so issued_at still guards against replay
  -- The signed time of the claim that set this handle (a template's createdAt or a handle change's issuedAt, never later
  -- than when it arrived): only a newer claim may change it, so an old document or change cannot undo a later one.
  issued_at   timestamptz NOT NULL,
  updated_at  timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (network, address)
);

-- One report per template per reporter key (a keyed hash of the client address, never the address).
CREATE TABLE IF NOT EXISTS discovery.community_template_reports (
  sha256       text NOT NULL REFERENCES discovery.community_templates (sha256) ON DELETE CASCADE,
  reporter     text NOT NULL,
  reason       text NOT NULL CHECK (reason IN ('spam', 'harmful', 'broken', 'other')),
  reported_at  timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (sha256, reporter)
);

-- The api connects as agentenact_api (0020); default privileges cover these, granted here too so the order of applying does not matter.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'agentenact_api') THEN
    GRANT SELECT, INSERT, UPDATE, DELETE ON discovery.community_templates, discovery.community_authors, discovery.community_template_reports TO agentenact_api;
  END IF;
END $$;
