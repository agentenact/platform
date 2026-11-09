#!/bin/sh
# Starts the api or the vault with an allowlisted environment (the indexer does the same, apps/indexer/entrypoint.sh).
#
# `infra: agentenact-supabase` in servel.yaml joins the container to the Supabase stack's network and, as a side effect,
# injects the stack's admin credentials: the postgres password (SUPABASE_DB_URL, SUPABASE_POSTGRES_PASSWORD), the JWT
# secret, the service-role key, the dashboard password. servel has no network-only link, and linked values win over
# secrets and servel.yaml env. So they are dropped here, before the process starts: code running inside it (an agent's
# tool, a dependency) cannot read what is not in its environment, and /proc/self/environ of the final process holds only
# the names below. An allowlist, not a denylist: it also drops whatever the link adds in future.
#
# The api connects as agentenact_api through API_DATABASE_URL (migration 0020), the vault as agentenact_vault through
# VAULT_DATABASE_URL (0018); neither gets a fallback to the linked postgres URL here.
#
# Usage: entrypoint.sh api|vault <command> [args...]      e.g.  entrypoint.sh api bun run src/main.ts
# Keep the lists in sync with every env read in src/ (tests/entrypoint.test.ts checks it) plus what the runtime needs.
set -eu

RUNTIME="PATH HOME TZ NODE_ENV SERVEL_GIT_COMMIT SERVEL_DEPLOY_TIME"
case "${1:-}" in
  api)
    ALLOW="$RUNTIME PORT APP_ORIGIN APP_ORIGINS RP_ID PUBLIC_BASE_URL SUPABASE_URL SUPABASE_ANON_KEY API_DATABASE_URL MAIL_FROM
           RUNTIME_KILL_SWITCH ISOLATE_POOL_SIZE FEE_MODEL PANEL_SECRET
           VAULT_URL VAULT_TOKEN SPONSOR_PUBLIC_KEY OPENROUTER_API_KEY ANTHROPIC_API_KEY
           TAVILY_API_KEY RESEND_API_KEY OZ_API_KEY GITHUB_TOKEN
           AGENT_LIMIT AGENT_CREATIONS_PER_DAY SPONSORED_STARTS_PER_DAY CHECK_SEALS TESTNET_CREDIT
           MODEL_BUILDER MODEL_BUILDER_ANON MODEL_RUN MODEL_CHEAP"
    ;;
  vault)
    ALLOW="$RUNTIME VAULT_PORT VAULT_DATABASE_URL VAULT_TOKEN KEYS_MASTER_SECRET SPONSOR_SECRET"
    ;;
  *)
    echo "entrypoint: first argument must be api or vault" >&2
    exit 64
    ;;
esac
shift

for v in $ALLOW; do
  if eval "[ \"\${$v+x}\" = x ]"; then
    eval "val=\${$v}"
    set -- "$v=$val" "$@"
  fi
done

exec env -i "$@"
