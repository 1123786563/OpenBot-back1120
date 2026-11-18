#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/../.."
BUN="${T03_BUN:-bun}"
case "$("$BUN" --version)" in 1.4*) ;; *) printf '%s\n' "Bun 1.4.x required, got $("$BUN" --version)"; exit 1;; esac
test -f deploy/t03/.env.t03 || "$BUN" deploy/t03/setup.ts
if lsof -nP -iTCP:14002 -sTCP:LISTEN >/dev/null; then printf '%s\n' '14002 occupied; refusing to reuse a service'; exit 1; fi
docker-compose -p openbot-t03 --env-file deploy/t03/.env.t03 -f deploy/t03/docker-compose.t03.yml up -d --wait --wait-timeout 90 postgres casdoor-db casdoor mailpit
"$BUN" deploy/t03/run.ts provision
"$BUN" deploy/t03/run.ts migrate
"$BUN" deploy/t03/migrate-test.ts
"$BUN" run --filter app build
"$BUN" deploy/t03/run.ts start
"$BUN" deploy/t03/verify-listeners.ts
