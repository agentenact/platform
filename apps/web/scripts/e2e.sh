#!/usr/bin/env bash
# Runs the opt-in browser e2e against the deployed panel. The Supabase service role key (needed to mint a sign-in link,
# since a test cannot read mail) is read from servel into this process's environment only: never printed, never written.
set -euo pipefail
cd "$(dirname "$0")/.."

SUPABASE_SERVICE_ROLE_KEY="$(servel infra vars agentenact-supabase --json --show-secrets 2>/dev/null \
  | bun -e 'const v = JSON.parse(await Bun.stdin.text()).variables?.SERVICE_ROLE_KEY; if (!v) process.exit(1); process.stdout.write(v)')" \
  || { echo "could not read SERVICE_ROLE_KEY from servel (agentenact-supabase)" >&2; exit 1; }
export SUPABASE_SERVICE_ROLE_KEY
AGENTENACT_E2E=1 exec bunx playwright test "$@"
