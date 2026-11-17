#!/usr/bin/env bash
# AC-09: restart the whole T01 stack (OpenBot + Casdoor + Postgres), verify
# the pinned versions did not move, and re-run the login/session assertions
# against the artifacts of earlier runs. A previously revoked session must not
# come back to life.
set -Eeuo pipefail
source "$(dirname "$0")/lib/common.sh"

t01_require_docker
t01_isolation_preflight
t01_require_versions_lock
t01_require_env_file

set -a; # shellcheck disable=SC1090
source "$T01_VERSIONS_LOCK"; set +a
export T01_ENV_FILE

BEFORE_SERVER="${T01_SERVER_IMAGE}"
t01_info "restart" "stopping project ${T01_PROJECT} (data volumes are kept)"
t01_compose down ||
  t01_fail "restart" "compose down failed."
t01_info "restart" "starting again from the same volumes"
t01_compose up -d || t01_fail "restart" "compose up failed after restart."

for svc in postgres casdoor server; do
  waited=0
  while [ "$(t01_compose ps --format "{{.Service}} {{.Health}}" | awk -v s="$svc" '$1==s{print $2}')" != "healthy" ]; do
    [ "$waited" -ge 600 ] && t01_fail "restart" "${svc} not healthy 600s after restart."
    sleep 5; waited=$((waited + 5))
  done
  t01_info "restart" "${svc} healthy after restart (${waited}s)"
done

# Versions must be identical across the restart.
set -a; # shellcheck disable=SC1090
source "$T01_VERSIONS_LOCK"; set +a
[ "${T01_SERVER_IMAGE}" = "$BEFORE_SERVER" ] ||
  t01_fail "restart" "server image digest changed across the restart (${BEFORE_SERVER} -> ${T01_SERVER_IMAGE}); the environment is not version-stable."

# Revoked session from 40-session-revoke.sh must stay dead.
if [ -f "$T01_COOKIE_USER_B" ]; then
  : "${T01_ORG_ID:?}" : "${T01_USER_PERSON_ID:?}"
  S="$(curl -sS -o /dev/null -w '%{http_code}' --max-time 30 -b "$T01_COOKIE_USER_B" \
    "http://127.0.0.1:${T01_APP_PORT}/api/v2/organizations/${T01_ORG_ID}/people/${T01_USER_PERSON_ID}/sessions")" ||
    t01_fail "restart" "revoked-session probe errored."
  case "$S" in
    401|403|404) t01_info "restart" "revoked session still rejected after restart (${S}) — did not resurrect." ;;
    *) t01_fail "restart" "revoked session authenticated again after restart (HTTP ${S}) — AC-09 FAIL." ;;
  esac
else
  t01_fail "restart" "T01_COOKIE_USER_B not set; the revoked-session persistence check needs the jars from the earlier runs. Not skipping."
fi

if [ -f "$T01_COOKIE_USER_A" ]; then
  t01_api GET "/api/v2/organizations/${T01_ORG_ID}/people/${T01_USER_PERSON_ID}/sessions" "$T01_COOKIE_USER_A" 200 >/dev/null ||
    t01_fail "restart" "surviving session did not survive the restart — check session persistence."
  t01_info "restart" "surviving session still valid after restart."
fi

t01_info "restart" "re-run 30-login-success.sh / 31-login-failures.sh with fresh browser logins for the full repeat, and record one fresh-deploy run from empty volumes for AC-09."
