#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/../.."
BUN="${T02_BUN:-bun}"
test "$("$BUN" --version)" = 1.4.3 || { printf '%s\n' 'Bun 1.4.3 required'; exit 1; }
test -f deploy/t02/.env.t02 || "$BUN" deploy/t02/setup.ts
if lsof -nP -iTCP:14001 -sTCP:LISTEN >/dev/null; then printf '%s\n' '14001 occupied; refusing to reuse a service'; exit 1; fi
docker compose -p openbot-t02 --env-file deploy/t02/.env.t02 -f deploy/t02/docker-compose.t02.yml up -d --wait --wait-timeout 90 postgres casdoor-db casdoor mailpit
"$BUN" deploy/t02/run.ts provision
"$BUN" deploy/t02/run.ts migrate
"$BUN" deploy/t02/migrate-test.ts
"$BUN" run --filter app build
"$BUN" deploy/t02/run.ts start
"$BUN" deploy/t02/verify-listeners.ts
