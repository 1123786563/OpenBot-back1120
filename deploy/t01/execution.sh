#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/../.."
docker build -f agent-computer/Dockerfile -t openbot-t01-computer:8e442729 .
docker compose -p openbot-t01 --env-file deploy/t01/.env.t01 -f deploy/t01/docker-compose.t01.yml --profile execution up -d --build supervisor
docker image inspect openbot-t01-computer:8e442729 --format '{{.Id}}'
