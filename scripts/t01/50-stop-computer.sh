#!/usr/bin/env bash
# AC-07 (supported subset): stop one computer via
# POST /api/v2/organizations/{org}/computers/stop (admin), then watch an
# independent heartbeat file written by a long-running command inside the
# computer. The API's own semantics — "it starts again when a Bot next needs
# it" (api/openapi/computers.yaml) — are NOT enough for AC-07: the observation
# window here must cover >= 2 heartbeat periods, and the auto-restart
# behaviour gets recorded either way.
#
# Global "stop all background execution and keep it stopped" does not exist in
# the supported API — disclosed gap, not simulated.
set -Eeuo pipefail
source "$(dirname "$0")/lib/common.sh"

t01_require_docker
t01_isolation_preflight

: "${T01_COOKIE_ADMIN:?T01_FAIL [stop-computer]: T01_COOKIE_ADMIN required (admin session cookie jar).}"
: "${T01_ORG_ID:?T01_FAIL [stop-computer]: T01_ORG_ID required.}"
: "${T01_COMPUTER_TARGET:?T01_FAIL [stop-computer]: T01_COMPUTER_TARGET required, e.g. bot:<id> or person:<id>.}"
[ -f "$T01_COOKIE_ADMIN" ] || t01_fail "stop-computer" "admin cookie jar missing; do the real browser admin login first."

COMPUTER="http://127.0.0.1:${T01_SERVER_PORT}"
HEARTBEAT_PERIOD="${T01_HEARTBEAT_PERIOD:-10}"   # seconds between heartbeats
OBSERVE_PERIODS="${T01_OBSERVE_PERIODS:-2}"      # minimum window: 2 periods

# The heartbeat must come from a real long-running command inside the target
# computer (started per README step 7), reading an in-container file — never
# from this script guessing.
t01_compose ps --format '{{.Service}} {{.State}}' | grep -q . ||
  t01_fail "stop-computer" "t01 stack is not running."

t01_info "stop-computer" "requires the heartbeat writer from README step 7 running inside the target computer container:"
t01_info "stop-computer" "  while true; do date -u +%s >> /tmp/t01-heartbeat; sleep ${HEARTBEAT_PERIOD}; done &"
: "${T01_HEARTBEAT_SNAPSHOT_BEFORE:?T01_FAIL [stop-computer]: capture 'docker exec <computer-ctr> cat /tmp/t01-heartbeat | tail -1' into T01_HEARTBEAT_SNAPSHOT_BEFORE first — without an independent pre-stop heartbeat the stop cannot be evidenced.}"

STOP_RESP="$(curl -sS --max-time 60 -b "$T01_COOKIE_ADMIN" \
  -H 'content-type: application/json' \
  -X POST "${COMPUTER}/api/v2/organizations/${T01_ORG_ID}/computers/stop" \
  -d "{\"computer\":\"${T01_COMPUTER_TARGET}\"}")" || true
t01_info "stop-computer" "stopComputer response: ${STOP_RESP:-<no response>}"
printf '%s' "$STOP_RESP" | grep -q '"running"' ||
  t01_fail "stop-computer" "stopComputer did not return the ComputerStopped schema; cannot verify the stop."

WINDOW=$(( HEARTBEAT_PERIOD * (OBSERVE_PERIODS + 1) ))
: "${T01_HEARTBEAT_SNAPSHOT_AFTER:?T01_FAIL [stop-computer]: wait >= ${WINDOW}s after the stop, then put the post-stop heartbeat tail into T01_HEARTBEAT_SNAPSHOT_AFTER.}"
t01_info "stop-computer" "pre-stop heartbeat:  ${T01_HEARTBEAT_SNAPSHOT_BEFORE}"
t01_info "stop-computer" "post-stop heartbeat: ${T01_HEARTBEAT_SNAPSHOT_AFTER} (window >= ${WINDOW}s = ${OBSERVE_PERIODS} periods)"

[ "${T01_HEARTBEAT_SNAPSHOT_AFTER%% *}" = "${T01_HEARTBEAT_SNAPSHOT_BEFORE%% *}" ] &&
  t01_fail "stop-computer" "heartbeat kept advancing after stopComputer — tasks did not stop (AC-07 FAIL)."

t01_info "stop-computer" "recorded. Now record whether the container restarted on its own (auto-restart semantics):"
t01_compose ps
echo "$(date -u +%Y-%m-%dT%H:%M:%SZ) target=${T01_COMPUTER_TARGET} pre=${T01_HEARTBEAT_SNAPSHOT_BEFORE%% *} post=${T01_HEARTBEAT_SNAPSHOT_AFTER%% *}" \
  >>"$T01_DIR/evidence/stop-computer.log"
t01_info "stop-computer" "gap stands: no API stops ALL background execution and prevents re-scheduling."
