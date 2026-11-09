-- agentenact-cloud: each seal's transaction signature (the agent key's ed25519 signature, base64, exactly as Horizon and
-- stellar.expert show it), so /verify can find a seal from a pasted signature. Horizon has no lookup by signature.
-- New seals store it when sent; older ones are filled from Horizon a row at a time by the seal worker ('' = Horizon no
-- longer serves the transaction). Additive and re-runnable: safe to apply before the code that needs it ships.
-- Applied on servel with: servel infra sql @agentenact-supabase --service db ./migrations --track

ALTER TABLE app.check_seals ADD COLUMN IF NOT EXISTS signature text;

CREATE INDEX IF NOT EXISTS check_seals_signature_idx ON app.check_seals (signature) WHERE signature IS NOT NULL AND signature <> '';
