#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/../.."
"${T04_BUN:-bun}" deploy/t04/run.ts stop
docker-compose -p openbot-t04 --env-file deploy/t04/.env.t04 -f deploy/t04/docker-compose.t04.yml stop
