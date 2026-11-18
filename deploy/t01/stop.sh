#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/../.."
bun deploy/t01/launch.ts stop
docker compose -p openbot-t01 --env-file deploy/t01/.env.t01 -f deploy/t01/docker-compose.t01.yml stop
