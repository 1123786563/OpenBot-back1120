"""Exercise the shipped Docker forwarding, collector, and OpenObserve configuration."""
import argparse
import base64
from http.cookiejar import CookieJar
import json
import os
from pathlib import Path
import secrets
import shutil
import socket
import subprocess
import tempfile
import time
from urllib.error import HTTPError, URLError
from urllib.request import HTTPCookieProcessor, Request, build_opener, urlopen
from uuid import uuid4


ROOT = Path(__file__).resolve().parents[2]
OBS = ROOT / "docker/observability"
ARM_IMAGES = {
    "OO_PLATFORM": "linux/arm64",
    "OO_IMAGE": "openobserve/openobserve:v1.1.2-arm64@sha256:e4cb7e211399183357dbd831cb92311181a3d24255aff711c1027e129652c209",
    "OO_COLLECTOR_IMAGE": "otel/opentelemetry-collector-contrib:0.165.0-arm64@sha256:19b524dc61144cb50e9dccc9469605706db48e3302ddccda404a0aaf0a99a73f",
}
SOURCES = ("postgres", "migrate", "server", "worker", "agent-bot", "agent-langgraph", "agent-computer",
           "spire-server", "spire-agent", "computer")
# The compose default: the token the supervisor's caller must present.
SUPERVISOR_TOKEN = "openbot-dev-supervisor-token"


def require(condition, message):
    if not condition:
        raise RuntimeError(message)
    print(f"PASS {message}", flush=True)


def retry(check, description, timeout=100):
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        try:
            result = check()
            if result:
                return result
        except (URLError, TimeoutError, ConnectionError):
            pass
        time.sleep(1)
    raise RuntimeError(f"Timed out: {description}")


def ports(count):
    sockets = [socket.socket() for _ in range(count)]
    try:
        for sock in sockets:
            sock.bind(("127.0.0.1", 0))
        return [sock.getsockname()[1] for sock in sockets]
    finally:
        for sock in sockets:
            sock.close()


def basic(name, secret):
    return "Basic " + base64.b64encode(f"{name}:{secret}".encode()).decode()


def compose_command():
    """`docker compose` where it is a plugin, else the standalone `docker-compose` binary.

    Docker installs either way depending on the host; the flags mean the same to both.
    """
    plugin = subprocess.run(["docker", "compose", "version"], stdout=subprocess.PIPE,
                            stderr=subprocess.PIPE)
    if plugin.returncode == 0:
        return ["docker", "compose"]
    standalone = shutil.which("docker-compose")
    if standalone:
        return [standalone]
    raise RuntimeError("neither `docker compose` nor `docker-compose` is available")


def http(url, path, data=None, auth=None, method=None, send=urlopen, timeout=8):
    headers = {}
    if data is not None:
        headers["Content-Type"] = "application/json"
    if auth:
        headers["Authorization"] = auth
    req = Request(url + path, None if data is None else json.dumps(data).encode(),
                  headers, method=method)
    try:
        response = send(req, timeout=timeout)
    except HTTPError as error:
        response = error
    with response:
        try:
            body = json.load(response)
        except (ValueError, UnicodeError):
            body = {}
        return response.status, body


