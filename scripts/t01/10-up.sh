#!/usr/bin/env bash
# Start the isolated T01 stack from empty volumes and wait for health.
# Fresh deployment every time: t01-down.sh first if volumes already exist and
# a from-scratch run is wanted (AC-09 keeps a separate fresh-deploy record).
set -Eeuo pipefail
source "$(dirname "$0")/lib/common.sh"

t01_require_docker
t01_isolation_preflight
t01_require_versions_lock
t01_require_env_file

# Keep versions.lock values authoritative in the compose environment.
set -a
# shellcheck disable=SC1090
source "$T01_VERSIONS_LOCK"
set +a
export T01_ENV_FILE

t01_info "up" "starting project ${T01_PROJECT} (ports 127.0.0.1:${T01_CASDOOR_PORT}/:${T01_APP_PORT}/:${T01_SERVER_PORT})"
t01_compose up -d ||
  t01_fail "up" "compose up failed; run 'docker compose -p ${T01_PROJECT} logs' for the cause."

wait_healthy() { # service timeout-seconds
  local service="$1" timeout="$2" waited=0 state
  while true; do
    state="$(t01_compose ps --format '{{.Service}} {{.Health}}' | awk -v s="$service" '$1 == s {print $2}')"
    [ "$state" = "healthy" ] && { t01_info "up" "${service} healthy after ${waited}s"; return 0; }
    [ "$waited" -ge "$timeout" ] &&
      t01_fail "up" "${service} not healthy after ${timeout}s (state: ${state:-unknown}). Logs: docker compose -p ${T01_PROJECT} logs ${service}"
    sleep 5
    waited=$((waited + 5))
  done
}

wait_healthy postgres 120
wait_healthy casdoor 180
wait_healthy server 600

# Real liveness, not just the container's opinion.
curl -fsS --max-time 10 "http://127.0.0.1:${T01_CASDOOR_PORT}/.well-known/openid-configuration" >/dev/null ||
  t01_fail "up" "Casdoor discovery document not reachable at 127.0.0.1:${T01_CASDOOR_PORT}"
curl -fsS --max-time 10 -o /dev/null "http://127.0.0.1:${T01_APP_PORT}/" ||
  t01_fail "up" "OpenBot app not reachable at 127.0.0.1:${T01_APP_PORT}"

t01_info "up" "stack is up; proceed with the browser bootstrap in README.md, then 20-casdoor-app.sh"
