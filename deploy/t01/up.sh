#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/../.."
BUN="${T01_BUN:-$(npm exec --yes --package bun@1.4.3 -- sh -c 'command -v bun')}"
test "$("$BUN" --version)" = 1.4.3 || { printf '%s\n' 'Bun 1.4.3 required'; exit 1; }
extra="${T01_INTELLIGENCE_ENV:-$HOME/.agentflow-runner-t01/intelligence.env}"
test -r "$extra" || { printf '%s\n' 'Private Intelligence supplement is required'; exit 1; }
"$BUN" deploy/t01/check-supplement.ts "$extra"
"$BUN" --env-file=deploy/t01/.env.t01 --env-file="$extra" deploy/t01/check.ts
if lsof -nP -iTCP:13001 -sTCP:LISTEN >/dev/null; then printf '%s\n' '13001 occupied; refusing to reuse a service'; exit 1; fi
bash deploy/t01/deps.sh
"$BUN" install --frozen-lockfile
(cd server && "$BUN" --env-file=../deploy/t01/.env.t01 scripts/migrate.ts)
# The build sees the same selected configuration, not another deployment's ambient provider keys.
"$BUN" --env-file=deploy/t01/.env.t01 --env-file="$extra" deploy/t01/build.ts
"$BUN" --env-file=deploy/t01/.env.t01 --env-file="$extra" deploy/t01/launch.ts up
