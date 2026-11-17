#!/usr/bin/env bash
# AC-06 (supported subset): revoke one of a user's own sessions via
# DELETE /api/v2/organizations/{org}/people/{person}/sessions/{sessionId}
# (api/openapi/accounts.yaml: only the person themselves may end their
# sessions). Two real sessions required; revoke one, prove the other survives.
#
# Admin-level "revoke ANY session" and a system-wide revoke-all do not exist
# in the supported API — that gap is disclosed, not simulated (see
# implementation.md).
set -Eeuo pipefail
source "$(dirname "$0")/lib/common.sh"

t01_require_docker
t01_isolation_preflight

: "${T01_COOKIE_USER_A:?T01_FAIL [session-revoke]: T01_COOKIE_USER_A = cookie jar of the test user's FIRST real browser session.}"
: "${T01_COOKIE_USER_B:?T01_FAIL [session-revoke]: T01_COOKIE_USER_B = cookie jar of the SAME user's SECOND real browser session.}"
: "${T01_ORG_ID:?T01_FAIL [session-revoke]: T01_ORG_ID required.}"
: "${T01_USER_PERSON_ID:?T01_FAIL [session-revoke]: T01_USER_PERSON_ID required.}"
[ -f "$T01_COOKIE_USER_A" ] && [ -f "$T01_COOKIE_USER_B" ] ||
  t01_fail "session-revoke" "both session cookie jars must exist; export them from two real browser logins. Not faking."

SESSIONS_JSON="$(t01_api GET "/api/v2/organizations/${T01_ORG_ID}/people/${T01_USER_PERSON_ID}/sessions" "$T01_COOKIE_USER_A" 200)" ||
  t01_fail "session-revoke" "could not list sessions on session A."

VICTIM_ID="$(printf '%s' "$SESSIONS_JSON" | node -e 'let d="";process.stdin.on("data",c=>d+=c).on("end",()=>{const o=JSON.parse(d);const s=(o.data||o.sessions||o.items||[]);const cur=s.find(x=>x.isCurrent);const other=s.find(x=>!x.isCurrent);console.log(process.argv[1]==="victim"?(cur||s[0]||{}).id:(other||s[1]||{}).id)})' "$1")" ||
  t01_fail "session-revoke" "could not parse the session list; expected >= 2 sessions."
[ -n "$VICTIM_ID" ] || t01_fail "session-revoke" "no session id to revoke; log in twice in a real browser first."

# Revoke the OTHER session from session A (revoking A itself would sign the
# caller out and prove nothing about "the other session survives").
t01_api DELETE "/api/v2/organizations/${T01_ORG_ID}/people/${T01_USER_PERSON_ID}/sessions/${VICTIM_ID}" "$T01_COOKIE_USER_A" 204 >/dev/null ||
  t01_fail "session-revoke" "DELETE of session ${VICTIM_ID} did not return 204."

REVOKE_TS="$(date -u +%Y-%m-%dT%H:%M:%SZ)"

# Revoked session must now be rejected.
STATUS_B="$(curl -sS -o /dev/null -w '%{http_code}' --max-time 30 \
  -b "$T01_COOKIE_USER_B" \
  "http://127.0.0.1:${T01_APP_PORT}/api/v2/organizations/${T01_ORG_ID}/people/${T01_USER_PERSON_ID}/sessions")" ||
  t01_fail "session-revoke" "post-revoke probe errored."
case "$STATUS_B" in
  401|403|404) t01_info "session-revoke" "revoked session rejected with ${STATUS_B} at ${REVOKE_TS} — good." ;;
  *) t01_fail "session-revoke" "revoked session still authenticated (HTTP ${STATUS_B}) — AC-06 FAIL." ;;
esac

# Session A must be untouched by the revocation.
t01_api GET "/api/v2/organizations/${T01_ORG_ID}/people/${T01_USER_PERSON_ID}/sessions" "$T01_COOKIE_USER_A" 200 >/dev/null ||
  t01_fail "session-revoke" "surviving session A was affected by revoking session B — AC-06 FAIL."

t01_info "session-revoke" "revoked ${VICTIM_ID} at ${REVOKE_TS}; A survived. Gap stands: no admin-level / system-wide revoke API."
echo "${REVOKE_TS} revoked=${VICTIM_ID}" >>"$T01_DIR/evidence/session-revoke.log"
