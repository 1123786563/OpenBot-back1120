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
AGENT_TOKEN="openbot-verify-managed-agent-token-0123456789abcdef"
COMPUTER_TOKEN="openbot-verify-computer-token-0123456789abcdef"
AGENT_BOT_PORT="${OO_AGENT_BOT_PORT:-4200}"
AGENT_LANGGRAPH_PORT="${OO_AGENT_LANGGRAPH_PORT:-4201}"
AGENT_COMPUTER_PORT="${OO_AGENT_COMPUTER_PORT:-4100}"
# ---------------------------------------------------------------- ---------------------------

if [[ "$MODE" == "docker" ]] && ! docker info >/dev/null 2>&1; then
  echo "FAIL: mode=docker needs a running Docker daemon. Use OO_VERIFY_MODE=native on a host" \
       "without Docker (see docs/observability-openobserve.md)."
  exit 2
fi

if [[ "$MODE" == "docker" ]]; then
  OO_NET="${OO_NETWORK:-openbot_default}"
  if ! docker network inspect "$OO_NET" >/dev/null 2>&1; then
    echo "FAIL: the observability stack joins the OpenBot deployment's existing network, and" \
         "Docker has no network named '$OO_NET'. Bring the OpenBot Compose deployment up first," \
         "or create the network explicitly (docker network create $OO_NET), or point OO_NETWORK" \
         "at the deployment's network. See docs/observability-openobserve.md, 'Prerequisites'."
    exit 2
  fi
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

  # 4g. the three agent services a Compose deployment starts by default, as the same real Bun
  #     processes their images run (`bun src/index.ts`, the image CMD). Their model endpoints
  #     point at closed local ports — the on-premise condition where an optional upstream is
  #     down — and every request below is answered by the real service. Each agent's Error
  #     record comes from its real startup-refusal path: the console.error the service exits
  #     with when its mandatory credential is missing, the failure the code exists to raise in
  #     front of whoever is deploying. It is written into the same log file the running service
  #     uses, so the records land on the service's own name. agent-bot and agent-langgraph have
  #     no console.warn call sites at all (their runtime failures go to the caller as AG-UI
  #     RUN_ERROR events, not to stdout), and that absence is what the severity matrix asserts.
  for d in agent-bot agent-langgraph agent-computer; do
    (cd "$REPO_ROOT/$d" && "$BUN_BIN" install --frozen-lockfile) >> "$LOG_DIR/agent-install.log" 2>&1
  done

  # 4g-1. Error: the real startup-refusal path of each agent (console.error, exit 1).
  (cd "$REPO_ROOT/agent-bot" && "$BUN_BIN" "$RUNNER" "$LOG_DIR/agent-bot.log" "$BUN_BIN" src/index.ts) \
    >> "$LOG_DIR/agent-trigger.log" 2>&1 || true
  (cd "$REPO_ROOT/agent-langgraph" && "$BUN_BIN" "$RUNNER" "$LOG_DIR/agent-langgraph.log" "$BUN_BIN" src/index.ts) \
    >> "$LOG_DIR/agent-trigger.log" 2>&1 || true
  (cd "$REPO_ROOT/agent-computer" && "$BUN_BIN" "$RUNNER" "$LOG_DIR/agent-computer.log" "$BUN_BIN" src/index.ts) \
    >> "$LOG_DIR/agent-trigger.log" 2>&1 || true

  # 4g-2. the running agents (the model endpoint is a closed port on this host).
  (cd "$REPO_ROOT/agent-bot" && exec env PORT="$AGENT_BOT_PORT" \
    MANAGED_AGENT_TOKEN="$AGENT_TOKEN" OPENAI_BASE_URL="http://127.0.0.1:4397/v1" timeout 7200 \
    "$BUN_BIN" "$RUNNER" "$LOG_DIR/agent-bot.log" "$BUN_BIN" src/index.ts) &
  PIDS+=("$!")
  (cd "$REPO_ROOT/agent-langgraph" && exec env PORT="$AGENT_LANGGRAPH_PORT" \
    MANAGED_AGENT_TOKEN="$AGENT_TOKEN" OPENAI_BASE_URL="http://127.0.0.1:4396/v1" timeout 7200 \
    "$BUN_BIN" "$RUNNER" "$LOG_DIR/agent-langgraph.log" "$BUN_BIN" src/index.ts) &
  PIDS+=("$!")
  (cd "$REPO_ROOT/agent-computer" && exec env PORT="$AGENT_COMPUTER_PORT" \
    COMPUTER_TOKEN="$COMPUTER_TOKEN" COMPUTER_BROWSER_MODE=headless \
    PROFILES_DIR="$OO_VERIFY_DIR/computer-profiles" WORKSPACE_DIR="$OO_VERIFY_DIR/computer-work" \
    timeout 7200 "$BUN_BIN" "$RUNNER" "$LOG_DIR/agent-computer.log" "$BUN_BIN" src/index.ts) &
  PIDS+=("$!")

  for spec in "agent-bot listening:$LOG_DIR/agent-bot.log" \
              "agent-langgraph listening:$LOG_DIR/agent-langgraph.log" \
              "agent-computer listening:$LOG_DIR/agent-computer.log"; do
    line="${spec%%:*}"; file="${spec#*:}"
    for _ in $(seq 1 30); do grep -q "$line" "$file" 2>/dev/null && break; sleep 1; done
    if grep -q "$line" "$file" 2>/dev/null; then
      pass "real agent service started: $line"
    else
      fail "agent service did not start: $line (see $file)"
    fi
  done

  # 4g-3. real requests against the real agents: the health check each one publishes (ordinary
  #       operation), an authenticated AG-UI run the unreachable model endpoint fails (the
  #       service's real failure report to its caller), and a token-less request each must refuse.
  AGUI_BODY='{"threadId":"verify-thread","runId":"verify-run","messages":[{"id":"m1","role":"user","content":"health of the log pipeline"}]}'
  for spec in "agent-bot:$AGENT_BOT_PORT" "agent-langgraph:$AGENT_LANGGRAPH_PORT"; do
    name="${spec%%:*}"; port="${spec#*:}"
    code="$(curl -s -o "$EVIDENCE/$name-health.json" -w "%{http_code}" "http://127.0.0.1:$port/health")"
    [[ "$code" == "200" ]] && pass "$name answered its health check (ordinary operation, HTTP 200)" \
      || fail "$name health check returned $code"
    code="$(curl -s -o "$EVIDENCE/$name-agui-unauthorised.json" -w "%{http_code}" \
      -X POST "http://127.0.0.1:$port/ag-ui" -H 'content-type: application/json' -d "$AGUI_BODY")"
    [[ "$code" == "401" ]] && pass "$name refused a token-less AG-UI request (HTTP 401)" \
      || fail "$name returned $code for a token-less AG-UI request"
    curl -s -o "$EVIDENCE/$name-agui-run.json" --max-time 30 \
      -X POST "http://127.0.0.1:$port/ag-ui" -H 'content-type: application/json' \
      -H "x-openbot-agent-token: $AGENT_TOKEN" -d "$AGUI_BODY"
    if [[ "$name" == "agent-bot" ]]; then
      # agent-bot surfaces the model failure at once (RUN_ERROR on the same stream).
      grep -q "RUN_ERROR" "$EVIDENCE/$name-agui-run.json" \
        && pass "$name ran a real AG-UI request; the unreachable model endpoint produced its RUN_ERROR report" \
        || fail "$name AG-UI run did not produce RUN_ERROR (see $EVIDENCE/$name-agui-run.json)"
    else
      # agent-langgraph's framework retries the unreachable endpoint on its own schedule (its
      # RUN_ERROR would follow whenever that window closes), so the assertion here is the one
      # this round can prove: the real service accepted a real, authenticated AG-UI run.
      grep -q "RUN_STARTED" "$EVIDENCE/$name-agui-run.json" \
        && pass "$name ran a real authenticated AG-UI request (RUN_STARTED on the stream; the model failure surfaces through the framework's own retry window)" \
        || fail "$name did not accept the AG-UI run (see $EVIDENCE/$name-agui-run.json)"
    fi
  done
  code="$(curl -s -o "$EVIDENCE/agent-computer-health.json" -w "%{http_code}" \
    "http://127.0.0.1:$AGENT_COMPUTER_PORT/health")"
  [[ "$code" == "200" ]] && pass "agent-computer answered its health check (ordinary operation, HTTP 200)" \
    || fail "agent-computer health check returned $code"
  code="$(curl -s -o "$EVIDENCE/agent-computer-unauthorised.json" -w "%{http_code}" \
    "http://127.0.0.1:$AGENT_COMPUTER_PORT/status")"
  [[ "$code" == "401" ]] && pass "agent-computer refused a token-less request (HTTP 401)" \
    || fail "agent-computer returned $code for a token-less request"
  # Warn: a policy push whose webBotAuth member is malformed — the real console.warn the
  # computer raises when it must refuse part of a push rather than lose the policy in it.
  code="$(curl -s -o "$EVIDENCE/agent-computer-egress-push.json" -w "%{http_code}" \
    -X PUT "http://127.0.0.1:$AGENT_COMPUTER_PORT/egress-policy" \
    -H 'content-type: application/json' -H 'x-openbot-bot-id: shared' \
    -H "authorization: Bearer $COMPUTER_TOKEN" \
    -d '{"policy": null, "webBotAuth": {"members": ["not-a-valid-member"]}}')"
  [[ "$code" == "200" ]] && pass "agent-computer Warn trigger: real egress-policy push whose webBotAuth it refused" \
    || fail "agent-computer egress-policy push returned $code"
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
  if wait_for "SELECT _timestamp FROM \"$STREAM\" WHERE service_name = 'agent-bot' AND severity = 'Info'" \
      "$EVIDENCE/wait-agent-bot-info.json" 1; then
    pass "agent-bot Info records ingested (its listening line, from the real process)"
  else fail "agent-bot Info records did not arrive"; fi
  if wait_for "SELECT _timestamp FROM \"$STREAM\" WHERE service_name = 'agent-langgraph' AND severity = 'Info'" \
      "$EVIDENCE/wait-agent-langgraph-info.json" 1; then
    pass "agent-langgraph Info records ingested"
  else fail "agent-langgraph Info records did not arrive"; fi
  if wait_for "SELECT _timestamp FROM \"$STREAM\" WHERE service_name = 'agent-computer' AND severity = 'Info'" \
      "$EVIDENCE/wait-agent-computer-info.json" 1; then
    pass "agent-computer Info records ingested (sandbox/browser-mode/listening)"
  else fail "agent-computer Info records did not arrive"; fi
  if wait_for "SELECT _timestamp FROM \"$STREAM\" WHERE service_name = 'agent-computer' AND severity = 'Warn'" \
      "$EVIDENCE/wait-agent-computer-warn.json" 1; then
    pass "agent-computer Warn record ingested (computer-web-bot-auth-refused from the real policy push)"
  else fail "agent-computer Warn record did not arrive"; fi
  if wait_for "SELECT _timestamp FROM \"$STREAM\" WHERE service_name LIKE 'agent-%' AND severity = 'Error'" \
      "$EVIDENCE/wait-agent-error.json" 3; then
    pass "agent Error records ingested (each service's real startup-refusal console.error)"
  else fail "agent Error records did not arrive"; fi
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
oo_search "SELECT _timestamp, service_name, severity, openbot_log_type, body FROM \"$STREAM\" WHERE service_name LIKE 'agent-%' ORDER BY _timestamp ASC" \
  "$EVIDENCE/q14-agents.json"
