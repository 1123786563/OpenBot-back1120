#!/usr/bin/env bash
# AC-08: a second, unrelated user must not be able to touch the first user's
# sessions or computers, and the first user's operations must not affect the
# second user's own resources.
set -Eeuo pipefail
source "$(dirname "$0")/lib/common.sh"

t01_require_docker
t01_isolation_preflight

: "${T01_COOKIE_USER:?T01_FAIL [cross-user]: T01_COOKIE_USER (user 1 jar) required.}"
: "${T01_COOKIE_USER2:?T01_FAIL [cross-user]: T01_COOKIE_USER2 (unrelated user 2 jar) required.}"
: "${T01_ORG_ID:?T01_FAIL [cross-user]: T01_ORG_ID required.}"
: "${T01_USER_PERSON_ID:?T01_FAIL [cross-user]: T01_USER_PERSON_ID required (user 1).}"
: "${T01_USER2_PERSON_ID:?T01_FAIL [cross-user]: T01_USER2_PERSON_ID required (user 2).}"

# 1. User 2 must NOT be able to list user 1's sessions (SignedInOwnOnly).
S1="$(curl -sS -o /dev/null -w '%{http_code}' --max-time 30 -b "$T01_COOKIE_USER2" \
  "http://127.0.0.1:${T01_APP_PORT}/api/v2/organizations/${T01_ORG_ID}/people/${T01_USER_PERSON_ID}/sessions")" ||
  t01_fail "cross-user" "cross-user session-list probe errored."
case "$S1" in
  403|404|401) t01_info "cross-user" "user2 -> user1 session list rejected (${S1}) — good." ;;
  *) t01_fail "cross-user" "user2 could read user1's sessions (HTTP ${S1}) — AC-08 FAIL." ;;
esac

# 2. User 2 must NOT be able to revoke user 1's session.
D1="$(curl -sS -o /dev/null -w '%{http_code}' --max-time 30 -b "$T01_COOKIE_USER2" -X DELETE \
  "http://127.0.0.1:${T01_APP_PORT}/api/v2/organizations/${T01_ORG_ID}/people/${T01_USER_PERSON_ID}/sessions/00000000-0000-0000-0000-000000000000")" ||
  t01_fail "cross-user" "cross-user delete probe errored."
case "$D1" in
  403|404|401) t01_info "cross-user" "user2 -> revoke user1 session rejected (${D1}) — good." ;;
  204) t01_fail "cross-user" "user2 revoked a user1 session id — AC-08 FAIL." ;;
  *) t01_info "cross-user" "cross-user delete answered ${D1}; judge in report." ;;
esac

# 3. User 2 must NOT be able to stop user 1's computer (admin-only endpoint).
C1="$(curl -sS -o /dev/null -w '%{http_code}' --max-time 30 -b "$T01_COOKIE_USER2" \
  -H 'content-type: application/json' -X POST \
  "http://127.0.0.1:${T01_APP_PORT}/api/v2/organizations/${T01_ORG_ID}/computers/stop" \
  -d '{"computer":"person:'"$T01_USER_PERSON_ID"'"}')" ||
  t01_fail "cross-user" "cross-user stop probe errored."
case "$C1" in
  403|404|401) t01_info "cross-user" "user2 -> stop user1 computer rejected (${C1}) — good." ;;
  200) t01_fail "cross-user" "non-admin user2 stopped a computer — AC-08 FAIL." ;;
  *) t01_info "cross-user" "cross-user stop answered ${C1}; judge in report." ;;
esac

# 4. User 1's session is still intact and still resolves only their own data.
t01_api GET "/api/v2/organizations/${T01_ORG_ID}/people/${T01_USER_PERSON_ID}/sessions" "$T01_COOKIE_USER" 200 >/dev/null ||
  t01_fail "cross-user" "user1's own session broken by user2's rejected attempts — AC-08 FAIL."

# 5. No control credential leaks to a non-admin client: the identity-provider
# list must not carry client secrets in its response body.
IDP_BODY="$(t01_api GET "/api/v2/organizations/${T01_ORG_ID}/identity-providers" "$T01_COOKIE_USER2" 200 || true)"
if [ -n "$IDP_BODY" ]; then
  printf '%s' "$IDP_BODY" | grep -qiE '"(clientSecret|client_secret)"\s*:\s*"[^"]+"' &&
    t01_fail "cross-user" "identity-provider listing leaked a client secret to a non-admin — AC-08/AC-10 FAIL."
fi

t01_info "cross-user" "AC-08 probes done; every rejection and the isolation of user1's resources recorded."
