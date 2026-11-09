-- A bind request names the register tx the platform submitted, so the owner's browser can find the
-- registry id on chain. A pointer only: the browser verifies that tx itself. Public data (a tx hash).
ALTER TABLE app.sign_requests
  ADD COLUMN register_tx text CHECK (register_tx IS NULL OR register_tx ~ '^[0-9a-f]{64}$');