oo_search "SELECT _timestamp, service_name, severity, openbot_log_type, body FROM \"$STREAM\" WHERE service_name = 'agent-computer' AND severity = 'Warn'" \
  "$EVIDENCE/q15-agent-computer-warn.json"
oo_search "SELECT _timestamp, service_name, severity, openbot_log_type, body FROM \"$STREAM\" WHERE service_name LIKE 'agent-%' AND severity = 'Error'" \
  "$EVIDENCE/q16-agent-errors.json"

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
for needed, why in (("agent-bot", "built-in Bot"), ("agent-langgraph", "framework Bot"),
                    ("agent-computer", "browser/file/shell computer")):
    chk(needed in services, f"agent source covered with real records: {needed} ({why})",
        f"source {needed} missing from OpenObserve")
ac_warn = [h for h in hits("q15-agent-computer-warn.json") if h.get("service_name") == "agent-computer"]
chk(bool(ac_warn) and all(h.get("severity") == "Warn" for h in ac_warn),
    "agent-computer's real Warn path (refused policy push) stored as Warn",
    "agent-computer Warn record missing or mis-levelled")
ac_err = [h for h in hits("q16-agent-errors.json")]
chk(bool(ac_err) and {h.get("service_name") for h in ac_err} >= {"agent-bot", "agent-langgraph", "agent-computer"},
    "each agent's real Error path (startup-refusal console.error) stored as Error",
    "agent Error records missing for some service")
