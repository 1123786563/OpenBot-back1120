#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/../.."
BUN="${T04_BUN:-bun}"
case "$("$BUN" --version)" in 1.4*) ;; *) printf '%s\n' "Bun 1.4.x required, got $("$BUN" --version)"; exit 1;; esac
test -f deploy/t04/.env.t04 || "$BUN" deploy/t04/setup.ts
if lsof -nP -iTCP:14003 -sTCP:LISTEN >/dev/null; then printf '%s\n' '14003 occupied; refusing to reuse a service'; exit 1; fi
docker-compose -p openbot-t04 --env-file deploy/t04/.env.t04 -f deploy/t04/docker-compose.t04.yml up -d --wait --wait-timeout 90 postgres casdoor-db casdoor mailpit
"$BUN" deploy/t04/run.ts provision
"$BUN" deploy/t04/run.ts migrate
"$BUN" deploy/t04/migrate-test.ts
"$BUN" run --filter app build
"$BUN" deploy/t04/run.ts start
"$BUN" deploy/t04/verify-listeners.ts
