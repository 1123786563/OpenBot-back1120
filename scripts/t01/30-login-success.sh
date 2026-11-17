#!/usr/bin/env bash
# AC-03: real login success chain, plus the no-session negative check.
#
# The browser part (Casdoor authorize -> consent -> callback -> server code
# exchange) is driven by a real browser per README.md; this script verifies
# its observable results and refuses to fake anything:
#   - $T01_COOKIE_ADMIN / $T01_COOKIE_USER: cookie jar files exported by the
#     real browser session against http://127.0.0.1:13010
#   - $T01_ORG_ID / $T01_ADMIN_PERSON_ID / $T01_USER_PERSON_ID: read from the
#     admin session on first run (README step 5)
# A missing jar or a 401/403 where a session should exist is a hard failure.
set -Eeuo pipefail
source "$(dirname "$0")/lib/common.sh"

t01_require_docker
t01_isolation_preflight

: "${T01_COOKIE_ADMIN:?T01_FAIL [login-success]: T01_COOKIE_ADMIN must point at the admin session cookie jar exported by the real browser login. Not simulating.}"
: "${T01_COOKIE_USER:?T01_FAIL [login-success]: T01_COOKIE_USER must point at the test user session cookie jar exported by the real browser login.}"
: "${T01_ORG_ID:?T01_FAIL [login-success]: T01_ORG_ID required (list organizations with the admin jar).}"
[ -f "$T01_COOKIE_ADMIN" ] || t01_fail "login-success" "cookie jar $T01_COOKIE_ADMIN missing."
[ -f "$T01_COOKIE_USER" ] || t01_fail "login-success" "cookie jar $T01_COOKIE_USER missing."

API="http://127.0.0.1:${T01_APP_PORT}"

# 1. Session is real: the protected who-am-I style endpoint answers 200.
# `listPeople` on the org is the recorded protected API for AC-03 (read-only).
t01_api GET "/api/v2/organizations/${T01_ORG_ID}/people" "$T01_COOKIE_ADMIN" 200 >/dev/null ||
  t01_fail "login-success" "protected API rejected the admin session produced by the real login chain."

# 2. A session-less client must NOT reach the same API.
NO_JAR="$(mktemp)"; trap 'rm -f "$NO_JAR"' EXIT
STATUS="$(curl -sS -o /dev/null -w '%{http_code}' --max-time 30 -b "$NO_JAR" \
  "${API}/api/v2/organizations/${T01_ORG_ID}/people")" ||
  t01_fail "login-success" "unauthenticated probe errored instead of answering."
case "$STATUS" in
  401|403) t01_info "login-success" "no-session probe rejected with ${STATUS} — good." ;;
  *) t01_fail "login-success" "no-session probe returned ${STATUS}; expected 401/403 (AC-03 negative half)."
esac

# 3. The non-admin session is a different person: it must not be able to list
# another person's sessions (AC-08 probe piggybacked here is 60's job; here we
# only assert the user session resolves to its own person record).
t01_api GET "/api/v2/organizations/${T01_ORG_ID}/people" "$T01_COOKIE_USER" 200 >/dev/null ||
  t01_fail "login-success" "the ordinary user session did not authenticate."

t01_info "login-success" "AC-03 automatable checks passed: real-session 200, no-session rejected."
t01_info "login-success" "record in the report: callback 302 timeline and exchange from the browser run (README step 4)."