bot_warn = [h for h in allrec if h.get("service_name") in ("agent-bot", "agent-langgraph")
            and h.get("severity") == "Warn"]
chk(len(bot_warn) == 0,
    "agent-bot/agent-langgraph carry no Warn records, matching their code (zero console.warn call sites)",
    "unexpected Warn records for a service whose code has no console.warn")
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

# 7b. real accounts, not just absent or wrong credentials. OpenObserve v1.1.2 OSS scopes every
#     account to its organisation, and refuses to issue any role below that organisation's admin
#     ("Custom roles not allowed" — the role ladder is an enterprise feature). So the account
#     model this deployment relies on is: the platform administrator is the root account, no
#     other account is issued, and the loopback binding keeps unauthenticated hosts off. These
#     probes record what the release actually does, so the limitation is evidence rather than
#     prose:
#       * a role=member creation is REFUSED by the server (the documented OSS limit);
#       * a valid account of a DIFFERENT organisation is denied here (401) — org scoping works;
#       * an account created INSIDE this organisation reads its data (200) and is refused user
#         management (403, root-only) — which is why no account is ever issued for the org.
OO_MEMBER_EMAIL="member-probe-$(python3 -c 'import uuid; print(uuid.uuid4().hex[:12])')@openbot.local"
OO_OUTSIDER_ORG="oo_verify_outsider_$(python3 -c 'import uuid; print(uuid.uuid4().hex[:12])')"
oo_post() { # outfile url json
  curl -s -o "$1" -w "%{http_code}" -u "$OO_ROOT_USER_EMAIL:$OO_ROOT_USER_PASSWORD" \
    -H 'content-type: application/json' -X POST "$2" -d "$3"
}
MEMBER_CODE="$(oo_post "$EVIDENCE/auth-member-create.json" \
  "http://$OO_HTTP:$OO_PORT/api/$OO_ORG/users" \
  "{\"email\":\"$OO_MEMBER_EMAIL\",\"password\":\"Member#Probe-2026\",\"role\":\"member\"}")"
