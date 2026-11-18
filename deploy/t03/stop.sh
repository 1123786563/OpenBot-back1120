#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/../.."
"${T03_BUN:-bun}" deploy/t03/run.ts stop
docker-compose -p openbot-t03 --env-file deploy/t03/.env.t03 -f deploy/t03/docker-compose.t03.yml stop
