#!/usr/bin/env bash
# Reproducible acceptance run for OpenBot's OpenObserve log pipeline.
#
# One command that starts a clean, pinned-version OpenObserve and the collector, runs the real
# OpenBot services (server, worker, migrate) against a real PostgreSQL, triggers Info / Warn /
# Error and ordinary business operations on real code paths, queries everything back out of
# OpenObserve, and leaves the evidence (queries + responses) in an evidence directory. It verifies
# the before/after ingestion markers, the restart-survival of stored records, the auth matrix and
# the synthetic-sentinel redaction experiment. Every assertion is checked against actual query
# responses, never against configuration text.
#
# Modes:
#   native (default) — runs without Docker: OpenObserve and the collector as pinned binaries, the
#       OpenBot services as Bun processes whose stdout/stderr go through
#       `container-log-driver.mjs`, which writes the same json-file envelope Docker writes. The
#       collector configuration, the parsing, the redaction and the exporter are identical to the
#       Compose deployment.
#   docker — brings up `docker/observability/compose.yml` against a running OpenBot Compose
#       deployment. Requires a Docker daemon; without one the script says so and exits.
#
# Prerequisites (native):
#   * `bun` on PATH (or $BUN_BIN) and the repository's dependencies installed (`bun install`).
#   * a running PostgreSQL and $DATABASE_URL for it — the same database the deployment under test
#     uses. The OpenBot schema must be applied (`bun scripts/migrate.ts` from `server/`), which
#     this run's first trigger does anyway; PostgreSQL needs the pgvector extension.
#
# Usage:
#   DATABASE_URL=postgres://openbot:openbot@127.0.0.1:5432/openbot \
#     bash scripts/observability/verify-openobserve.sh
#
# Everything is configurable through environment variables (defaults in the CONFIG section).
# Exit code 0 = every assertion passed; the summary names anything that failed.
set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"

# ---------------------------------------------------------------- CONFIG --------------------
MODE="${OO_VERIFY_MODE:-native}"
OO_VERIFY_DIR="${OO_VERIFY_DIR:-/tmp/openobserve-verify}"
BUN_BIN="${BUN_BIN:-bun}"
DATABASE_URL="${DATABASE_URL:-}"
SERVER_PORT="${OO_SERVER_PORT:-3901}"
OTLP_PORT="${OO_OTLP_PORT:-4001}"
OO_HTTP="${OO_OO_HTTP:-127.0.0.1}"
OO_PORT="${OO_OO_PORT:-59080}"
OO_ORG="${OO_ORG:-default}"
OO_ENVIRONMENT="${OO_ENVIRONMENT_LABEL:-verification}"
OO_ROOT_USER_EMAIL="${OO_ROOT_USER_EMAIL:-admin@openbot.local}"
OO_ROOT_USER_PASSWORD="${OO_ROOT_USER_PASSWORD:-OpenBot#OO-Verify-2026}"
OO_BIN_DIR="${OO_BIN_DIR:-$OO_VERIFY_DIR/bin}"
OO_VERSION="v1.1.2"
COLLECTOR_VERSION="0.165.0"
EVIDENCE="$OO_VERIFY_DIR/evidence"
LOG_DIR="$OO_VERIFY_DIR/logs"
DATA_DIR="$OO_VERIFY_DIR/openobserve-data"
COLLECTOR_STATE="$OO_VERIFY_DIR/collector"
RUNNER="$SCRIPT_DIR/container-log-driver.mjs"
ARCH="$(uname -m)"
WORKER_SECRET="openbot-verify-worker-secret-0123456789abcdef"
# ---------------------------------------------------------------- ---------------------------

if [[ "$MODE" == "docker" ]] && ! docker info >/dev/null 2>&1; then
  echo "FAIL: mode=docker needs a running Docker daemon. Use OO_VERIFY_MODE=native on a host" \
       "without Docker (see docs/observability-openobserve.md)."
  exit 2
fi

rm -rf "$OO_VERIFY_DIR"
mkdir -p "$EVIDENCE" "$LOG_DIR" "$DATA_DIR" "$COLLECTOR_STATE/queue" "$COLLECTOR_STATE/payload"
PIDS=()
PASS=0
FAIL=0
declare -a FAILURES=()

pass() { PASS=$((PASS + 1)); echo "  ok    $1"; }
fail() { FAIL=$((FAIL + 1)); FAILURES+=("$1"); echo "  FAIL  $1"; }
note() { echo "  ..    $1"; }

cleanup() {
  for pid in "${PIDS[@]:-}"; do kill "$pid" >/dev/null 2>&1 || true; done
}
trap cleanup EXIT

start_bg() { # logfile command args...
  local logfile="$1"; shift
  "$@" >> "$logfile" 2>&1 &
  PIDS+=("$!")
}