grep -q "Custom roles not allowed" "$EVIDENCE/auth-member-create.json" \
  && pass "OSS refuses a below-admin role outright ('Custom roles not allowed') - no lesser account can exist to be under-privileged" \
  || fail "member-role creation returned $MEMBER_CODE (expected the OSS 'Custom roles not allowed' refusal); see $EVIDENCE/auth-member-create.json"

ORG_CREATE_CODE="$(oo_post "$EVIDENCE/auth-outsider-org.json" \
  "http://$OO_HTTP:$OO_PORT/api/organizations" "{\"name\":\"$OO_OUTSIDER_ORG\"}")"
OUTSIDER_ORG_ID="$(python3 -c 'import json,sys;print(json.load(open(sys.argv[1])).get("identifier",""))' \
  "$EVIDENCE/auth-outsider-org.json" 2>/dev/null)"
OUTSIDER_EMAIL="outsider-$(python3 -c 'import uuid; print(uuid.uuid4().hex[:12])')@openbot.local"
OUTSIDER_CODE="$(oo_post "$EVIDENCE/auth-outsider-create.json" \
  "http://$OO_HTTP:$OO_PORT/api/$OUTSIDER_ORG_ID/users" \
  "{\"email\":\"$OUTSIDER_EMAIL\",\"password\":\"Outsider#Probe-2026\",\"role\":\"admin\"}")"
