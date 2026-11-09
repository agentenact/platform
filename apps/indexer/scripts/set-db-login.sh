#!/usr/bin/env bash
# One-time: give the discovery_indexer role a login and hand its connection URL to the indexer as a servel secret.
# The password is generated here, never printed, never written anywhere except a 0600 temp file that is removed at once.
# Run it yourself (Kerem); re-running rotates the password (then restart the indexer).
set -euo pipefail

pw="$(openssl rand -hex 24)"
# servel treats an argument as a file only when it ends in .sql, so the file lives in a private temp dir.
dir="$(mktemp -d -t indexer-login.XXXXXX)"
chmod 700 "$dir"
sql="$dir/login.sql"
trap 'rm -rf "$dir"; unset pw' EXIT

( umask 077; printf "ALTER ROLE discovery_indexer LOGIN PASSWORD '%s';\n" "$pw" > "$sql" )
(cd /var/empty && servel infra sql @agentenact-supabase --service db "$sql" >/dev/null)
echo "login set for discovery_indexer"

# Direct session connection on the Supabase stack network (never a pooler: the indexer's singleton lock lives on the session).
printf 'postgres://discovery_indexer:%s@db:5432/postgres' "$pw" \
  | (cd /var/empty && servel secrets set agentenact-indexer INDEXER_DATABASE_URL -)
echo "INDEXER_DATABASE_URL stored for agentenact-indexer"
