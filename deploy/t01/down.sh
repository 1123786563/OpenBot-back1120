#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/../.."
test "${1:-}" = --destroy-t01 || { printf '%s\n' 'Requires --destroy-t01; deletes only this test compose project volumes. Never deletes other deployments.'; exit 1; }
bun deploy/t01/launch.ts stop
docker compose -p openbot-t01 --env-file deploy/t01/.env.t01 -f deploy/t01/docker-compose.t01.yml down --volumes
# Computers are supervisor-owned rather than Compose-owned; require both ownership labels.
while IFS= read -r id; do
  [ -n "$id" ] && docker rm -f "$id"
done < <(docker ps -aq --filter label=openbot.namespace=openbot-t01 --filter label=openbot.supervisor)
while IFS= read -r volume; do
  [ -n "$volume" ] && docker volume rm "$volume"
done < <(docker volume ls -q --filter label=openbot.namespace=openbot-t01 --filter label=openbot.supervisor)