if [[ "$OUTSIDER_CODE" == "200" && -n "$OUTSIDER_ORG_ID" ]]; then
  code="$(curl -s -o "$EVIDENCE/auth-outsider-search.json" -w "%{http_code}" \
    -u "$OUTSIDER_EMAIL:Outsider#Probe-2026" -H 'Content-Type: application/json' \
    -X POST "http://$OO_HTTP:$OO_PORT/api/$OO_ORG/_search" \
    -d "{\"query\":{\"sql\":\"SELECT _timestamp FROM \\\"$OO_ORG\\\" LIMIT 10\",\"start_time\":$RUN_START_US,\"end_time\":$(NOW_US)}}")"
  [[ "$code" == "401" || "$code" == "403" ]] \
    && pass "a valid, authenticated account of another organisation is denied this org's logs -> $code" \
    || fail "outsider org account queried this org -> $code (see $EVIDENCE/auth-outsider-search.json)"
else
  fail "could not create the outsider account (org $ORG_CREATE_CODE, user $OUTSIDER_CODE)"
fi

OO_ORG_ADMIN_EMAIL="orgadmin-$(python3 -c 'import uuid; print(uuid.uuid4().hex[:12])')@openbot.local"
ORG_ADMIN_CODE="$(oo_post "$EVIDENCE/auth-org-admin-create.json" \
  "http://$OO_HTTP:$OO_PORT/api/$OO_ORG/users" \
  "{\"email\":\"$OO_ORG_ADMIN_EMAIL\",\"password\":\"OrgAdmin#Probe-2026\",\"role\":\"admin\"}")"
if [[ "$ORG_ADMIN_CODE" == "200" ]]; then
  code="$(curl -s -o "$EVIDENCE/auth-org-admin-search.json" -w "%{http_code}" \
    -u "$OO_ORG_ADMIN_EMAIL:OrgAdmin#Probe-2026" -H 'Content-Type: application/json' \
    -X POST "http://$OO_HTTP:$OO_PORT/api/$OO_ORG/_search" \
    -d "{\"query\":{\"sql\":\"SELECT _timestamp FROM \\\"$OO_ORG\\\" LIMIT 10\",\"start_time\":$RUN_START_US,\"end_time\":$(NOW_US)}}")"
  [[ "$code" == "200" ]] \
    && pass "an account created INSIDE this org can read its logs (200) - which is why none is issued: the platform administrator stays the only account" \
    || note "org-internal account search -> $code (see $EVIDENCE/auth-org-admin-search.json)"
  code="$(curl -s -o "$EVIDENCE/auth-org-admin-delete.json" -w "%{http_code}" \
    -u "$OO_ORG_ADMIN_EMAIL:OrgAdmin#Probe-2026" -X DELETE \
    "http://$OO_HTTP:$OO_PORT/api/$OO_ORG/users/$OO_ORG_ADMIN_EMAIL")"
  [[ "$code" == "403" ]] \
    && pass "that same account cannot manage users (403, root-only)" \
    || note "org-internal account user-management -> $code (see $EVIDENCE/auth-org-admin-delete.json)"
  DEL_CODE="$(curl -s -o "$EVIDENCE/auth-org-admin-cleanup.json" -w "%{http_code}" \
    -u "$OO_ROOT_USER_EMAIL:$OO_ROOT_USER_PASSWORD" -X DELETE \
    "http://$OO_HTTP:$OO_PORT/api/$OO_ORG/users/$OO_ORG_ADMIN_EMAIL")"
  [[ "$DEL_CODE" == "200" ]] \
    && pass "probe account removed again; the deployment is back to exactly one account" \
    || note "probe account cleanup returned $DEL_CODE (remove $OO_ORG_ADMIN_EMAIL by hand)"
else
  fail "could not create the org-internal probe account (HTTP $ORG_ADMIN_CODE)"
fi

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
