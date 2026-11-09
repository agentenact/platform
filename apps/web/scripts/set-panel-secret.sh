#!/usr/bin/env bash
# One-time (or rotation): one random PANEL_SECRET, stored on BOTH the api and the web panel as a servel secret.
# The value is generated here and piped straight into servel; it is never printed, written to a file or put in chat.
# Run it yourself (Kerem) after both services exist; then restart both so they read it.
set -euo pipefail

secret="$(openssl rand -hex 32)"
trap 'unset secret' EXIT

for app in agentenact-api agentenact-web; do
  printf '%s' "$secret" | (cd /var/empty && servel secrets set "$app" PANEL_SECRET -)
  echo "PANEL_SECRET stored for $app"
done
echo "Restart both services (or redeploy) so they pick it up."
