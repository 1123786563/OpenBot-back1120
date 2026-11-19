#!/usr/bin/env bash
set -euo pipefail

cd "$(dirname "$0")/.."

export OPENBOT_E2E_SUITE="${OPENBOT_E2E_SUITE:-guest}"
export APP_PORT="${APP_PORT:-3010}"
export SERVER_PORT="${SERVER_PORT:-3001}"
export PORT="$SERVER_PORT"
export OPENBOT_WEB_URL="http://localhost:$APP_PORT"
export OPENBOT_SINGLE_USER=false
export OPENBOT_EDITION=team
export OPENBOT_LISTEN_HOSTNAME=127.0.0.1
export BETTER_AUTH_URL="$OPENBOT_WEB_URL"
export TRUSTED_ORIGINS="$OPENBOT_WEB_URL"
export KEY_ENCRYPTION_KEY="$(openssl rand -base64 32)"
export BETTER_AUTH_SECRET="$(openssl rand -hex 32)"
export OPENBOT_OTEL_EXPORT=off
export E2E_TELEMETRY_DISABLED=1
: "${DATABASE_URL:?Set DATABASE_URL to a disposable OpenBot test database}"

pids=()
cleanup() {
  for pid in ${pids[@]+"${pids[@]}"}; do
    kill "$pid" 2>/dev/null || true
  done
  wait || true
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM
wait_for() {
  local url="$1" pid="$2"
  for ((i = 0; i < 90; i++)); do
    kill -0 "$pid" 2>/dev/null || break
    if curl -fsS --max-time 2 "$url" >/dev/null 2>&1; then return; fi
    sleep 1
  done
  echo "Test service did not become ready at $url. See .e2e/services/." >&2
  return 1
}
mkdir -p .e2e/services

case "$OPENBOT_E2E_SUITE" in
  guest|navigation|personal)
    unset AUTH_MODE
    if [[ "$OPENBOT_E2E_SUITE" != "guest" ]]; then
      export OPENBOT_SINGLE_USER=true
      unset BETTER_AUTH_SECRET BETTER_AUTH_URL
    else
      export GOOGLE_OAUTH_CLIENT_ID=openbot-e2e-guest GOOGLE_OAUTH_CLIENT_SECRET=unused
      export INITIAL_ADMIN_EMAILS=admin@example.test
    fi
    if [[ "$OPENBOT_E2E_SUITE" == "personal" ]]; then
      export OPENBOT_EDITION=personal
      export AGENT_COMPUTER_URL=http://127.0.0.1:1
    fi
    export INTELLIGENCE_API_URL=http://127.0.0.1:1
    export INTELLIGENCE_GATEWAY_WS_URL=ws://127.0.0.1:1
    export CPK_INTELLIGENCE_API_KEY=openbot-e2e-guest
    ;;
  authenticated|live)
    : "${CASDOOR_OAUTH_ISSUER:?Set the test Casdoor issuer}"
    : "${CASDOOR_OAUTH_CLIENT_ID:?Set the test Casdoor client ID}"
    : "${CASDOOR_OAUTH_CLIENT_SECRET:?Set the test Casdoor client secret}"
    : "${OPENBOT_E2E_CASDOOR_USERNAME:?Set the test account username}"
    : "${OPENBOT_E2E_CASDOOR_PASSWORD:?Set the test account password}"
    : "${INTELLIGENCE_API_URL:?Set the test Intelligence HTTP URL}"
    : "${INTELLIGENCE_GATEWAY_WS_URL:?Set the test Intelligence WebSocket URL}"
    : "${CPK_INTELLIGENCE_API_KEY:?Set the test Intelligence project key}"
    export AUTH_MODE=casdoor
    if [[ "$OPENBOT_E2E_SUITE" == "live" ]]; then
      : "${OPENAI_API_KEY:?Set the live model key}"
    fi
    ;;
  *) echo "Unknown Chromium suite: $OPENBOT_E2E_SUITE" >&2; exit 2 ;;
esac

if [[ "$OPENBOT_E2E_SUITE" == "authenticated" ]]; then
  export OPENBOT_E2E_MODEL_PORT="${OPENBOT_E2E_MODEL_PORT:-3901}"
  export OPENAI_BASE_URL="http://127.0.0.1:$OPENBOT_E2E_MODEL_PORT/v1"
  export OPENAI_API_KEY=openbot-e2e-fixture COPILOTKIT_OPENAI_API=chat
  bun --no-env-file tests/e2e/mock-model.ts >.e2e/services/model.log 2>&1 &
  pids+=("$!")
  wait_for "$OPENAI_BASE_URL/models" "$!"
fi

(cd server && bun --no-env-file scripts/migrate.ts)
bun --no-env-file scripts/generate-app-config.ts
(cd server && exec bun --no-env-file src/index.ts) >.e2e/services/server.log 2>&1 &
pids+=("$!")
wait_for "http://127.0.0.1:$SERVER_PORT/health" "$!"
(cd app && exec bun --no-env-file --bun node_modules/vite/bin/vite.js --host 127.0.0.1) >.e2e/services/web.log 2>&1 &
pids+=("$!")
wait_for "$OPENBOT_WEB_URL/api/capabilities" "$!"
if [[ "$OPENBOT_E2E_SUITE" == "navigation" || "$OPENBOT_E2E_SUITE" == "personal" ]]; then
  curl -fsS -H 'Content-Type: application/json' --data '{"completed":true}' \
    "$OPENBOT_WEB_URL/api/me/onboarding" >/dev/null
fi
bun --no-env-file node_modules/e2e/dist/cli/bin.js run "$@"
