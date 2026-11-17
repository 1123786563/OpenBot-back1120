#!/usr/bin/env bash
# Create the T01 Casdoor application (confidential client, authorization code +
# PKCE S256) and the three test identities through Casdoor's admin API.
#
# Credentials come from the runtime env file only. The client secret produced
# here is stored in OpenBot's encrypted identity-provider registration, never
# in git (AC-10).
#
# NOT RUN yet: first execution on a real Casdoor must confirm the exact admin
# API payload shapes for the pinned image version; the script fails loudly
# rather than guessing success.
set -Eeuo pipefail
source "$(dirname "$0")/lib/common.sh"

t01_require_docker
t01_isolation_preflight

for var in T01_CASDOOR_ADMIN_USER T01_CASDOOR_ADMIN_PASSWORD \
           T01_ADMIN_PASSWORD T01_USER_PASSWORD T01_USER2_PASSWORD; do
  grep -Eq "^${var}=..*" "$T01_ENV_FILE" ||
    t01_fail "casdoor-app" ".env.t01 is missing ${var}; Casdoor bootstrap cannot run without real credentials."
done
# shellcheck disable=SC1090
source "$T01_ENV_FILE"

CASDOOR="http://127.0.0.1:${T01_CASDOOR_PORT}"
CALLBACK="http://127.0.0.1:${T01_APP_PORT}/api/auth/callback/casdoor-t01"
# Better Auth callback provider id is decided by the server at registration
# time; `casdoor-t01` is the working assumption recorded in README.md and must
# be corrected from the real registration response on first run.

json_field() { # <json> <field>
  printf '%s' "$1" | node -e 'let d="";process.stdin.on("data",c=>d+=c).on("end",()=>{try{const o=JSON.parse(d);console.log(o[process.argv[1]]??"")}catch(e){process.exit(1)}})' "$2"
}

# 1. Admin sign-in -> token.
LOGIN="$(curl -fsS --max-time 30 -X POST "$CASDOOR/api/login" \
  -H 'content-type: application/json' \
  -d "{\"name\":\"${T01_CASDOOR_ADMIN_USER}\",\"password\":\"${T01_CASDOOR_ADMIN_PASSWORD}\",\"type\":\"login\"}")" ||
  t01_fail "casdoor-app" "Casdoor admin login failed; check T01_CASDOOR_ADMIN_* in .env.t01"
ADMIN_TOKEN="$(json_field "$LOGIN" data | node -e 'let d="";process.stdin.on("data",c=>d+=c).on("end",()=>{try{console.log(JSON.parse(d).accessToken??"")}catch(e){process.exit(1)}})')"
[ -n "$ADMIN_TOKEN" ] || t01_fail "casdoor-app" "Casdoor admin login returned no accessToken."

casdoor_api() { # endpoint payload
  curl -fsS --max-time 30 -X POST "$CASDOOR/api/$1" \
    -H 'content-type: application/json' \
    -H "Authorization: Bearer ${ADMIN_TOKEN}" \
    -d "$2"
}

# 2. The application. redirectUris = exactly the Better Auth callback URI, so
# the callback whitelist holds only the test address (AC-10).
APP_PAYLOAD=$(node -e '
const p = {
  owner: "admin", name: "openbot-t01", displayName: "OpenBot T01 integration",
  organization: "built-in", clientId: process.env.T01_CLIENT_ID || "openbot-t01",
  grantTypes: ["authorization_code"], tokenFormat: ["JWT"],
  redirectUris: [process.env.T01_CALLBACK],
  tokenExpiration: 168, expireInHours: 24,
}
console.log(JSON.stringify(p))' )
T01_CALLBACK="$CALLBACK" casdoor_api add-application "$APP_PAYLOAD" >/dev/null ||
  t01_fail "casdoor-app" "create-application failed (an application named openbot-t01 may already exist; that is fine only if its redirect URI matches ${CALLBACK})."

# 3. Test identities, all in the allowed domain t01.test.
add_user() { # name password displayName isAdmin
  local payload
  payload=$(node -e '
    console.log(JSON.stringify({owner:"built-in", name:process.argv[1],
      displayName:process.argv[3], password:process.argv[2],
      email:process.argv[1] + "@t01.test", type:"normal-user",
      isAdmin: process.argv[4] === "yes"}))' "$1" "$2" "$1 test identity" "${4:-no}")
  casdoor_api add-user "$payload" >/dev/null ||
    t01_fail "casdoor-app" "add-user ${1} failed (exists already? verify its password instead of reusing an unknown one)."
}
add_user t01-admin "$T01_ADMIN_PASSWORD" yes
add_user t01-user "$T01_USER_PASSWORD" no
add_user t01-user2 "$T01_USER2_PASSWORD" no

t01_info "casdoor-app" "application openbot-t01 + identities ready; callback URI to register with the provider: ${CALLBACK}"
t01_info "casdoor-app" "issuer under test: ${CASDOOR} — must match the server registration character for character"