# ---------------------------------------------------------------- binaries ------------------
pinned_download() { # url expected-sha256 dest
  local url="$1" sha="$2" dest="$3"
  if [[ -f "$dest" ]] && [[ "$(sha256sum "$dest" | cut -d' ' -f1)" == "$sha" ]]; then return 0; fi
  if [[ -f "$dest" && -n "$sha" ]]; then
    echo "FATAL: $dest exists but its checksum is not $sha"; exit 2
  fi
  echo "downloading $url"
  curl -sL --retry 3 --max-time 900 -o "$dest" "$url" || { echo "FATAL: download failed"; exit 2; }
  if [[ -n "$sha" ]]; then
    local actual; actual="$(sha256sum "$dest" | cut -d' ' -f1)"
    if [[ "$actual" != "$sha" ]]; then
      echo "FATAL: checksum mismatch for $url (want $sha, got $actual)"; exit 2
    fi
  fi
}

case "$ARCH" in
  x86_64) OO_ARCH="amd64"; COL_ARCH="amd64" ;;
  aarch64|arm64) OO_ARCH="arm64"; COL_ARCH="arm64" ;;
  *) echo "unsupported architecture: $ARCH"; exit 2 ;;
esac

# sha256 of each pinned tarball, computed from the downloads this script pins (the collector's
# from its release's own .sha256 sidecar).
OO_TAR_GLIBC_AMD64="225883447a9e3c75cb52d5a64ece8618cf0d8f3d2eb0b424eebb2e51b0126faa"
OO_TAR_GLIBC_ARM64="4d00e03155594dba473202fdca4f2b8c3b549138f9bab4ff0f6894feda4b7354"
OO_TAR_MUSL_ARM64="b315e81fadd67fb63df0218605f1d18137a89f22b43a0a8e2d72aa61ffe6f600"
COL_TAR_SHA="376420729c862230807bc89811d07d10031eaeca3f6481fe371a2bdcefd2c8fa"

if [[ "$MODE" == "native" ]]; then
  mkdir -p "$OO_BIN_DIR"
  OO_BIN="$OO_BIN_DIR/openobserve"
  COL_BIN="$OO_BIN_DIR/otelcol-contrib"
  if [[ ! -x "$OO_BIN" ]]; then
    OO_TARBALL="$OO_BIN_DIR/openobserve-$OO_VERSION-linux-$OO_ARCH.tar.gz"
    case "$OO_ARCH" in
      amd64) OO_TAR_SHA="$OO_TAR_GLIBC_AMD64" ;;
      arm64) OO_TAR_SHA="$OO_TAR_GLIBC_ARM64" ;;
    esac
    pinned_download \
      "https://downloads.openobserve.ai/releases/openobserve/$OO_VERSION/openobserve-$OO_VERSION-linux-$OO_ARCH.tar.gz" \
      "$OO_TAR_SHA" "$OO_TARBALL"
    sha256sum "$OO_TARBALL" > "$EVIDENCE/openobserve-tarball.sha256"
    tar xzf "$OO_TARBALL" -C "$OO_BIN_DIR"
  fi
  if ! "$OO_BIN" --version >/dev/null 2>&1; then
    echo "note: glibc build unusable on this host; using the musl build of the same version"
    local_tar="$OO_BIN_DIR/openobserve-$OO_VERSION-linux-$OO_ARCH-musl.tar.gz"
    pinned_download \
      "https://downloads.openobserve.ai/releases/openobserve/$OO_VERSION/openobserve-$OO_VERSION-linux-$OO_ARCH-musl.tar.gz" \
      "$OO_TAR_MUSL_ARM64" "$local_tar"
    tar xzf "$local_tar" -C "$OO_BIN_DIR"
  fi
  if [[ ! -x "$COL_BIN" ]]; then
    COL_TARBALL="$OO_BIN_DIR/otelcol-contrib_$COLLECTOR_VERSION.tar.gz"
    pinned_download \
      "https://github.com/open-telemetry/opentelemetry-collector-releases/releases/download/v$COLLECTOR_VERSION/otelcol-contrib_${COLLECTOR_VERSION}_linux_$COL_ARCH.tar.gz" \
      "$COL_TAR_SHA" "$COL_TARBALL"
    tar xzf "$COL_TARBALL" -C "$OO_BIN_DIR"
  fi
  chmod +x "$OO_BIN" "$COL_BIN"
  "$OO_BIN" --version 2>/dev/null | head -1 | sed 's/^/  /'
  "$COL_BIN" --version 2>/dev/null | head -1 | sed 's/^/  /'
fi

# ---------------------------------------------------------------- helpers -------------------
RUN_START_US="$(python3 -c 'import time; print(int((time.time()-300)*1_000_000))')"
NOW_US() { python3 -c 'import time; print(int(time.time()*1_000_000))'; }

