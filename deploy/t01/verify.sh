#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/../.."
BUN="${T01_BUN:-$(npm exec --yes --package bun@1.4.3 -- sh -c 'command -v bun')}"
"$BUN" deploy/t01/verify/api.ts "${1:?select login or revoked}"
