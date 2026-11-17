#!/usr/bin/env bash
# AC-10: no server secret, private key, reusable token/cookie/code or
# production credential in the T01 client-side artifacts, this tree, or the
# reports. Uses gitleaks when available; otherwise falls back to a targeted
# pattern scan. A scan that cannot run must fail loudly, not pass by default.
set -Eeuo pipefail
source "$(dirname "$0")/lib/common.sh"

SCAN_ROOT="${T01_SCAN_ROOT:-$T01_DIR}"
report="$(mktemp)"; trap 'rm -f "$report"' EXIT

fail_hit() {
  echo "T01 FAIL [secret-scan]: potential secret matched by $1:" >&2
  grep -nE "$2" "$3" 2>/dev/null | head -5 >&2 || true
  exit 1
}

if command -v gitleaks >/dev/null 2>&1; then
  gitleaks detect --source "$SCAN_ROOT" --no-git --redact -v ||
    t01_fail "secret-scan" "gitleaks found secrets in ${SCAN_ROOT}. Remove them before AC-10 can pass."
  t01_info "secret-scan" "gitleaks: clean over ${SCAN_ROOT}"
elif [ -f "$T01_VERSIONS_LOCK" ]; then
  t01_info "secret-scan" "gitleaks not installed; running targeted pattern scan (install gitleaks for the full scan)"
else
  # Pattern scan is meaningful even before pinning; run it on the tree.
  t01_info "secret-scan" "gitleaks not installed; running targeted pattern scan"
fi

# Targeted patterns over everything the ticket produces (scripts, reports,
# evidence). .env.t01 is runtime-only but still must never contain a
# production-looking credential, so it is scanned too when present.
PATTERNS=(
  'AKIA[0-9A-Z]{16}'                                    # AWS access key
  '-----BEGIN (RSA |EC |OPENSSH |PGP )?PRIVATE KEY'     # private keys
  'gh[pousr]_[A-Za-z0-9]{36,}'                          # GitHub tokens
  'sk-[A-Za-z0-9]{20,}'                                 # API keys (OpenAI-style)
  'COPILOTKIT_LICENSE_TOKEN=[^<\s$]'                    # real license value
  'KEY_ENCRYPTION_KEY=[A-Za-z0-9+/]{40,}={0,2}$'        # real 32-byte key
  'T01_[A-Z_]*(PASSWORD|SECRET|TOKEN)=[^<][^$]*[^<\s]$' # filled runtime creds
)
FILES="$(find "$SCAN_ROOT" -type f \( -name '*.md' -o -name '*.sh' -o -name '*.yml' -o -name '*.yaml' -o -name '*.lock' -o -name '.env*' \) 2>/dev/null | grep -v '/.git/' || true)"
[ -n "$FILES" ] || t01_fail "secret-scan" "no files found under ${SCAN_ROOT} to scan — wrong scan root?"

# shellcheck disable=SC2046
for f in $FILES; do
  # The scanner's own pattern literals are not secrets; skip this file itself.
  [ "$(readlink -f "$f")" = "$(readlink -f "${BASH_SOURCE[0]}")" ] && continue
  # <generate: ...> placeholders and ${VAR} references are fine; real values are not.
  for p in "${PATTERNS[@]}"; do
    # fail when a matching line exists that is not an obvious placeholder
    if grep -E "$p" "$f" 2>/dev/null | grep -qvE '(<generate|YOUR_|XXXX|<64 hex>|\$\{)'; then
      fail_hit "pattern ${p}" "$p" "$f"
    fi
  done
done

t01_info "secret-scan" "targeted scan clean over ${SCAN_ROOT}; record the gitleaks run (or its absence) in verification-report.md"