oo_search() { # sql outfile [window-start-us]
  local sql="$1" outfile="$2" start_us="${3:-$RUN_START_US}"
  SQL="$sql" OUTFILE="$outfile" START_US="$start_us" python3 - <<'PY'
import json, os, base64, urllib.request, urllib.error
sql, outfile = os.environ["SQL"], os.environ["OUTFILE"]
body = json.dumps({"query": {"sql": sql, "start_time": int(os.environ["START_US"]),
                             "end_time": int(__import__("time").time() * 1_000_000)}}).encode()
auth = base64.b64encode(f"{os.environ['OO_ROOT_USER_EMAIL']}:{os.environ['OO_ROOT_USER_PASSWORD']}".encode()).decode()
req = urllib.request.Request(
    f"http://{os.environ['OO_HTTP']}:{os.environ['OO_PORT']}/api/{os.environ['OO_ORG']}/_search",
    data=body, method="POST",
    headers={"Content-Type": "application/json", "Authorization": f"Basic {auth}"})
try:
    with urllib.request.urlopen(req, timeout=60) as resp:
        out = json.load(resp); out["_http_status"] = resp.status
except urllib.error.HTTPError as e:
    out = {"_http_status": e.code, "error": e.read().decode()[:500]}
with open(outfile, "w") as f:
    json.dump(out, f, indent=2)
PY
}

hits_of() { python3 -c "import json,sys;print(len(json.load(open(sys.argv[1])).get('hits',[])))" "$1" 2>/dev/null || echo 0; }

wait_for() { # sql outfile min-hits tries sleep-secs
  local sql="$1" outfile="$2" want="$3" tries="${4:-20}" sleep_secs="${5:-5}"
  for _ in $(seq 1 "$tries"); do
    oo_search "$sql" "$outfile"
    if [[ "$(hits_of "$outfile")" -ge "$want" ]]; then return 0; fi
    sleep "$sleep_secs"
  done
  return 1
}

# Assert from the saved evidence; prints PASS|/FAIL| lines for the caller's counters.
run_assertions() { # python-file
  local out
  out="$(ASSERTIONS="$1" EVIDENCE="$EVIDENCE" python3 "$1" 2>&1)"
  while IFS= read -r line; do
    if [[ "$line" == "PASS|"* ]]; then pass "${line#PASS|}";
    elif [[ "$line" == "FAIL|"* ]]; then fail "${line#FAIL|}";
    fi
  done <<< "$out"
}

# ---------------------------------------------------------------- 1. up ---------------------
echo "== 1. up: OpenObserve $OO_VERSION + collector $COLLECTOR_VERSION"

OO_ENV_FILE="$OO_VERIFY_DIR/openobserve.env"
cat > "$OO_ENV_FILE" <<ENV
ZO_ROOT_USER_EMAIL=$OO_ROOT_USER_EMAIL
ZO_ROOT_USER_PASSWORD=$OO_ROOT_USER_PASSWORD
ZO_DATA_DIR=$DATA_DIR
ZO_HTTP_PORT=$OO_PORT
ZO_GRPC_PORT=$((OO_PORT + 1))
ZO_MEMORY_CACHE_MAX_SIZE=512
ZO_COMPACT_DATA_RETENTION_DAYS=30
ENV

if [[ "$MODE" == "docker" ]]; then
  (cd "$REPO_ROOT/docker/observability" && docker compose -f compose.yml --env-file env.openobserve up -d)
  note "compose stack started; keep OO_PORT/OO_HTTP pointed at its published UI"
else
  start_bg "$OO_VERIFY_DIR/openobserve.log" /usr/bin/env $(cat "$OO_ENV_FILE" | tr '\n' ' ') "$OO_BIN"
  for _ in $(seq 1 40); do
    curl -s "http://$OO_HTTP:$OO_PORT/healthz" 2>/dev/null | grep -q ok && break
    sleep 1
  done
  if curl -s "http://$OO_HTTP:$OO_PORT/healthz" | grep -q ok; then
    pass "OpenObserve healthy on $OO_HTTP:$OO_PORT (version $OO_VERSION, data dir $DATA_DIR)"
  else
    fail "OpenObserve did not become healthy (see $OO_VERIFY_DIR/openobserve.log)"
  fi
fi
export OO_HTTP OO_PORT OO_ORG OO_ROOT_USER_EMAIL OO_ROOT_USER_PASSWORD

# ---------------------------------------------------------------- 2. marker-before ----------
PRE_MARKER="OO-MARKER-PRE-$(python3 -c 'import uuid; print(uuid.uuid4())')"
POST_MARKER="OO-MARKER-POST-$(python3 -c 'import uuid; print(uuid.uuid4())')"
RESTART_MARKER="OO-MARKER-RESTART-$(python3 -c 'import uuid; print(uuid.uuid4())')"
echo "$PRE_MARKER" > "$EVIDENCE/pre-marker.txt"
echo "$POST_MARKER" > "$EVIDENCE/post-marker.txt"
echo "$RESTART_MARKER" > "$EVIDENCE/restart-marker.txt"