def verify(work, build, keep):
    stack = f"oo-verify-{secrets.token_hex(4)}"
    query_port, forward_port, app_port, server_port, postgres_port, bot_port, langgraph_port, computer_port, supervisor_port = ports(9)
    app_url, query_url = f"http://127.0.0.1:{server_port}", f"http://127.0.0.1:{query_port}"
    email, password = "operator@example.invalid", "Az1!" + secrets.token_urlsafe(28)
    operator = basic(email, password)
    start = int((time.time() - 60) * 1_000_000)
    env = {key: value for key, value in os.environ.items()
           if key in {"PATH", "HOME", "TMPDIR", "DOCKER_HOST", "DOCKER_CONTEXT", "DOCKER_CONFIG"}}
    env.update(
        OO_QUERY_PORT=str(query_port), OO_FORWARD_PORT=str(forward_port), OO_NETWORK=f"{stack}_data",
        OO_ENVIRONMENT_LABEL=stack, ZO_ROOT_USER_EMAIL=email, ZO_ROOT_USER_PASSWORD=password,
        APP_PORT=str(app_port), SERVER_PORT=str(server_port), POSTGRES_PORT=str(postgres_port),
        BOT_PORT=str(bot_port), LANGGRAPH_PORT=str(langgraph_port), COMPUTER_PORT=str(computer_port),
        SUPERVISOR_PORT=str(supervisor_port),
        # Built fresh for this run: the dynamic-computer log forwarding only exists in this
        # checkout, so a stale host image would silently verify the wrong code.
        SUPERVISOR_IMAGE=f"{stack}-supervisor",
        OPENAI_API_KEY="verification-only", INTELLIGENCE_API_KEY="verification-only",
        MANAGED_AGENT_TOKEN=secrets.token_hex(24), AGENT_TOOL_TOKEN=secrets.token_hex(24),
        COMPUTER_TOKEN=secrets.token_hex(24), WORKER_SHARED_SECRET=secrets.token_hex(24),
        KEY_ENCRYPTION_KEY=base64.b64encode(secrets.token_bytes(32)).decode(),
        COMPUTER_SUPERVISOR_CONTAINER_URL="", OPENAI_CONTAINER_BASE_URL="http://127.0.0.1:1",
        INTELLIGENCE_CONTAINER_API_URL="http://127.0.0.1:1",
        INTELLIGENCE_CONTAINER_GATEWAY_WS_URL="ws://127.0.0.1:1",
        IMAGE_PULL_POLICY="never",
    )

    def docker(*args, text=None, check=True):
        # A "compose" head means this is the resolved Compose command, not plain Docker; feeding
        # either form to a bare `docker` is what once printed "unknown flag: --env-file".
        argv = (*compose, *args[1:]) if args[0] == "compose" else ("docker", *args)
        return subprocess.run(argv, cwd=ROOT, env=env, input=text,
                              text=True, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
                              check=check)

    arch = docker("info", "--format", "{{.Architecture}}").stdout.strip()
    if arch in {"aarch64", "arm64"}:
        env.update(ARM_IMAGES)
    override = work / "verify.compose.yml"
    # Use the real app images, with disposable credentials and network addresses.
    # The server never joins an existing OpenBot deployment or its host storage.
    override.write_text(f"""
services:
  server:
    environment:
      OPENBOT_EDITION: personal
      OPENBOT_SINGLE_USER: "true"
      COPILOTKIT_TELEMETRY_DISABLED: "true"
    volumes: !reset []
  worker:
    environment:
      COPILOTKIT_TELEMETRY_DISABLED: "true"
  supervisor:
    environment:
      # This host may run a real deployment beside this test; a namespace of its own keeps the
      # computer created here out of that deployment's ownership checks and cleanup.
      COMPUTER_NAMESPACE: {stack}
""")
    empty_env = work / "empty.env"
    empty_env.touch()
    compose = compose_command()
    app = ("compose", "--env-file", str(empty_env), "-p", stack, "--profile", "openbot", "-f", str(ROOT / "docker-compose.yml"),
           "-f", str(OBS / "openbot-logging.compose.yml"), "-f", str(override))
    obs = ("compose", "--env-file", str(empty_env), "-p", f"{stack}-obs", "-f", str(OBS / "compose.yml"))
    # Compose needs the app network while the collector comes up, before any application starts logging.
    unrelated = f"{stack}-unrelated"
    failing_worker = f"{stack}-worker-database-fault"
    computer_container = None
    old_id, runtime_id, second_id = (str(uuid4()) for _ in range(3))
    (work / "test-run.json").write_text(json.dumps({"project": stack, "query_port": query_port, "source": SOURCES}))

    def search(sql, auth=operator, send=urlopen):
        return http(query_url, "/api/default/_search",
                    {"query": {"sql": sql, "start_time": start,
                               "end_time": int(time.time() * 1_000_000), "size": 1000}},
                    auth, send=send)

    def hits(sql):
        code, result = search(sql)
        return result.get("hits", []) if code == 200 else []

    def record(name, data):
        (work / name).write_text(json.dumps(data, indent=2) + "\n")

    try:
        # Disable the shared checkout's .env and host mounts. The attached services use test data.
        docker("network", "create", "--label", f"com.docker.compose.project={stack}",
               "--label", "com.docker.compose.network=data", f"{stack}_data")
        docker(*obs, "up", "-d", "openobserve")
        retry(lambda: http(query_url, "/healthz")[0] == 200, "OpenObserve health")
        query_container = docker(*obs, "ps", "-q", "openobserve").stdout.strip()
        networks = json.loads(docker("inspect", "--format", "{{json .NetworkSettings.Networks}}",
                                     query_container).stdout)
        bindings = json.loads(docker("inspect", "--format", "{{json .NetworkSettings.Ports}}",
                                     query_container).stdout)
        require(set(networks) == {f"{stack}-obs_query"} and
                bindings["5080/tcp"] == [{"HostIp": "127.0.0.1", "HostPort": str(query_port)}],
                "OpenObserve is on its private network and query is bound to host loopback")
        code, outcome = http(query_url, "/api/default/ingestion-tokens", {"name": stack, "description": ""},
                             operator)
        if code not in (200, 201):
            raise RuntimeError(f"Could not issue ingest-only token: HTTP {code}")
        ingest_token = outcome["data"]["token"]
        env["OO_INGEST_BASIC"] = basic("default", ingest_token).split(" ", 1)[1]
        require(ingest_token.startswith("o2oi_"), "OpenObserve issued its native ingestion token")

        docker("run", "-d", "--name", unrelated, "alpine", "sh", "-c",
               f"echo '{{\"type\":\"routine-sweep\",\"runId\":\"{old_id}\"}}'; sleep 600")
        docker(*obs, "up", "-d", "otel-collector")
        retry(lambda: "Everything is ready" in docker(*obs, "logs", "otel-collector").stdout,
              "collector running")
        if build:
            # Avoid tagging the operator's existing application images.
            env.update(SERVER_IMAGE=f"{stack}-server", BOT_IMAGE=f"{stack}-bot",
                       LANGGRAPH_IMAGE=f"{stack}-langgraph", COMPUTER_IMAGE=f"{stack}-computer")
            docker(*app, "build", "server", "agent-bot", "agent-langgraph", "agent-computer")
        # The supervisor image is small, and the dynamic-computer log driver only exists in this
        # checkout: build it on every run so the verification cannot praise a stale host image.
        docker(*app, "build", "supervisor")
        docker(*app, "up", "-d", "--no-deps", "postgres")
        retry(lambda: docker(*app, "exec", "-T", "postgres", "pg_isready", "-h", "127.0.0.1",
                             "-U", "openbot", "-d", "openbot", check=False).returncode == 0,
              "test PostgreSQL accepting TCP connections")
        docker(*app, "up", "--no-deps", "--exit-code-from", "migrate", "migrate")
        docker(*app, "up", "-d", "--no-deps", "server", "worker", "agent-bot", "agent-langgraph", "agent-computer")
        retry(lambda: http(app_url, "/health")[0] == 200, "OpenBot server health")
        docker(*app, "run", "-d", "--no-deps", "--name", failing_worker,
               "-e", "DATABASE_URL=postgres://openbot:openbot@127.0.0.1:1/openbot", "worker")
        for service, port in zip(SOURCES[-5:-2], (bot_port, langgraph_port, computer_port)):
            retry(lambda: http(f"http://127.0.0.1:{port}", "/health")[0] == 200, f"{service} health")
        # With its dependencies: spire-init must fix the fresh volumes' ownership before the
        # server starts, or the server fails on its datastore rather than logging a real run.
        docker(*app, "up", "-d", "spire-server", "spire-agent")
        docker(*app, "up", "-d", "--no-deps", "supervisor")
        retry(lambda: http(f"http://127.0.0.1:{supervisor_port}", "/health")[0] == 200, "supervisor health")

        key_parts = ("conversation", "prompt", "completion", "tool-input", "tool-output", "nested",
                     "encoded", "exception", "plain", "audit", "credential")
        markers = {key: f"private-{key}-{uuid4()}" for key in key_parts}
        code, _ = http(app_url, "/api/settings/instructions", {"instructions": markers["conversation"]},
                       method="PUT")
        require(code == 200, "real OpenBot settings operation returned HTTP 200")
        record_data = {
            "type": "routine-sweep", "runId": runtime_id, "message": markers["conversation"],
            "model": {"input": markers["prompt"], "output": markers["completion"]},
            "tools": [{"arguments": markers["tool-input"], "result": markers["tool-output"]}],
            "nested": {"message": markers["nested"]}, "serialized": json.dumps({"value": markers["encoded"]}),
            "error": f"TypeError: {markers['exception']}", "authorization": f"Bearer {markers['credential']}",
        }
        docker(*app, "exec", "-T", "server", "sh", "-c", "cat > /proc/1/fd/1",
               text=json.dumps(record_data) + "\n")
        docker(*app, "exec", "-T", "server", "sh", "-c", "cat > /proc/1/fd/2",
               text=f"unstructured failure {markers['plain']}\n")
        audit = {"resourceLogs": [{"resource": {"attributes": [{"key": "untrusted", "value": {"stringValue": markers["audit"]}}]},
                 "scopeLogs": [{"scope": {"name": markers["audit"]}, "logRecords": [{
                     "timeUnixNano": str(time.time_ns()), "severityNumber": 13,
                     "body": {"stringValue": markers["audit"]},
                     "attributes": [{"key": "openbot.event_type", "value": {"stringValue": "configuration.changed"}},
                                    {"key": "openbot.target_id", "value": {"stringValue": runtime_id}},
                                    {"key": "openbot.payload.nested", "value": {"stringValue": markers["audit"]}}]
                 }]}]}]}
        docker(*app, "exec", "-T", "server", "bun", "-e",
               'const response = await fetch("http://otel-collector:4318/v1/logs", '
               '{method:"POST",headers:{"Content-Type":"application/json"},body:await Bun.stdin.text()}); '
               'if (!response.ok) process.exit(1);', text=json.dumps(audit))

        # A real computer, created by the real supervisor through its published API. Its logs reach
        # the collector through the LogConfig the supervisor set at create time, so this exercises
        # the dynamic path a per-Bot computer takes in a live deployment.
        computer_bot = "logcheck1"
        computer_container = f"{stack}-computer-bot-{computer_bot}"
        ensure_code, _ = http(f"http://127.0.0.1:{supervisor_port}",
                              f"/computers/bot/{computer_bot}/ensure", {},
                              auth=f"Bearer {SUPERVISOR_TOKEN}", method="POST", timeout=240)
        require(ensure_code == 200, "the real supervisor ensured a dynamic computer over its API")
        log_config = json.loads(docker("inspect", "--format", "{{json .HostConfig.LogConfig}}",
                                       computer_container).stdout)
        require(log_config.get("Type") == "fluentd" and
                log_config.get("Config", {}).get("tag") == "openbot.computer",
                "the dynamic computer was created with the fluentd driver and a fixed tag")
        record("dynamic-computer.json",
               {"container": computer_container, "log_config": log_config})

        missing = lambda records: set(SOURCES) - {hit.get("service_name") for hit in records}
        runtime_sql = 'SELECT * FROM "openbot_runtime" WHERE log_class = \'runtime\''
        def runtime_ready():
            rows = hits(runtime_sql)
            return rows if not missing(rows) else None
        runtime = retry(runtime_ready, "runtime logs from all seven real services")
        require(not missing(runtime), "Docker runtime records queryable for " + ", ".join(SOURCES))
        require({r.get("severity") for r in runtime} >= {"Info", "Error"}, "Info and Error queryable")
        require(any(r.get("openbot_log_type") == "routine-sweep" and r.get("service_name") == "worker"
                    for r in runtime), "ordinary worker sweep is queryable")
        require(any(r.get("openbot_log_type") == "postgres-ready" for r in runtime),
                "PostgreSQL readiness on the real Docker log stream")
        audited = retry(lambda: hits('SELECT * FROM "openbot_audit" WHERE log_class = \'audit\''),
                        "server audit OTLP ingested")
        require(any(r.get("openbot_event_type") == "configuration.changed" and
                    r.get("openbot_target_id") != runtime_id for r in audited),
                "real settings audit record reached OpenObserve")
        require(not hits('SELECT * FROM "openbot_runtime" WHERE log_class = \'audit\''),
                "audit records do not appear in the runtime stream")
        require(not hits('SELECT * FROM "openbot_audit" WHERE log_class = \'runtime\''),
                "runtime records do not appear in the audit stream")
        for stream, days in (("openbot_runtime", 30), ("openbot_audit", 90)):
            code, _ = http(query_url, f"/api/default/streams/{stream}/settings",
                           {"data_retention": days}, operator, method="PUT")
            if code != 200:
                raise RuntimeError(f"per-stream retention PUT for {stream} returned HTTP {code}")
        code, streams = http(query_url, "/api/default/streams", None, operator)
        readback = {s["name"]: (s.get("settings") or {}).get("data_retention")
                    for s in streams.get("list", [])}
        require(readback.get("openbot_runtime") == 30 and readback.get("openbot_audit") == 90,
                "per-stream retention read back as 30 and 90 days")
        record("retention.json", readback)
        matching = retry(lambda: hits(f'SELECT * FROM "openbot_runtime" WHERE run_id = \'{runtime_id}\''),
                         "positive runtime marker")
        require(matching[0].get("body") == "routine-sweep", "sanitized runtime record kept its correlation ID")
        retry(lambda: hits(f'SELECT * FROM "openbot_audit" WHERE openbot_target_id = \'{runtime_id}\' AND severity = \'Warn\''),
              "sanitized audit fixture was ingested as Warn")
        old_status, old_result = search(f"""SELECT * FROM "openbot_runtime" WHERE run_id = '{old_id}'""")
        require(old_status == 200 and not old_result.get("hits"),
                "unconfigured and pre-collector container logs are absent")
        retry(lambda: hits("""SELECT * FROM "openbot_runtime" WHERE service_name = 'worker'
                   AND openbot_log_type = 'routine-sweep-tick-failed' AND severity = 'Warn'"""),
              "real worker database failure appears as Warn")
        require(True, "real worker database failure appears as Warn")

        payload = work / "payload.json"
        docker(*obs, "cp", "otel-collector:/var/lib/otelcol/sent-payload.json", str(payload))
        sent = payload.read_text()
        require(runtime_id in sent and "configuration.changed" in sent, "exporter snapshot contains the positive controls")
        require(all(marker not in sent for marker in markers.values()) and ingest_token not in sent,
                "sensitive fixtures and ingestion credentials absent from the exporter snapshot")
        code, query = search('SELECT * FROM "openbot_runtime"')
        require(code == 200 and query.get("hits") and all(marker not in json.dumps(query)
                for marker in markers.values()), "sensitive fixtures absent from full stored OpenObserve records")

        def login(name, secret, send=urlopen):
            return http(query_url, "/auth/login", {"name": name, "password": secret}, send=send)

        def browser_session():
            return build_opener(HTTPCookieProcessor(CookieJar())).open

        admin_browser = browser_session()
        admin_status, admin_login = login(email, password, admin_browser)
        require(admin_status == 200 and admin_login.get("status") is True,
                "administrator can sign in through the UI endpoint")
        plan = 'SELECT * FROM "openbot_audit"'
        ui_status, ui_result = search(plan, None, send=admin_browser)
        require(ui_status == 200 and ui_result.get("hits"), "administrator's UI session can query stored logs")
        statuses = {
            "administrator_search": search(plan)[0],
            "anonymous_search": search(plan, None)[0],
            "wrong_password_search": search(plan, basic(email, "wrong-password"))[0],
            "ingest_token_search": search(plan, basic("default", ingest_token))[0],
            "ingest_token_user_list": http(query_url, "/api/default/users", auth=basic("default", ingest_token))[0],
        }
        require(statuses["administrator_search"] == 200 and all(
                status in {401, 403} for label, status in statuses.items() if label != "administrator_search"),
                "administrator query succeeds; anonymous, wrong password, and ingest token are denied")
        require(login("default", ingest_token)[1].get("status") is not True, "ingestion token cannot sign in to the UI")
        outsider = "different-org@example.invalid"
        other_secret = "Az1!" + secrets.token_urlsafe(28)
        member_code, member = http(query_url, "/api/default/users",
                                   {"email": outsider, "password": other_secret, "role": "member"}, operator)
        require(member_code == 400 and "Custom roles not allowed" in json.dumps(member),
                "OSS rejects a same-organization basic member account")
        org_code, org = http(query_url, "/api/organizations", {"name": "different_organization"}, operator)
        require(org_code in {200, 201} and org.get("identifier"), "created an unrelated organization for the access probe")
        account_code, _ = http(query_url, f"/api/{org['identifier']}/users",
                               {"email": outsider, "password": other_secret, "role": "admin"}, operator)
        outsider_browser = browser_session()
        require(account_code in {200, 201} and login(outsider, other_secret, outsider_browser)[1].get("status") is True,
                "the outsider is a real authenticated OpenObserve user")
        statuses["other_organization_search"] = search(plan, basic(outsider, other_secret))[0]
        statuses["other_organization_ui_search"] = search(plan, None, send=outsider_browser)[0]
        require(all(statuses[label] in {401, 403} for label in ("other_organization_search", "other_organization_ui_search")),
                "authenticated user from a different organization cannot query OpenBot data")
        record("access-status.json", statuses)

        docker(*obs, "restart", "openobserve", "otel-collector")
        retry(lambda: http(query_url, "/healthz")[0] == 200, "OpenObserve after restart")
        retry(lambda: hits(f'SELECT * FROM "openbot_runtime" WHERE run_id = \'{runtime_id}\''), "retained record after restart")
        docker(*app, "exec", "-T", "server", "sh", "-c", "cat > /proc/1/fd/1",
               text=json.dumps({"type": "routine-sweep", "runId": second_id}) + "\n")
        retry(lambda: hits(f'SELECT * FROM "openbot_runtime" WHERE run_id = \'{second_id}\''), "new record after restart")
        require(True, "stored records survive restart and new ones arrive")
        record("result.json", {"runtime_services": sorted(set(r["service_name"] for r in runtime)),
               "runtime_records": len(runtime), "redaction_fixtures": len(markers), "access": statuses,
               "restart": "pass"})
    except subprocess.CalledProcessError as error:
        # Keep container diagnostics in the private evidence directory, without rendering config.
        (work / "command-errors.log").write_text((error.stdout or "") + (error.stderr or ""))
        raise RuntimeError(f"Docker command failed (exit {error.returncode}); see {work}/command-errors.log") from None
    finally:
        if not keep:
            leftovers = [unrelated, failing_worker] + ([computer_container] if computer_container else [])
            docker("container", "rm", "-f", *leftovers, check=False)
            docker(*obs, "down", "-v", check=False)
            docker(*app, "down", "-v", check=False)


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--build", action="store_true", help="build application images from this checkout")
    parser.add_argument("--keep", action="store_true", help="retain the disposable Docker projects for debugging")
    args = parser.parse_args()
    directory = Path(tempfile.mkdtemp(prefix="openobserve-docker-"))
    print(f"Evidence directory: {directory}", flush=True)
    verify(directory, args.build, args.keep)
