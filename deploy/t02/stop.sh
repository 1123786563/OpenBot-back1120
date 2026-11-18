#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/../.."
"${T02_BUN:-bun}" deploy/t02/run.ts stop
docker compose -p openbot-t02 --env-file deploy/t02/.env.t02 -f deploy/t02/docker-compose.t02.yml stop