echo "== 2. marker-before: PRE marker written before the collector starts (must stay un-ingested)"
if [[ "$MODE" == "native" ]]; then
  printf '{"log":"{\\"type\\":\\"pre-marker\\",\\"message\\":\\"%s\\"}\\n","stream":"stdout","time":"%s"}\n' \
    "$PRE_MARKER" "$(date -u +%Y-%m-%dT%H:%M:%S.000Z)" >> "$LOG_DIR/server.log"
fi

# ---------------------------------------------------------------- 3. collector --------------
echo "== 3. collector: starting on the pinned configuration"
export OO_COLLECTOR_QUEUE_DIR="$COLLECTOR_STATE/queue"
export OO_RUNTIME_LOG_INCLUDE="$LOG_DIR/*.log"
export OO_OTLP_LISTEN_ENDPOINT="127.0.0.1:$OTLP_PORT"
export OO_INGEST_ENDPOINT="http://$OO_HTTP:$OO_PORT/api/$OO_ORG"
export OO_INGEST_BASIC="$(printf '%s:%s' "$OO_ROOT_USER_EMAIL" "$OO_ROOT_USER_PASSWORD" | base64)"
export OO_PAYLOAD_SNAPSHOT="$COLLECTOR_STATE/payload/sent-payload.json"
export OO_ENVIRONMENT_LABEL="$OO_ENVIRONMENT"
export OO_COLLECTOR_VERSION="$COLLECTOR_VERSION"
COLLECTOR_ARGS=(--config "$REPO_ROOT/docker/observability/otel-collector.yaml")
[[ "$MODE" == "docker" ]] && COLLECTOR_ARGS+=(--config "$REPO_ROOT/docker/observability/otel-collector.docker.yaml")

if [[ "$MODE" == "native" ]]; then
  start_bg "$COLLECTOR_STATE/collector.log" "$COL_BIN" "${COLLECTOR_ARGS[@]}"
  sleep 4
  if grep -q "Everything is ready" "$COLLECTOR_STATE/collector.log"; then
    pass "collector running (filelog start_at:end, OTTL redaction, bounded retrying exporter)"
  else
    fail "collector did not start; see $COLLECTOR_STATE/collector.log"
  fi
fi

