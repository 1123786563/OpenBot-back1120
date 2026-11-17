#!/usr/bin/env bash
# Tear down ONLY this ticket's resources: the openbot-t01 compose project and
# its t01-* volumes. Everything else on the machine (the existing deployment's
# openbot_default network, casdoor-data volume, ports 3010/3001/8000) is
# untouchable by construction: this script never references them.
set -Eeuo pipefail
source "$(dirname "$0")/lib/common.sh"

t01_require_docker

t01_info "down" "removing compose project ${T01_PROJECT} and its volumes"
t01_compose down --volumes --remove-orphans ||
  t01_fail "down" "compose down failed; inspect with docker compose -p ${T01_PROJECT} ps"

# Assert nothing of ours survived.
LEFT="$(docker volume ls --format '{{.Name}}' | grep -E '^openbot-t01_' || true)"
[ -z "$LEFT" ] || t01_fail "down" "volumes not removed: ${LEFT}"
if docker network ls --format '{{.Name}}' | grep -q '^t01-net$'; then
  docker network rm t01-net >/dev/null ||
    t01_fail "down" "network t01-net still present and could not be removed."
fi
t01_info "down" "clean: no openbot-t01 volumes, no t01-net. Existing deployments untouched."
