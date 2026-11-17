#!/usr/bin/env bash
# AC-04: login failure matrix. Automatable subset runs here; the cases that
# need a browser (declined consent, wrong password) are listed in README.md
# and must have their observed results pasted into the report — this script
# FAILS if any case lacks evidence, it never skips silently.
#
# Expected evidence file: scripts/t01/evidence/login-failures.md with one
# `### <case-id>` section per case below.
set -Eeuo pipefail
source "$(dirname "$0")/lib/common.sh"

t01_require_docker
t01_isolation_preflight

EVIDENCE="$T01_DIR/evidence/login-failures.md"
[ -f "$EVIDENCE" ] ||
  t01_fail "login-failures" "no evidence file at scripts/t01/evidence/login-failures.md — perform the browser cases in README.md step 6 first, then re-run. Not skipping."

# Automatable cases, executed live against the running stack:
CASDOOR="http://127.0.0.1:${T01_CASDOOR_PORT}"

# A1: discovery/registration from an origin NOT in TRUSTED_ORIGINS must be
# refused by the server. We probe the server's identity-provider registration
# endpoint unauthenticated: the expected result is a rejection (401/403/400),
# and any 2xx here means the trust gate is broken.
EVIL_REG_STATUS="$(curl -sS -o /dev/null -w '%{http_code}' --max-time 30 \
  -X POST "http://127.0.0.1:${T01_APP_PORT}/api/v2/organizations/00000000-0000-0000-0000-000000000000/identity-providers" \
  -H 'content-type: application/json' \
  -d '{"issuer":"http://127.0.0.1:39999","domain":"t01.test"}')" ||
  t01_fail "login-failures" "untrusted-origin probe errored."
case "$EVIL_REG_STATUS" in
  401|403|400|404) t01_info "login-failures" "A1 untrusted-origin registration rejected with ${EVIL_REG_STATUS}." ;;
  2xx|20*|201) t01_fail "login-failures" "untrusted-origin registration returned ${EVIL_REG_STATUS}; the TRUSTED_ORIGINS gate is not enforcing (AC-04 FAIL)." ;;
  *) t01_info "login-failures" "A1 untrusted-origin registration answered ${EVIL_REG_STATUS}; record and judge in the report." ;;
esac

# A2: Casdoor must not hand out codes for an unregistered redirect URI.
EVIL_CB_STATUS="$(curl -sS -o /dev/null -w '%{http_code}' --max-time 30 \
  "$CASDOOR/api/oauth/authorize?client_id=openbot-t01&response_type=code&scope=openid&state=x&redirect_uri=http://127.0.0.1:9999/callback")" ||
  t01_fail "login-failures" "bad-callback probe errored."
t01_info "login-failures" "A2 unregistered redirect_uri answered ${EVIL_CB_STATUS}; expected a non-redirecting error page — judge in the report."

# Every browser case must be present in the evidence file.
BROWSER_CASES="denied-consent wrong-password wrong-issuer state-mismatch nonce-mismatch"
for c in $BROWSER_CASES; do
  grep -q "### ${c}$" "$EVIDENCE" ||
    t01_fail "login-failures" "evidence file has no '### ${c}' section; run that browser case and record the observed rejection before claiming AC-04."
done

t01_info "login-failures" "AC-04 automatable probes done and all browser cases evidenced; final judgement per case goes in verification-report.md."