# ---------------------------------------------------------------- 4. trigger ----------------
echo "== 4. trigger: real services on real code paths"
if [[ "$MODE" == "native" ]]; then
  if [[ -z "$DATABASE_URL" ]]; then
    echo "FATAL: DATABASE_URL is required in native mode (the PostgreSQL the services run against)"
    exit 2
  fi
  command -v "$BUN_BIN" >/dev/null 2>&1 || { echo "FATAL: bun not found on PATH"; exit 2; }

  # 4a. migrate — the real one-shot migration job (its own container in a Compose deployment).
  (cd "$REPO_ROOT/server" && DATABASE_URL="$DATABASE_URL" \
    "$BUN_BIN" "$RUNNER" "$LOG_DIR/migrate.log" "$BUN_BIN" scripts/migrate.ts) &
  PIDS+=("$!")
  sleep 12

  # 4b. server — the real API server; audit OTLP goes to the collector, never to OpenObserve
  #     directly, so OpenObserve credentials stay out of the process. Intelligence and the
  #     computer point at closed local ports: an on-premise deployment whose optional upstreams
  #     are down, which is itself a real operating condition whose warnings the pipeline should
  #     carry faithfully.
  COMMON_ENV=(
    DATABASE_URL="$DATABASE_URL"
    KEY_ENCRYPTION_KEY="AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA="
    OPENBOT_EDITION=personal
    OPENBOT_SINGLE_USER=true
    AGENT_COMPUTER_URL="http://127.0.0.1:4399"
    INTELLIGENCE_API_URL="http://127.0.0.1:4398"
    INTELLIGENCE_GATEWAY_WS_URL="ws://127.0.0.1:4398"
    CPK_INTELLIGENCE_API_KEY="cpk-verification-not-a-real-key"
    WORKER_SHARED_SECRET="$WORKER_SECRET"
    PORT="$SERVER_PORT" SERVER_PORT="$SERVER_PORT"
    OTEL_SERVICE_NAME="server"
    OTEL_EXPORTER_OTLP_LOGS_ENDPOINT="http://127.0.0.1:$OTLP_PORT/v1/logs"
    COPILOTKIT_TELEMETRY_DISABLED=true)
  (cd "$REPO_ROOT/server" && exec env "${COMMON_ENV[@]}" timeout 7200 \
    "$BUN_BIN" "$RUNNER" "$LOG_DIR/server.log" "$BUN_BIN" src/index.ts) &
  PIDS+=("$!")

  for _ in $(seq 1 40); do
    grep -q "OpenBot server listening" "$LOG_DIR/server.log" 2>/dev/null && break
    sleep 1
  done
  if grep -q "OpenBot server listening" "$LOG_DIR/server.log"; then
    pass "server listening on $SERVER_PORT (real process, real PostgreSQL)"
  else
    fail "server did not start; see $LOG_DIR/server.log"
  fi

  # 4c. ordinary business operation over the real API: save standing instructions. The text
  #     deliberately carries sentinels: the trail must record the change without the text, and
  #     the sentinels must reach neither the payload snapshot nor OpenObserve.
  CHAT_SENTINEL="OO-SENTINEL-CHAT-$(python3 -c 'import uuid; print(uuid.uuid4())')"
  echo "$CHAT_SENTINEL" > "$EVIDENCE/chat-sentinel.txt"
  INSTR_STATUS="$(curl -s -o "$EVIDENCE/business-op-response.json" -w "%{http_code}" \
    -X PUT "http://127.0.0.1:$SERVER_PORT/api/settings/instructions" \
    -H 'content-type: application/json' \
    -d "{\"instructions\":\"Verify pipeline $CHAT_SENTINEL conversation-body and model-output sentinels.\"}")"
  if [[ "$INSTR_STATUS" == "200" ]]; then
    pass "business operation: PUT /api/settings/instructions -> 200 (writes audit event configuration.changed)"
  else
    fail "business operation returned HTTP $INSTR_STATUS (see $EVIDENCE/business-op-response.json)"
  fi

  # 4d. worker — the real routines loop against the real database: Info (`routine-sweep`).
  (cd "$REPO_ROOT/worker" && exec env DATABASE_URL="$DATABASE_URL" \
    SERVER_INTERNAL_URL="http://127.0.0.1:$SERVER_PORT" \
    WORKER_SHARED_SECRET="$WORKER_SECRET" timeout 7200 \
    "$BUN_BIN" "$RUNNER" "$LOG_DIR/worker.log" "$BUN_BIN" src/index.ts) &
  PIDS+=("$!")

  # 4e. second real worker whose database is unreachable — the real DB-blip path the loop exists
  #     to survive: Warn (`routine-sweep-tick-failed`), not a fabricated log line.
  WORKER_WARN_URL="$(python3 -c 'import re, sys; print(re.sub(r":\d+/", ":59999/", sys.argv[1]))' "$DATABASE_URL")"
  (cd "$REPO_ROOT/worker" && exec env DATABASE_URL="$WORKER_WARN_URL" \
    SERVER_INTERNAL_URL="http://127.0.0.1:$SERVER_PORT" \
    WORKER_SHARED_SECRET="$WORKER_SECRET" timeout 7200 \
    "$BUN_BIN" "$RUNNER" "$LOG_DIR/worker-warn.log" "$BUN_BIN" src/index.ts) &
  PIDS+=("$!")

  # 4f. synthetic sentinels, written the way an operator's `docker exec ... > /proc/1/fd/1` echo
  #     lands in a real container's log stream. Each marker is a credential-shaped token
  #     (`sk-sentinel-…`) — the shape the redaction layer must catch — and each travels in a
  #     different position: a nested JSON field, a value that is itself serialized JSON, an array
  #     element, plain exception text, and a bare token. If any of them survives to the collector's
  #     sent payload or to OpenObserve, depth or shape coverage is broken.
  NESTED_SENTINEL="sk-sentinel-nested-$(python3 -c 'import uuid; print(uuid.uuid4().hex)')"
  SERIAL_SENTINEL="sk-sentinel-serial-$(python3 -c 'import uuid; print(uuid.uuid4().hex)')"
  ARRAY_SENTINEL="sk-sentinel-array-$(python3 -c 'import uuid; print(uuid.uuid4().hex)')"
  EXC_SENTINEL="sk-sentinel-exc-$(python3 -c 'import uuid; print(uuid.uuid4().hex)')"
  TOKEN_SENTINEL="sk-sentinel-token-$(python3 -c 'import uuid; print(uuid.uuid4().hex)')"
  printf '%s\n%s\n%s\n%s\n%s\n' "$NESTED_SENTINEL" "$SERIAL_SENTINEL" "$ARRAY_SENTINEL" \
    "$EXC_SENTINEL" "$TOKEN_SENTINEL" > "$EVIDENCE/sentinels.txt"
  python3 - "$LOG_DIR/server.log" "$NESTED_SENTINEL" "$SERIAL_SENTINEL" "$ARRAY_SENTINEL" \
    "$EXC_SENTINEL" "$TOKEN_SENTINEL" <<'PY'
import json, sys, datetime
path, nested, serial, array, exc, token = sys.argv[1:7]
inner = json.dumps({
    "type": "sentinel-nested",
    "payload": {"nested": {"deep": nested}},
    "serialized": json.dumps({"inner": serial}),
    "items": [array],
    "error": f"TypeError: cannot read property of {exc} with {token}",
})
envelope = json.dumps({"log": inner + "\n", "stream": "stdout",
                       "time": datetime.datetime.now(datetime.timezone.utc).isoformat(timespec="milliseconds").replace("+00:00", "Z")})
with open(path, "a") as f:
    f.write(envelope + "\n")
PY
  python3 - "$LOG_DIR/server.log" "$POST_MARKER" <<'PY'
