#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/../.."
test -f deploy/t01/.env.t01 || { printf '%s\n' 'Run bun deploy/t01/setup.ts first'; exit 1; }
docker compose -p openbot-t01 --env-file deploy/t01/.env.t01 -f deploy/t01/docker-compose.t01.yml up -d --wait --wait-timeout 90 postgres casdoor-db casdoor
