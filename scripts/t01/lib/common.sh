#!/usr/bin/env bash
# Shared prerequisites for the T01 isolated Casdoor integration environment.
#
# Rule for every script under scripts/t01/: a missing dependency fails LOUDLY
# with a non-zero exit code. Nothing here skips silently and reports success.
#
# These scripts have NOT been executed yet (see implementation.md): the node
# environment had no container runtime, so every t01 script currently fails at
# the docker prerequisite by design until first run on a Docker host.

set -Eeuo pipefail

T01_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
T01_PROJECT="openbot-t01"
T01_COMPOSE_FILE="$T01_DIR/compose.t01.yml"
T01_ENV_FILE="$T01_DIR/.env.t01"            # runtime-only, never committed
T01_ENV_EXAMPLE="$T01_DIR/.env.t01.example" # committed, no secret values
T01_VERSIONS_LOCK="$T01_DIR/versions.lock"  # written by 00-pin-images.sh

# Loopback host ports, deliberately off the defaults used by docker-compose.yml
# (3010/3001/8000) and docker-compose.casdoor.yml, so a T01 stack cannot collide
# with an existing local deployment.
T01_CASDOOR_PORT="${T01_CASDOOR_PORT:-18000}"
T01_APP_PORT="${T01_APP_PORT:-13010}"
T01_SERVER_PORT="${T01_SERVER_PORT:-13001}"

t01_fail() {
  echo "T01 FAIL [$1]: $2" >&2
  exit 1
}

t01_info() {
  echo "T01 [$1] $2"
}

t01_require_docker() {
  command -v docker >/dev/null 2>&1 ||
    t01_fail "prereq" "docker CLI not found on PATH. The T01 environment is a real container deployment; install Docker and re-run. Not skipping."
  docker compose version >/dev/null 2>&1 ||
    t01_fail "prereq" "'docker compose' v2 plugin unavailable. Install the compose plugin and re-run."
  docker info >/dev/null 2>&1 ||
    t01_fail "prereq" "docker daemon unreachable (is the engine running?). Not continuing without a working runtime."
}

# The stack must never touch an existing deployment: project name, volumes and
# ports are all T01-specific. Assert that before anything starts.
t01_isolation_preflight() {
  local port
  for port in "$T01_CASDOOR_PORT" "$T01_APP_PORT" "$T01_SERVER_PORT"; do
    if command -v ss >/dev/null 2>&1 && ss -ltn 2>/dev/null | grep -q "127.0.0.1:${port} "; then
      t01_fail "isolation" "loopback port ${port} is already in use; T01 requires 127.0.0.1:${T01_CASDOOR_PORT}/${T01_APP_PORT}/${T01_SERVER_PORT} free so it cannot collide with an existing deployment."
    fi
  done
  if docker volume ls --format '{{.Name}}' 2>/dev/null | grep -Eq '^openbot-t01_'; then
    t01_info "isolation" "found existing openbot-t01_* volumes; they belong to this ticket and will be reused only by 10-up.sh, never by another project."
  fi
  # Refuse to run if a *different* compose project already publishes our ports.
  local published
  published="$(docker ps --format '{{.Ports}}' 2>/dev/null || true)"
  if printf '%s' "$published" | grep -qE "127\.0\.0\.1:(${T01_CASDOOR_PORT}|${T01_APP_PORT}|${T01_SERVER_PORT})->"; then
    t01_fail "isolation" "another running container already publishes a T01 port; resolve that first, do not reuse it."
  fi
}

t01_require_env_file() {
  [ -f "$T01_ENV_FILE" ] ||
    t01_fail "config" "$T01_ENV_FILE not found. Copy $T01_ENV_EXAMPLE and fill every runtime value (secrets stay out of git). Generate: openssl rand -base64 32"
  local var
  for var in OPENBOT_EDITION DATABASE_URL KEY_ENCRYPTION_KEY BETTER_AUTH_SECRET BETTER_AUTH_URL INITIAL_ADMIN_EMAILS TRUSTED_ORIGINS T01_SERVER_IMAGE; do
    grep -Eq "^${var}=..*" "$T01_ENV_FILE" ||
      t01_fail "config" "$T01_ENV_FILE is missing or has an empty ${var}. See .env.t01.example."
  done
  # The example deployment key must never reach a running stack.
  grep -q "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=" "$T01_ENV_FILE" &&
    t01_fail "config" "$T01_ENV_FILE still carries the example KEY_ENCRYPTION_KEY; generate a real one (openssl rand -base64 32)."
  grep -Eq "^OPENBOT_EDITION=(personal|.*)$" "$T01_ENV_FILE" &&
    ! grep -Eq "^OPENBOT_EDITION=team$" "$T01_ENV_FILE" &&
    t01_fail "config" "OPENBOT_EDITION must be 'team' for T01: 'personal' refuses sign-in providers."
  return 0
}

t01_require_versions_lock() {
  [ -f "$T01_VERSIONS_LOCK" ] ||
    t01_fail "version" "$T01_VERSIONS_LOCK missing. Run scripts/t01/00-pin-images.sh first: a floating tag (backend-images.env default 'main') is not an acceptable version for T01."
  grep -q "^T01_SERVER_IMAGE=ghcr\.io/copilotkit/openbot@sha256:[0-9a-f]{64}$" "$T01_VERSIONS_LOCK" ||
    t01_fail "version" "versions.lock does not pin the server image by immutable sha256 digest. Re-run 00-pin-images.sh."
}

# All compose calls go through here so project/env/file cannot drift apart.
t01_compose() {
  docker compose \
    --project-name "$T01_PROJECT" \
    --env-file "$T01_ENV_FILE" \
    --file "$T01_COMPOSE_FILE" \
    "$@"
}

# Protected-API assertion helper used by 30/31/40/60.
# t01_api <method> <path> <cookie-jar-file> [expected-status]
t01_api() {
  local method="$1" path="$2" jar="$3" expected="${4:-}"
  local base status
  base="http://127.0.0.1:${T01_APP_PORT}"
  status="$(curl -sS -o /tmp/t01-api-body.$$ -w '%{http_code}' \
    --max-time 30 -X "$method" -b "$jar" -H 'accept: application/json' \
    "${base}${path}")" || t01_fail "api" "curl to ${path} failed"
  local body
  body="$(head -c 400 /tmp/t01-api-body.$$ || true)"
  rm -f /tmp/t01-api-body.$$
  if [ -n "$expected" ] && [ "$status" != "$expected" ]; then
    t01_fail "api" "${method} ${path} returned ${status}, expected ${expected}. Body: ${body}"
  fi
  echo "$body"
}
