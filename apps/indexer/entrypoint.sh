#!/bin/sh
# Starts the indexer with an allowlisted environment.
#
# `infra: agentenact-supabase` in servel.yaml links the container to the Supabase stack and, as a side effect, injects the
# database superuser credentials into its environment. The indexer must connect only as discovery_indexer through
# INDEXER_DATABASE_URL, so those variables are dropped here, before the process starts: code running inside the indexer
# (a parsed chain string, a dependency) cannot read what is not in its environment, and /proc/self/environ of the final
# process holds only the names below. An allowlist, not a denylist: it also drops variables the link adds in future.
#
# Usage: entrypoint.sh <command> [args...]      e.g.  entrypoint.sh bun run src/main.ts
# Keep the list in sync with src/config.ts (the only reader of the environment) plus what the runtime itself needs.
set -eu

for v in PATH HOME TZ NODE_ENV PORT PUBLIC_BASE_URL INDEXER_DATABASE_URL INDEXER_SPONSORS INDEXER_HORIZON_RPS INDEXER_PAYMENTS_SOURCE INDEXER_AGENTKARMA_URL; do
  if eval "[ \"\${$v+x}\" = x ]"; then
    eval "val=\${$v}"
    set -- "$v=$val" "$@"
  fi
done

exec env -i "$@"