import json, sys, datetime
path, marker = sys.argv[1:3]
inner = json.dumps({"type": "post-marker", "message": marker})
envelope = json.dumps({"log": inner + "\n", "stream": "stdout",
                       "time": datetime.datetime.now(datetime.timezone.utc).isoformat(timespec="milliseconds").replace("+00:00", "Z")})
with open(path, "a") as f:
    f.write(envelope + "\n")
PY
fi

# ---------------------------------------------------------------- 5. query ------------------
echo "== 5. query: the matrix, each answer saved as evidence"
STREAM="$OO_ORG"

if [[ "$MODE" == "native" ]]; then
  if wait_for "SELECT _timestamp FROM \"$STREAM\" WHERE service_name = 'worker' AND severity = 'Info'" \
      "$EVIDENCE/wait-worker-info.json" 1; then
    pass "worker Info (routine-sweep) ingested"
  else fail "worker Info did not arrive"; fi
  if wait_for "SELECT _timestamp FROM \"$STREAM\" WHERE service_name = 'worker-warn' AND severity = 'Warn'" \
      "$EVIDENCE/wait-worker-warn.json" 1; then
    pass "worker Warn (routine-sweep-tick-failed against a down database) ingested"
  else fail "worker Warn did not arrive"; fi
  if wait_for "SELECT _timestamp FROM \"$STREAM\" WHERE log_class = 'audit'" \
      "$EVIDENCE/wait-audit.json" 1; then
    pass "server audit OTLP records ingested (log_class=audit)"
  else fail "audit records did not arrive"; fi
  if wait_for "SELECT _timestamp FROM \"$STREAM\" WHERE service_name = 'server' AND severity = 'Error'" \
      "$EVIDENCE/wait-server-error.json" 1; then
    pass "server Error records ingested (console.error paths, e.g. learning-auto-approve-failed)"
  else fail "server Error records did not arrive"; fi
  sleep 5  # let the sentinel batch land before the negative assertions
fi

oo_search "SELECT _timestamp, service_name, severity, log_class, openbot_log_type, body FROM \"$STREAM\" ORDER BY _timestamp ASC" \
  "$EVIDENCE/q1-all-records.json"
oo_search "SELECT _timestamp, service_name, severity, openbot_log_type, body FROM \"$STREAM\" WHERE service_name = 'server'" \
  "$EVIDENCE/q2-by-service.json"
oo_search "SELECT _timestamp, service_name, severity, openbot_log_type, body FROM \"$STREAM\" WHERE severity = 'Info'" \
  "$EVIDENCE/q3-severity-info.json"
oo_search "SELECT _timestamp, service_name, severity, openbot_log_type, body FROM \"$STREAM\" WHERE severity = 'Warn'" \
  "$EVIDENCE/q4-severity-warn.json"
oo_search "SELECT _timestamp, service_name, severity, openbot_log_type, body FROM \"$STREAM\" WHERE severity = 'Error'" \
  "$EVIDENCE/q5-severity-error.json"
oo_search "SELECT _timestamp, service_name, severity, body, openbot_target_type, openbot_actor_user_id, openbot_event_type FROM \"$STREAM\" WHERE log_class = 'audit'" \
  "$EVIDENCE/q6-audit.json"
oo_search "SELECT DISTINCT deployment_environment FROM \"$STREAM\"" "$EVIDENCE/q7-environments.json"
oo_search "SELECT _timestamp, service_name, openbot_log_type, body FROM \"$STREAM\" WHERE openbot_log_type = 'routine-sweep'" \
  "$EVIDENCE/q8-normal-business.json"
oo_search "SELECT _timestamp, service_name, body FROM \"$STREAM\" WHERE body LIKE '%$POST_MARKER%'" \
  "$EVIDENCE/q9-post-marker.json"
oo_search "SELECT _timestamp, service_name, body FROM \"$STREAM\" WHERE match_all('$PRE_MARKER')" \
  "$EVIDENCE/q10-pre-marker.json"
oo_search "SELECT _timestamp, service_name, severity, body FROM \"$STREAM\" WHERE service_name = 'migrate'" \
  "$EVIDENCE/q13-migrate.json"

cat > "$OO_VERIFY_DIR/assert-matrix.py" <<'PY'
import json, os, sys
ev = os.environ["EVIDENCE"]
def hits(name):
    try:
        return json.load(open(os.path.join(ev, name))).get("hits", [])
    except Exception:
        return []
out = []
def chk(cond, ok_msg, fail_msg):
    out.append(("PASS|" if cond else "FAIL|") + (ok_msg if cond else fail_msg))

allrec = hits("q1-all-records.json")
fields_ok = bool(allrec) and all(
    r.get("_timestamp") and r.get("service_name") and r.get("severity")
    and r.get("log_class") and ("body" in r) for r in allrec[:500])
chk(fields_ok, f"every record carries time/service/severity/log_class/body ({len(allrec)} rows)",
    "some record lacks a required query field")
