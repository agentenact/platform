-- agentenact-cloud: operator funds tracking (2026-11-06). Operator settings (alert thresholds, and vault limits that can
-- only tighten the code's own caps: apps/api/src/ops/settings.ts), hourly balance snapshots for the 24 h burn, and when each
-- low-balance alert was last emailed. The api writes all three; the vault only reads the settings.
-- Additive and re-runnable: safe to apply before the code that needs it ships.
-- Applied on servel with: servel infra sql @agentenact-supabase --service db ./migrations --track

CREATE TABLE IF NOT EXISTS app.ops_settings (
  key        text PRIMARY KEY CONSTRAINT ops_settings_key_check CHECK (key IN (
               'alert_email', 'alert_sponsor_xlm', 'alert_openrouter_usd',
               'vault_sponsor_day_fee_xlm', 'vault_credits_per_day', 'vault_credit_every_h', 'vault_agent_day_usdc', 'vault_seals_per_agent_day')),
  value      text NOT NULL CONSTRAINT ops_settings_value_check CHECK (char_length(value) <= 254),
  updated_at timestamptz NOT NULL DEFAULT now(),
  updated_by text NOT NULL
);

CREATE TABLE IF NOT EXISTS app.funds_snapshots (
  at             timestamptz PRIMARY KEY DEFAULT now(),
  sponsor_xlm    numeric(20, 7),
  openrouter_usd numeric(14, 6)
);

CREATE TABLE IF NOT EXISTS app.funds_alerts (
  kind    text PRIMARY KEY CONSTRAINT funds_alerts_kind_check CHECK (kind IN ('sponsor_xlm', 'openrouter_usd')),
  sent_at timestamptz NOT NULL DEFAULT now(),
  value   numeric(20, 7) NOT NULL
);

GRANT SELECT ON app.ops_settings TO agentenact_vault;

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'agentenact_api') THEN
    GRANT SELECT, INSERT, UPDATE, DELETE ON app.ops_settings, app.funds_snapshots, app.funds_alerts TO agentenact_api;
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'postgres') AND current_user <> 'postgres' THEN
    GRANT SELECT, INSERT, UPDATE, DELETE ON app.ops_settings, app.funds_snapshots, app.funds_alerts TO postgres;
  END IF;
END $$;