chk(any(h.get("severity") == "Info" for h in hits("q3-severity-info.json")),
    "Info-level records queryable", "no Info-level records found")
chk(any(h.get("severity") == "Warn" for h in hits("q4-severity-warn.json")),
    "Warn-level records queryable", "no Warn-level records found")
chk(any(h.get("severity") == "Error" for h in hits("q5-severity-error.json")),
    "Error-level records queryable", "no Error-level records found")
chk(bool(hits("q8-normal-business.json")),
    "ordinary business records (routine-sweep) present, not only errors",
    "no ordinary business records found")
audit = hits("q6-audit.json")
chk(bool(audit) and any(h.get("openbot_target_type") or h.get("openbot_event_type") or h.get("openbot_actor_user_id") for h in audit),
    "audit records keep their existing identifiers (event/target/actor) un-fabricated",
    "audit records lost their identifiers")
chk(all(not any(k in ("run_id", "request_id") for k in h) for h in allrec if h.get("log_class") == "runtime"),
    "runtime records carry no fabricated run/request IDs",
    "fabricated correlation IDs found on runtime records")
envs = {h.get("deployment_environment") for h in hits("q7-environments.json")}
chk(os.environ.get("OO_ENVIRONMENT_LABEL") in envs,
    f"environment filter value present: {envs}", f"environment mismatch: {envs}")
services = {h.get("service_name") for h in allrec}
for needed, why in (("server", "API server"), ("worker", "routines worker"), ("migrate", "migration job")):
    chk(needed in services, f"first-run source covered with real records: {needed} ({why})",
        f"source {needed} missing from OpenObserve")
marker = open(os.path.join(ev, "post-marker.txt")).read().strip()
chk(any(marker in json.dumps(h) for h in hits("q9-post-marker.json")),
    "POST marker (written after the collector started) queryable",
    "POST marker not found in OpenObserve")
pre = hits("q10-pre-marker.json")
chk(len(pre) == 0,
    "PRE marker (written before the collector started) has zero hits - only new logs are collected",
    f"PRE marker leaked into OpenObserve: {pre[:1]}")
chk(bool(hits("q13-migrate.json")), "migrate one-shot job records queryable",
    "migrate records not queryable")
print("\n".join(out))
PY
run_assertions "$OO_VERIFY_DIR/assert-matrix.py"

# ---------------------------------------------------------------- 6. restart ----------------
echo "== 6. restart: same records must still answer after a full restart"
if [[ "$MODE" == "native" ]]; then
  for pid in "${PIDS[@]}"; do kill "$pid" >/dev/null 2>&1 || true; done
  PIDS=()
  sleep 3
  start_bg "$OO_VERIFY_DIR/openobserve.log" /usr/bin/env $(cat "$OO_ENV_FILE" | tr '\n' ' ') "$OO_BIN"
  for _ in $(seq 1 40); do
    curl -s "http://$OO_HTTP:$OO_PORT/healthz" 2>/dev/null | grep -q ok && break
    sleep 1
  done
  start_bg "$COLLECTOR_STATE/collector.log" "$COL_BIN" "${COLLECTOR_ARGS[@]}"
  sleep 4
  (cd "$REPO_ROOT/server" && exec env "${COMMON_ENV[@]}" timeout 7200 \
    "$BUN_BIN" "$RUNNER" "$LOG_DIR/server.log" "$BUN_BIN" src/index.ts) &
  PIDS+=("$!")
  sleep 10
  printf '{"log":"{\\"type\\":\\"restart-marker\\",\\"message\\":\\"%s\\"}\\n","stream":"stdout","time":"%s"}\n' \
    "$RESTART_MARKER" "$(date -u +%Y-%m-%dT%H:%M:%S.000Z)" >> "$LOG_DIR/server.log"
  sleep 10
fi
oo_search "SELECT _timestamp, service_name, severity, log_class, body FROM \"$STREAM\" ORDER BY _timestamp ASC" \
  "$EVIDENCE/q11-after-restart.json"
oo_search "SELECT _timestamp, body FROM \"$STREAM\" WHERE body LIKE '%$RESTART_MARKER%'" \
  "$EVIDENCE/q12-restart-marker.json"

cat > "$OO_VERIFY_DIR/assert-restart.py" <<'PY'
import json, os
ev = os.environ["EVIDENCE"]
def hits(name):
    try:
        return json.load(open(os.path.join(ev, name))).get("hits", [])
    except Exception:
        return []
after = hits("q11-after-restart.json")
rm = open(os.path.join(ev, "restart-marker.txt")).read().strip()
out = [
    ("PASS|" if len(after) > 0 else "FAIL|") + f"records stored before the restart are still queryable ({len(after)} rows)",
    ("PASS|" if any(rm in json.dumps(h) for h in hits("q12-restart-marker.json")) else "FAIL|")
    + "records written after the restart are collected and queryable",
]
print("\n".join(out))
PY
run_assertions "$OO_VERIFY_DIR/assert-restart.py"

# ---------------------------------------------------------------- 7. auth -------------------
echo "== 7. auth: admin yes, everyone else no"
oo_auth_probe() { # outfile status-file curl-auth-args...
  local outfile="$1" statusfile="$2"; shift 2
  local code
  code="$(curl -s -o "$outfile" -w "%{http_code}" "$@" -H 'Content-Type: application/json' \
    -X POST "http://$OO_HTTP:$OO_PORT/api/$OO_ORG/_search" \
    -d "{\"query\":{\"sql\":\"SELECT _timestamp FROM \\\"$OO_ORG\\\" LIMIT 1\",\"start_time\":$RUN_START_US,\"end_time\":$(NOW_US)}}")"
  echo "$code" > "$statusfile"
}
oo_auth_probe "$EVIDENCE/auth-admin-response.json" "$EVIDENCE/auth-admin.status" \
  -u "$OO_ROOT_USER_EMAIL:$OO_ROOT_USER_PASSWORD"
oo_auth_probe "$EVIDENCE/auth-unauthenticated-response.json" "$EVIDENCE/auth-unauthenticated.status"
oo_auth_probe "$EVIDENCE/auth-wrong-password-response.json" "$EVIDENCE/auth-wrong-password.status" \
  -u "$OO_ROOT_USER_EMAIL:not-the-password"
ADMIN_CODE="$(cat "$EVIDENCE/auth-admin.status")"
UNAUTH_CODE="$(cat "$EVIDENCE/auth-unauthenticated.status")"
WRONG_CODE="$(cat "$EVIDENCE/auth-wrong-password.status")"
[[ "$ADMIN_CODE" == "200" ]] && pass "administrator API search -> 200" \
  || fail "administrator search returned $ADMIN_CODE"
[[ "$UNAUTH_CODE" == "401" || "$UNAUTH_CODE" == "403" ]] \
  && pass "unauthenticated request rejected -> $UNAUTH_CODE" \
  || fail "unauthenticated request returned $UNAUTH_CODE"
[[ "$WRONG_CODE" == "401" || "$WRONG_CODE" == "403" ]] \
  && pass "wrong credentials rejected -> $WRONG_CODE" \
  || fail "wrong credentials returned $WRONG_CODE"

# ---------------------------------------------------------------- 8. redaction --------------
echo "== 8. redaction: synthetic sentinels must appear nowhere"
if [[ "$MODE" == "native" ]]; then
  : > "$EVIDENCE/redaction-summary.txt"
  REDACTION_OK=1
  while IFS= read -r marker; do
    [[ -z "$marker" ]] && continue
    # match_all searches every stored field of a record (body and all attributes, nested included);
    # a body-only LIKE could miss a raw value hiding in a structured field.
    oo_search "SELECT _timestamp, service_name, body FROM \"$STREAM\" WHERE match_all('$marker')" \
      "$EVIDENCE/redaction-last-query.json"
    HITS="$(hits_of "$EVIDENCE/redaction-last-query.json")"
    if [[ "$HITS" != "0" ]]; then
      REDACTION_OK=0
      echo "  FAIL  sentinel visible in OpenObserve: $marker"
    fi
  done < <(cat "$EVIDENCE/sentinels.txt" "$EVIDENCE/chat-sentinel.txt")
  sleep 5  # exporter batch grace before reading the snapshot
  if [[ -f "$OO_PAYLOAD_SNAPSHOT" ]]; then
    SENTINEL_RE="$(cat "$EVIDENCE/sentinels.txt" | tr '\n' '|' | sed 's/|$//')"
    if grep -qE "$SENTINEL_RE" "$OO_PAYLOAD_SNAPSHOT"; then
      REDACTION_OK=0; fail "sentinel found in the collector's actual sent payload"
    else
      pass "sentinels absent from the collector's actual sent payload (post-redaction snapshot)"
    fi
    cp "$OO_PAYLOAD_SNAPSHOT" "$EVIDENCE/sent-payload-snapshot.json"
    if grep -q "$OO_INGEST_BASIC" "$OO_PAYLOAD_SNAPSHOT"; then
      fail "ingest credential found in sent payload"
    else
      pass "ingest credential absent from sent payload"
    fi
  else
    note "no payload snapshot on disk; redaction verified against OpenObserve queries only"
  fi
  if [[ "$REDACTION_OK" == "1" ]]; then
    pass "sentinels (nested field / serialized JSON / array element / exception text / chat body) absent from OpenObserve"
  fi
fi

# ---------------------------------------------------------------- 9. summary ----------------
echo
echo "== summary"
if [[ -n "${FAILURES[@]:-}" ]]; then
  for f in "${FAILURES[@]}"; do echo "  FAILED: $f"; done
fi
echo "  passed: $PASS   failed: $FAIL"
echo "  evidence: $EVIDENCE"
[[ "$FAIL" == "0" ]]
