"""Exercise the shipped Docker forwarding, collector, capture-forwarder, and OpenObserve configuration against the real services."""
import argparse
import base64
from http.cookiejar import CookieJar
import json
import os
from pathlib import Path
import re
import secrets
import shutil
import socket
import subprocess
import tempfile
import threading
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
# Every source this ticket commits to covering, with the queryable evidence each one must show.
# `computer` is the supervisor-created dynamic computer, not the fixed agent-computer service.
SOURCES = ("postgres", "migrate", "server", "worker", "agent-bot", "agent-langgraph", "agent-computer",
           "supervisor", "spire-server", "spire-agent", "computer")
# The compose default: the token the supervisor's caller must present.
SUPERVISOR_TOKEN = "openbot-dev-supervisor-token"


def require(condition, message):
    if not condition:
        raise RuntimeError(message)
    print(f"PASS {message}", flush=True)


def retry(check, description, timeout=100):
    deadline = time.monotonic() + timeout
    last = None
    while time.monotonic() < deadline:
        try:
            result = check()
            if result:
                return result
        except (URLError, TimeoutError, ConnectionError, RuntimeError) as error:
            last = error
        time.sleep(1)
    raise RuntimeError(f"Timed out: {description}" + (f" ({last})" if last else ""))


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


def _varint(data, index):
    result = shift = 0
    while True:
        if index >= len(data) or shift > 63:
            return None, index
        byte = data[index]
        index += 1
        result |= (byte & 0x7F) << shift
        if not byte & 0x80:
            return result, index
        shift += 7


def wire_strings(data):
    """Every text value carried anywhere in an OTLP protobuf body.

    A generic wire-format walk, not a schema decode: for each length-delimited field the chunk is
    both tried as a nested message and, when it decodes to printable UTF-8, taken as text. Over-
    collecting is harmless here — the assertion is that a marker does not appear anywhere, so any
    field a schema decoder might reach is covered, including resource, scope, event_name and
    attribute keys the collector's own transforms touch.
    """
    strings = []
    index = 0
    while index < len(data):
        tag, index = _varint(data, index)
        if tag is None:
            break
        wire, field = tag & 7, tag >> 3
        if field == 0:
            break
        if wire == 0:
            _, index = _varint(data, index)
            if _ is None:
                break
        elif wire == 1:
            index += 8
        elif wire == 5:
            index += 4
        elif wire == 2:
            length, index = _varint(data, index)
            if length is None or index + length > len(data):
                break
            chunk = data[index:index + length]
            index += length
            if chunk:
                strings.extend(wire_strings(chunk))
                try:
                    text = chunk.decode("utf-8")
                    if len(text) >= 3 and all(c.isprintable() or c in "\n\r\t" for c in text):
                        strings.append(text)
                except UnicodeDecodeError:
                    pass
        else:
            break
    return strings


class CaptureForwarder:
    """Accepts the collector's OTLP HTTP traffic, records every request body, and re-forwards it.

    This is what makes the redaction check about what was actually sent: the bodies read here are
    the request bodies the collector put on the wire to OpenObserve, not a snapshot written beside
    the exporters. Authorization headers are forwarded but never recorded.
    """

    def __init__(self, upstream):
        from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
        self.upstream = upstream
        self.requests = []
        self.lock = threading.Lock()

        class Handler(BaseHTTPRequestHandler):
            def log_message(self, *_args):
                pass

            def do_POST(self):
                length = int(self.headers.get("Content-Length", "0"))
                body = self.rfile.read(length)
                with self.server.forwarder.lock:
                    self.server.forwarder.requests.append({
                        "path": self.path,
                        "stream": self.headers.get("stream-name"),
                        "content_type": self.headers.get("Content-Type"),
                        "content_encoding": self.headers.get("Content-Encoding"),
                        "authorized": self.headers.get("Authorization") is not None,
                        "body": body,
                    })
                request = Request(self.server.forwarder.upstream + self.path, body,
                                  {key: value for key, value in self.headers.items()
                                   if key.lower() != "host"},
                                  method="POST")
                try:
                    with urlopen(request, timeout=15) as response:
                        status, payload = response.status, response.read()
                        content_type = response.headers.get("Content-Type", "application/json")
                except HTTPError as error:
                    status, payload = error.code, error.read()
                    content_type = error.headers.get("Content-Type", "application/json")
                except (URLError, OSError):
                    status, payload = 503, b"upstream unavailable"
                    content_type = "text/plain"
                self.send_response(status)
                self.send_header("Content-Type", content_type)
                self.send_header("Content-Length", str(len(payload)))
                self.end_headers()
                self.wfile.write(payload)

        self.server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
        self.server.forwarder = self
        self.thread = threading.Thread(target=self.server.serve_forever, daemon=True)

    @property
    def port(self):
        return self.server.server_address[1]

    def start(self):
        self.thread.start()

    def stop(self):
        self.server.shutdown()

    def summary(self):
        with self.lock:
            return [{key: value for key, value in entry.items() if key != "body"}
                    for entry in self.requests]

    def bodies(self):
        """Decoded text of every captured request body, per stream."""
        out = {}
        with self.lock:
            for entry in self.requests:
                data = entry["body"]
                if entry["content_encoding"] == "gzip":
                    import gzip
                    data = gzip.decompress(data)
                out.setdefault(entry["stream"] or "unknown", []).extend(wire_strings(data))
        return out


class ModelMock:
    """The isolated model, tool-callback and Intelligence endpoint, on the host.

    The Bots dial this as their model endpoint and, for a deployment-run tool, as the callback the
    platform grants (`OPENBOT_TOOL_URL`); the server dials it as Intelligence, the thread-lock and
    history service every headless turn requires. Everything a real turn produces therefore crosses
    a real boundary — model input leaves a Bot over HTTP, model output comes back streamed, tool
    arguments travel to a callback and the result returns into the model — which is what makes the
    redaction check about the paths, not about fixtures a script wrote to stdout itself.

    Request bodies are kept only as the marker keys they carried, never verbatim, and headers are
    not read at all: a live credential riding a request is forwarded nowhere and recorded nowhere.
    """

    def __init__(self, marker_keys, crash_trigger, tool_trigger, tool_delay_seconds=10):
        from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
        self.marker_keys = marker_keys          # key -> value; recorded as keys only
        self.crash_trigger = crash_trigger
        self.tool_trigger = tool_trigger
        self.tool_delay_seconds = tool_delay_seconds
        # {"path": ..., "marker_keys_seen": [...], "tool_callback": bool, "completed": bool}
        self.received = []
        self.lock = threading.Lock()
        mock = self

        class Handler(BaseHTTPRequestHandler):
            def log_message(self, *_args):
                pass

            def _json(self, code, body):
                data = b"" if body is None else json.dumps(body).encode()
                self.send_response(code)
                self.send_header("Content-Type", "application/json")
                self.send_header("Content-Length", str(len(data)))
                self.end_headers()
                if data:
                    self.wfile.write(data)

            def _note(self, body_text, callback):
                seen = sorted(key for key, value in mock.marker_keys.items()
                              if value in body_text)
                triggers = [name for name, needle in (("crash", mock.crash_trigger),
                                                      ("tool", mock.tool_trigger))
                            if needle in body_text]
                with mock.lock:
                    mock.received.append({"path": self.path, "marker_keys_seen": seen,
                                          "triggers": triggers, "tool_callback": callback,
                                          "completed": False})

            def _sse(self, chunks):
                self.send_response(200)
                self.send_header("Content-Type", "text/event-stream")
                self.end_headers()
                for delta, finish in chunks:
                    chunk = {"id": "chatcmpl-verify", "object": "chat.completion.chunk",
                             "choices": [{"index": 0, "delta": delta, "finish_reason": finish}]}
                    self.wfile.write(f"data: {json.dumps(chunk)}\n\n".encode())
                self.wfile.write(b"data: [DONE]\n\n")
                self.wfile.flush()

            def do_POST(self):
                body = self.rfile.read(int(self.headers.get("Content-Length", "0")))
                try:
                    text, payload = body.decode("utf-8", "ignore"), json.loads(body or b"{}")
                except ValueError:
                    text, payload = body.decode("utf-8", "ignore"), {}
                if self.path.endswith("/chat/completions"):
                    self._note(text, callback=False)
                    messages = payload.get("messages") or []
                    saw_tool_result = any(m.get("role") == "tool" for m in messages)
                    if saw_tool_result:
                        # The turn after a tool callback: the model answers on what it got back.
                        self._sse([({"role": "assistant",
                                     "content": mock.marker_keys["model-output"]}, "stop")])
                    elif mock.tool_trigger in text:
                        # The tool boundary: the model reaches for a deployment tool, arguments and all.
                        self._sse([({"role": "assistant", "tool_calls": [{
                            "id": "call_verify_1", "type": "function", "index": 0,
                            "function": {"name": "get_current_time",
                                         "arguments": json.dumps(
                                             {"query": mock.marker_keys["tool-params"]})}}]},
                            "tool_calls")])
                    else:
                        if mock.crash_trigger in text:
                            # Hold the turn open so the run is provably in flight when the
                            # database is stopped underneath it.
                            time.sleep(mock.tool_delay_seconds)
                        self._sse([({"role": "assistant",
                                     "content": mock.marker_keys["model-output"]}, "stop")])
                    with mock.lock:
                        mock.received[-1]["completed"] = True
                elif "agent-tools/call" in self.path:
                    # A real tool callback: the Bot forwarded {name, args, run} to the deployment.
                    self._note(text, callback=True)
                    data = json.dumps({"text": mock.marker_keys["tool-result"]}).encode()
                    self.send_response(200)
                    self.send_header("Content-Type", "application/json")
                    self.send_header("Content-Length", str(len(data)))
                    self.end_headers()
                    self.wfile.write(data)
                    with mock.lock:
                        mock.received[-1]["completed"] = True
                else:
                    status, response = self._intelligence_response()
                    self._json(status, response)

            def do_GET(self):
                if self.headers.get("Upgrade", "").lower() == "websocket":
                    self._websocket()
                    return
                status, response = self._intelligence_response()
                self._json(status, response)

            # ---- A minimal Phoenix channel over WebSocket. ----
            #
            # The turn runner drives every run over the gateway socket: it connects, joins the
            # thread's channel and waits for the join reply before the run starts, then expects an
            # ack (phx_reply ok) per pushed event. The gateway here accepts and acks everything,
            # which is all the client needs to run the turn against the Bot.

            def _ws_send(self, message):
                frame = json.dumps(message).encode()
                header = bytearray([0x81])
                length = len(frame)
                if length < 126:
                    header.append(length)
                elif length < 65536:
                    header += bytes([126, length >> 8, length & 0xFF])
                else:
                    header += bytes([127]) + length.to_bytes(8, "big")
                self.wfile.write(bytes(header) + frame)
                self.wfile.flush()

            def _websocket(self):
                import hashlib
                key = self.headers.get("Sec-WebSocket-Key", "")
                accept = base64.b64encode(
                    hashlib.sha1((key + "258EAFA5-E914-47DA-95CA-C5AB0DC85B11").encode()).digest()
                ).decode()
                # RFC 6455 requires the upgrade to be spoken over HTTP/1.1; the handler's default
                # is 1.0, and a client that reads a 1.0 status line closes and dials again.
                self.protocol_version = "HTTP/1.1"
                self.close_connection = True
                self.send_response(101, "Switching Protocols")
                self.send_header("Upgrade", "websocket")
                self.send_header("Connection", "Upgrade")
                self.send_header("Sec-WebSocket-Accept", accept)
                requested_protocol = self.headers.get("Sec-WebSocket-Protocol")
                if requested_protocol:
                    # The client offers "phoenix" and "base64url.bearer.phx.<token>": the bearer
                    # protocol is how the runner authenticates this socket, and selecting it is
                    # what tells the client the connection may carry its channel.
                    bearer = next((candidate.strip() for candidate in requested_protocol.split(",")
                                   if candidate.strip().startswith("base64url.bearer.")), None)
                    self.send_header("Sec-WebSocket-Protocol",
                                     bearer or requested_protocol.split(",")[0].strip())
                self.end_headers()
                try:
                    while True:
                        frame = self._ws_read()
                        if frame is None:
                            return
                        opcode, payload = frame
                        if opcode == 8:          # close
                            self.wfile.write(b"\x88\x00")
                            self.wfile.flush()
                            return
                        if opcode == 9:          # ping -> pong
                            self.wfile.write(bytes([0x8A, len(payload)]) + payload)
                            self.wfile.flush()
                            continue
                        if opcode not in (1, 2):
                            continue
                        try:
                            message = json.loads(payload.decode("utf-8", "ignore"))
                        except ValueError:
                            continue
                        ref = message.get("ref")
                        topic = message.get("topic", "")
                        if ref is not None:
                            self._ws_send({"topic": topic, "event": "phx_reply",
                                           "payload": {"status": "ok", "response": {}},
                                           "ref": ref})
                except (OSError, ValueError):
                    return

            def _ws_read(self):
                header = self._ws_read_exact(2)
                if header is None:
                    return None
                opcode = header[0] & 0x0F
                masked = header[1] & 0x80
                length = header[1] & 0x7F
                if length == 126:
                    extended = self._ws_read_exact(2)
                    if extended is None:
                        return None
                    length = int.from_bytes(extended, "big")
                elif length == 127:
                    extended = self._ws_read_exact(8)
                    if extended is None:
                        return None
                    length = int.from_bytes(extended, "big")
                mask = self._ws_read_exact(4) if masked else b"\x00\x00\x00\x00"
                if mask is None:
                    return None
                payload = self._ws_read_exact(length) if length else b""
                if payload is None:
                    return None
                if masked:
                    payload = bytes(b ^ mask[i % 4] for i, b in enumerate(payload))
                return opcode, payload

            def _ws_read_exact(self, count):
                data = b""
                while len(data) < count:
                    chunk = self.rfile.read(count - len(data))
                    if not chunk:
                        return None
                    data += chunk
                return data

            def do_PATCH(self):
                status, response = self._intelligence_response()
                self._json(status, response)

            def do_DELETE(self):
                self._json(200, {})

            def _intelligence_response(self):
                """The small REST surface a headless turn reads from Intelligence.

                The client creates the thread when the GET reads 404, reads empty history, and
                holds a per-thread lock over the turn. Authenticated requests are answered from
                their path alone; credentials are neither checked nor recorded.
                """
                path = self.path.split("?")[0]
                if path == "/api/entitlements/runtime":
                    return 200, {"entitlements": []}
                if path.endswith("/connect"):
                    # No live client channel: an empty body reads as null, so the stop path and
                    # the join fast path see "nobody is watching" instead of a phantom connection.
                    return 200, None
                if path.endswith("/lock"):
                    return 200, {}
                if path == "/api/threads":
                    return 200, {"thread": {"threadId": "verify-thread"}}
                if "/messages" in path:
                    return 200, {"messages": []}
                if path.startswith("/api/threads/"):
                    # getOrCreateThread: a 404 first, then the POST create makes the thread.
                    return (404, {}) if self.command == "GET" else (200, {})
                return 200, {}

        self.server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
        self.thread = threading.Thread(target=self.server.serve_forever, daemon=True)

    @property
    def port(self):
        return self.server.server_address[1]

    def start(self):
        self.thread.start()

    def stop(self):
        self.server.shutdown()

    def state(self):
        with self.lock:
            return [dict(entry) for entry in self.received]


def verify(work, build, keep):
    stack = f"oo-verify-{secrets.token_hex(4)}"
    (query_port, forward_port, app_port, server_port, postgres_port, bot_port,
     langgraph_port, computer_port, supervisor_port) = ports(9)
    app_url, query_url = f"http://127.0.0.1:{server_port}", f"http://127.0.0.1:{query_port}"
    email, password = "operator@example.invalid", "Az1!" + secrets.token_urlsafe(28)
    operator = basic(email, password)
    start = int((time.time() - 60) * 1_000_000)
    env = {key: value for key, value in os.environ.items()
           if key in {"PATH", "HOME", "TMPDIR", "DOCKER_HOST", "DOCKER_CONTEXT", "DOCKER_CONFIG"}}
    # Real credentials minted for this run: they exist in real service environments, so they are
    # the strongest redaction fixtures — if any path ever leaks a live secret, these catch it.
    computer_token, worker_secret = secrets.token_hex(24), secrets.token_hex(24)
    managed_token, key_encryption_key = secrets.token_hex(24), base64.b64encode(secrets.token_bytes(32)).decode()
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
        MANAGED_AGENT_TOKEN=managed_token, AGENT_TOOL_TOKEN=secrets.token_hex(24),
        COMPUTER_TOKEN=computer_token, WORKER_SHARED_SECRET=worker_secret,
        KEY_ENCRYPTION_KEY=key_encryption_key,
        COMPUTER_SUPERVISOR_CONTAINER_URL="", OPENAI_CONTAINER_BASE_URL="http://127.0.0.1:1",
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
  agent-bot:
    # The server, the framework Bot and the computer service already declare the host gateway in
    # the base file; the proof-of-concept Bot does not, and its model endpoint lives on this host.
    extra_hosts:
      - "host.docker.internal:host-gateway"
  supervisor:
    environment:
      # This host may run a real deployment beside this test; a namespace of its own keeps the
      # computer created here out of that deployment's ownership checks and cleanup.
      COMPUTER_NAMESPACE: {stack}
""")
    # Phase one: the supervisor runs without log forwarding, exactly like a desktop or CLI host and
    # like any deployment that has not turned this ticket's setting on yet.
    no_forward = work / "verify.no-forward.compose.yml"
    no_forward.write_text("""
services:
  supervisor:
    environment:
      COMPUTER_LOG_FORWARD_ADDRESS: ""
""")
    obs_override = work / "verify.obs.compose.yml"
    obs_override.write_text("""
services:
  otel-collector:
    extra_hosts:
      - "host.docker.internal:host-gateway"
""")
    empty_env = work / "empty.env"
    empty_env.touch()
    compose = compose_command()
    app = ("compose", "--env-file", str(empty_env), "-p", stack, "--profile", "openbot", "-f", str(ROOT / "docker-compose.yml"),
           "-f", str(OBS / "openbot-logging.compose.yml"), "-f", str(override))
    app_no_forward = (*app, "-f", str(no_forward))
    obs = ("compose", "--env-file", str(empty_env), "-p", f"{stack}-obs", "-f", str(OBS / "compose.yml"),
           "-f", str(obs_override))
    # Compose needs the app network while the collector comes up, before any application starts logging.
    unrelated = f"{stack}-unrelated"
    failing_worker = f"{stack}-worker-database-fault"
    namespace = stack
    carry_bot, cutover_bot, person_id = "carrynotes1", "cutoverbot1", "ada2"
    legacy_container = f"{namespace}-computer-{carry_bot}"
    legacy_profile_volume = f"{namespace}-profile-{carry_bot}"
    legacy_workspace_volume = f"{namespace}-workspace-{carry_bot}"
    cutover_container = f"{namespace}-computer-bot-{cutover_bot}"
    person_container = f"{namespace}-computer-person-{person_id}"
    forwarder = CaptureForwarder(f"http://127.0.0.1:{query_port}")
    # A legacy bot id, kept: the carry-over copies this bot's old profile onto its owner's computer.
    secret_note = {"kind": "capture-forwarder", "upstream": query_url}
    old_id, edge_id = (str(uuid4()) for _ in range(2))
    markers = {key: f"private-{key}-{uuid4()}" for key in
               ("conversation", "prompt", "tool-input", "tool-params", "tool-result",
                "model-output", "nested", "encoded", "exception", "plain", "outage")}
    # Correlation triggers, not secrets: they mark which real turn is the crash window and which
    # direct Bot run must reach for a deployment tool. They ride inside real model input, so the
    # scan treats them like the markers — absent from every outbound payload and stored record.
    crash_trigger, tool_trigger = f"crash-window-{uuid4()}", f"tool-loop-{uuid4()}"
    credentials = {"computer_token": computer_token, "worker_shared_secret": worker_secret,
                   "managed_agent_token": managed_token, "key_encryption_key": key_encryption_key}
    evidence_sources = {}
    # The isolated model/tool endpoint the real Bots call. Started before any app container, so a
    # Bot's first real turn crosses a real model boundary inside this run.
    mock = ModelMock(markers, crash_trigger, tool_trigger)
    mock.start()
    env["OPENAI_CONTAINER_BASE_URL"] = f"http://host.docker.internal:{mock.port}/v1"
    # Where the framework Bot runs a deployment tool: the same mock, playing the platform's
    # callback endpoint, so the arguments travel a real HTTP callback and the result returns
    # through the model a second time.
    env["OPENBOT_TOOL_URL"] = f"http://host.docker.internal:{mock.port}/agent-tools/call"
    # Intelligence is a required dependency of every headless turn (the thread lock and history
    # live there); this stack answers it from the same host mock so a real turn can actually run.
    env["INTELLIGENCE_CONTAINER_API_URL"] = f"http://host.docker.internal:{mock.port}"
    env["INTELLIGENCE_CONTAINER_GATEWAY_WS_URL"] = f"ws://host.docker.internal:{mock.port}"
    (work / "test-run.json").write_text(json.dumps(
        {"project": stack, "query_port": query_port, "required_sources": SOURCES,
         "forwarder": secret_note}, indent=2) + "\n")

    def search(sql, auth=operator, send=urlopen, start_time=start, end_time=None):
        return http(query_url, "/api/default/_search",
                    {"query": {"sql": sql, "start_time": start_time,
                               "end_time": end_time or int(time.time() * 1_000_000), "size": 1000}},
                    auth, send=send)

    def hits(sql, **kwargs):
        code, result = search(sql, **kwargs)
        return result.get("hits", []) if code == 200 else []

    def all_hits(sql, **kwargs):
        """Repeated read, because a single page is not evidence that nothing else is stored.

        OpenObserve ranks full-scan matches by score, so identical queries are issued and the
        pages deduplicated here until nothing new comes back.
        """
        collected, seen = [], set()
        for _ in range(12):
            code, result = search(sql, **kwargs)
            page = result.get("hits", []) if code == 200 else []
            fresh = [row for row in page if json.dumps(row, sort_keys=True) not in seen]
            if not fresh:
                break
            seen.update(json.dumps(row, sort_keys=True) for row in fresh)
            collected.extend(fresh)
            if len(fresh) < 1000:
                break
        return collected

    def record(name, data):
        (work / name).write_text(json.dumps(data, indent=2, sort_keys=True) + "\n")

    try:
        # Disable the shared checkout's .env and host mounts. The attached services use test data.
        docker("network", "create", "--label", f"com.docker.compose.project={stack}",
               "--label", "com.docker.compose.network=data", f"{stack}_data")
        docker(*obs, "up", "-d", "openobserve")
        retry(lambda: http(query_url, "/healthz")[0] == 200, "OpenObserve health")
        code, outcome = http(query_url, "/api/default/ingestion-tokens", {"name": stack, "description": ""},
                             operator)
        if code not in (200, 201):
            raise RuntimeError(f"Could not issue ingest-only token: HTTP {code}")
        ingest_token = outcome["data"]["token"]
        ingest_basic = basic("default", ingest_token).split(" ", 1)[1]
        env["OO_INGEST_BASIC"] = ingest_basic
        require(ingest_token.startswith("o2oi_"), "OpenObserve issued its native ingestion token")
        credentials["ingest_token"] = ingest_token

        # A container outside the overlay, started before the collector, writing a JSON line: its
        # logs are locally present and never ingested, which is the not-configured boundary.
        docker("run", "-d", "--name", unrelated, "alpine", "sh", "-c",
               f"echo '{{\"type\":\"routine-sweep\",\"runId\":\"{old_id}\"}}'; sleep 900")
        forwarder.start()
        env["OO_INGEST_ENDPOINT"] = f"http://host.docker.internal:{forwarder.port}/api/default"
        docker(*obs, "up", "-d", "otel-collector")
        retry(lambda: "Everything is ready" in docker(*obs, "logs", "otel-collector").stdout,
              "collector running against the capture forwarder", timeout=240)
        require(True, "collector running against the capture forwarder")
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
        postgres_config = {}
        for setting in ("log_min_messages", "client_min_messages"):
            ran = docker(*app, "exec", "-T", "postgres", "psql", "-U", "openbot", "-d", "openbot",
                         "-tAc", f"SHOW {setting}", check=False)
            postgres_config[setting] = ran.stdout.strip()
        docker(*app, "up", "--no-deps", "--exit-code-from", "migrate", "migrate")
        docker(*app, "up", "-d", "--no-deps", "server", "worker", "agent-bot", "agent-langgraph", "agent-computer")
        retry(lambda: http(app_url, "/health")[0] == 200, "OpenBot server health", timeout=300)
        require(True, "OpenBot server health")
        docker(*app, "run", "-d", "--no-deps", "--name", failing_worker,
               "-e", "DATABASE_URL=postgres://openbot:openbot@127.0.0.1:1/openbot", "worker")
        for service, port in zip(("agent-bot", "agent-langgraph", "agent-computer"),
                                 (bot_port, langgraph_port, computer_port)):
            retry(lambda: http(f"http://127.0.0.1:{port}", "/health")[0] == 200, f"{service} health", timeout=300)
            require(True, f"{service} health")
        worker_logs = docker(*app, "logs", "--tail", "15", "worker")
        (work / "worker-startup-logs.txt").write_text(worker_logs.stdout + worker_logs.stderr)
        require("worker status" in (worker_logs.stdout + worker_logs.stderr),
                "the real worker process started and entered its sweep loop")

        # The legacy computer of a pre-one-per-person Bot: volumes carrying the legacy labels
        # (owner + namespace + bot id, and no kind label). A running container for them is started
        # once the phase-one supervisor is up, so the phase-two restart is what retires it.
        for volume in (legacy_profile_volume, legacy_workspace_volume):
            docker("volume", "create", "--label", "openbot.supervisor=true",
                   "--label", f"openbot.namespace={namespace}",
                   "--label", f"openbot.bot-id={carry_bot}", volume)

        # spire-init is a one-shot chown. Its coverage boundary is recorded from the real container:
        # exit status and captured logs, not a configuration claim.
        def spire_init_state():
            state = json.loads(docker("inspect", "--format", "{{json .State}}",
                                      f"{stack}-spire-init-1").stdout)
            return state if state["Status"] == "exited" else None
        docker(*app, "up", "-d", "--no-deps", "spire-init")
        spire_state = retry(spire_init_state, "spire-init one-shot completed", timeout=120)
        spire_init_logs = docker("logs", f"{stack}-spire-init-1")
        spire_init_tag = json.loads(docker("inspect", "--format", "{{json .HostConfig.LogConfig}}",
                                           f"{stack}-spire-init-1").stdout)
        record("spire-init.json", {
            "status": spire_state["Status"], "exit_code": int(spire_state["ExitCode"]),
            "log_lines": len((spire_init_logs.stdout + spire_init_logs.stderr).splitlines()),
            "log_config": spire_init_tag,
            "boundary": "one-shot chown that produces no log lines on success; the fluentd tag is "
                        "registered and any future output would be ingested",
        })
        require(spire_state["ExitCode"] == 0 and
                not (spire_init_logs.stdout + spire_init_logs.stderr).strip() and
                spire_init_tag.get("Type") == "fluentd",
                "spire-init completed silently with the fluentd driver attached (boundary recorded)")
        docker(*app, "up", "-d", "spire-server", "spire-agent")

        # Phase one: the supervisor runs without forwarding, exactly like a desktop or CLI host and
        # like any deployment that has not turned this ticket's setting on yet.
        docker(*app_no_forward, "up", "-d", "--no-deps", "supervisor")
        retry(lambda: http(f"http://127.0.0.1:{supervisor_port}", "/health")[0] == 200,
              "phase one: supervisor running without log forwarding", timeout=240)
        # The legacy computer is started only now, so the phase-two supervisor restart is what
        # retires it and says so on the forwarded stream.
        docker("run", "-d", "--name", legacy_container,
               "--label", "openbot.supervisor=true",
               "--label", f"openbot.namespace={namespace}",
               "--label", f"openbot.bot-id={carry_bot}", "alpine", "sleep", "3600")

        # Phase one of the dynamic-computer cutover: a computer ensured while the deployment has no
        # forwarding, as every computer created before this ticket existed.
        ensure_code, _ = http(f"http://127.0.0.1:{supervisor_port}",
                              f"/computers/bot/{cutover_bot}/ensure", {},
                              auth=f"Bearer {SUPERVISOR_TOKEN}", method="POST", timeout=240)
        require(ensure_code == 200, "phase one: supervisor ensured the computer without forwarding")
        pre_log_config = json.loads(docker("inspect", "--format", "{{json .HostConfig.LogConfig}}",
                                           cutover_container).stdout)
        pre_id = json.loads(docker("inspect", "--format", "{{json .Id}}", cutover_container).stdout)
        pre_mounts = json.loads(docker("inspect", "--format", "{{json .Mounts}}", cutover_container).stdout)
        pre_volumes = sorted(m["Name"] for m in pre_mounts if m["Type"] == "volume")
        pre_logs = docker("logs", cutover_container)
        (work / "computer-pre-cutover-logs.txt").write_text(pre_logs.stdout + pre_logs.stderr)
        require(bool((pre_logs.stdout + pre_logs.stderr).strip()) and pre_log_config.get("Type") != "fluentd",
                "phase one computer ran on the default driver with locally readable logs")
        require(all(v in pre_volumes for v in (f"{namespace}-profile-bot-{cutover_bot}",
                                               f"{namespace}-workspace-bot-{cutover_bot}")),
                "phase one computer kept its profile and workspace volumes")
        time.sleep(3)
        require(not hits('SELECT * FROM "openbot_runtime" WHERE service_name = \'computer\''),
                "no computer logs reached OpenObserve before the cutover")

        # Phase two: the deployment turns forwarding on and the supervisor is recreated. At start it
        # also retires the running legacy computer, which is a real supervisor business event.
        docker(*app_no_forward, "stop", "supervisor", check=False)
        docker(*app, "up", "-d", "--no-deps", "--force-recreate", "supervisor")
        retry(lambda: http(f"http://127.0.0.1:{supervisor_port}", "/health")[0] == 200,
              "phase two: supervisor running with log forwarding", timeout=240)
        ensure_code, _ = http(f"http://127.0.0.1:{supervisor_port}",
                              f"/computers/bot/{cutover_bot}/ensure", {},
                              auth=f"Bearer {SUPERVISOR_TOKEN}", method="POST", timeout=240)
        require(ensure_code == 200, "phase two: the same logical computer re-ensured")
        post_log_config = json.loads(docker("inspect", "--format", "{{json .HostConfig.LogConfig}}",
                                            cutover_container).stdout)
        post_id = json.loads(docker("inspect", "--format", "{{json .Id}}", cutover_container).stdout)
        post_mounts = json.loads(docker("inspect", "--format", "{{json .Mounts}}", cutover_container).stdout)
        post_volumes = sorted(m["Name"] for m in post_mounts if m["Type"] == "volume")
        require(post_log_config.get("Type") == "fluentd" and
                post_log_config.get("Config", {}).get("tag") == "openbot.computer",
                "cutover replaced the computer with the fluentd driver and the fixed tag")
        require(post_id != pre_id, "cutover created a new container run")
        require(post_volumes == pre_volumes, "cutover preserved the profile and workspace volumes")
        def legacy_retired():
            return docker("inspect", "--format", "{{.State.Status}}",
                          legacy_container).stdout.strip() == "exited" or None
        retry(legacy_retired, "the supervisor stopped the legacy computer", timeout=120)
        legacy_state = docker("inspect", "--format", "{{.State.Status}}", legacy_container).stdout.strip()
        require(legacy_state == "exited", "supervisor start stopped the legacy computer")

        # Real person carry-over: the old profile volume is copied onto the owner's computer by the
        # one-shot helper, and the supervisor records the outcome.
        carry_code, carry_body = http(f"http://127.0.0.1:{supervisor_port}",
                                      f"/computers/person/{person_id}/ensure",
                                      {"carryOver": [carry_bot]},
                                      auth=f"Bearer {SUPERVISOR_TOKEN}", method="POST", timeout=300)
        require(carry_code == 200 and carry_body.get("carriedOver", {}).get(carry_bot) == "copied",
                "real carry-over copied the legacy profile onto the person's computer")
        # Read the owner's profile volume directly, the way the supervisor's own helpers do, so the
        # check is about the stored files rather than one container's view of them.
        person_profile_volume = f"{namespace}-profile-person-{person_id}"
        marker_listing = retry(lambda: (lambda ran: ran if ran.returncode == 0 else None)(
            docker("run", "--rm", "-v", f"{person_profile_volume}:/check:ro", "alpine",
                   "sh", "-c", f"ls /check/.openbot-carried-over && test -d /check/{carry_bot}",
                   check=False)), "the carried files are in the owner's profile volume", timeout=60)
        require(carry_bot in (marker_listing.stdout or ""),
                "the carried marker and profile folder exist in the owner's profile volume")
        record("dynamic-computer.json", {
            "cutover": {"bot": cutover_bot, "driver_before": pre_log_config,
                        "driver_after": post_log_config, "container_before": pre_id,
                        "container_after": post_id, "volumes": post_volumes,
                        "pre_cutover_local_log_lines": len((pre_logs.stdout + pre_logs.stderr).splitlines())},
            "carry_over": {"bot": carry_bot, "person": person_id, "outcome": "copied",
                           "legacy_container_state": legacy_state,
                           "legacy_volumes": [legacy_profile_volume, legacy_workspace_volume]},
            "boundary": "computers created before forwarding are replaced at their next ensure, "
                        "keeping profile and workspace volumes; desktop and CLI set no "
                        "COMPUTER_LOG_FORWARD_ADDRESS and keep Docker's default driver",
        })

        # ---- Real business on the real API, with real identifiers carried to OpenObserve. ----
        code, agents = http(app_url, "/api/agents")
        require(code == 200 and agents.get("agents"), "listed the deployment's real agents")
        agent_id = next((a["id"] for a in agents["agents"] if a.get("available")),
                        agents["agents"][0]["id"])
        code, channel = http(app_url, "/api/channels", {"agentIds": [agent_id]})
        require(code == 201 and channel.get("channel", {}).get("id"), "created a real conversation")
        channel_id = channel["channel"]["id"]
        # A quarter-hourly schedule: the cycle meets the routine frequency floor exactly, and the
        # next occurrence lands within fifteen minutes no matter when this run started, so the
        # worker sweep really offers and fires it within this run.
        cron = "*/15 * * * *"
        code, routine = http(app_url, "/api/routines",
                             {"agentId": agent_id, "channelId": channel_id, "cron": cron,
                              "title": "verification routine",
                              "instruction": f"Summarise nothing. {markers['prompt']} {markers['tool-input']}"})
        require(code == 201 and routine.get("routine", {}).get("id"), "created a real scheduled routine")
        routine_id = routine["routine"]["id"]
        code, manual = http(app_url, f"/api/routines/{routine_id}/run", {})
        require(code == 202 and manual.get("runId"), "run now accepted a real routine run over the API")
        manual_run_id = manual["runId"]
        code, _ = http(app_url, "/api/settings/instructions", {"instructions": markers["conversation"]},
                       method="PUT")
        require(code == 200, "real OpenBot settings operation returned HTTP 200")

        # The scheduled routine really fires: the worker offers it, dispatches it over the internal
        # API, and the server opens the run row it owns. Waited for BEFORE the outage window, since
        # a missed hourly cron would otherwise not recur inside this run.
        def scheduled_fired():
            rows = docker(*app, "exec", "-T", "postgres", "psql", "-U", "openbot", "-d", "openbot",
                          "-tAc", f"SELECT id, status FROM routine_runs WHERE routine_id = '{routine_id}'",
                          check=False).stdout.strip()
            schedule_diag = docker(*app, "exec", "-T", "postgres", "psql", "-U", "openbot", "-d", "openbot",
                                   "-tAc", f"SELECT next_run_at, now(), enabled FROM routines "
                                   f"WHERE id = '{routine_id}'", check=False).stdout.strip()
            worker_tail = docker(*app, "logs", "--tail", "10", "worker", check=False)
            (work / "routine-schedule-diagnostic.txt").write_text(
                f"routine: {schedule_diag}\nruns:\n{rows}\nworker log tail:\n"
                + worker_tail.stdout + worker_tail.stderr + "\n")
            return rows if len(rows.splitlines()) >= 2 else None
        run_rows = retry(scheduled_fired, "worker offer + dispatch opened real run rows", timeout=960)
        require(len(run_rows.splitlines()) >= 2,
                "both the scheduled firing and the manual run opened real run rows")

        # Real operations on the two fixed Bots, over their real AG-UI boundary with the isolated
        # model endpoint. These are the model and tool paths exercised as the platform runs them:
        # the Bots dial the model themselves, and the framework Bot runs a deployment tool by
        # calling back through the deployment's tool endpoint.
        agui_input = {
            "threadId": f"verify-{uuid4()}",
            "messages": [{"id": f"m-{uuid4()}", "role": "user",
                          "content": f"Report the time. {markers['conversation']}"}],
            "tools": [{"name": "get_current_time", "description": "returns the current time",
                       "parameters": {"type": "object", "properties": {"query": {"type": "string"}},
                                      "required": ["query"]}}],
            "state": {}, "forwardedProps": {},
        }
        bot_run = dict(agui_input, runId=f"botprobe-{uuid4()}",
                       messages=[{"id": f"m-{uuid4()}", "role": "user",
                                  "content": f"Report the time. {markers['conversation']} {tool_trigger}"}])
        with urlopen(Request(f"http://127.0.0.1:{bot_port}/ag-ui", json.dumps(bot_run).encode(),
                             {"Content-Type": "application/json",
                              "x-openbot-agent-token": managed_token}, method="POST"),
                     timeout=120) as response:
            bot_stream = response.read().decode("utf-8", "ignore")
        require("RUN_FINISHED" in bot_stream and "TOOL_CALL_START" in bot_stream,
                "agent-bot ran a real turn through the model boundary (tool call streamed, run finished)")
        langgraph_run = dict(agui_input, runId=f"lgprobe-{uuid4()}",
                             messages=[{"id": f"m-{uuid4()}", "role": "user",
                                        "content": f"Report the time. {tool_trigger}"}],
                             forwardedProps={"openbotDeploymentTools": ["get_current_time"],
                                             "openbotRun": f"lgassert-{uuid4()}"})
        with urlopen(Request(f"http://127.0.0.1:{langgraph_port}/ag-ui",
                             json.dumps(langgraph_run).encode(),
                             {"Content-Type": "application/json",
                              "x-openbot-agent-token": managed_token}, method="POST"),
                     timeout=120) as response:
            langgraph_stream = response.read().decode("utf-8", "ignore")
        require("RUN_FINISHED" in langgraph_stream and
                markers["tool-result"] in langgraph_stream and
                markers["model-output"] in langgraph_stream,
                "agent-langgraph ran a real tool loop: callback executed, result re-entered the model")
        mock_state = mock.state()
        langgraph_calls = [r for r in mock_state if r["tool_callback"]]
        require(langgraph_calls and "tool-params" in langgraph_calls[0]["marker_keys_seen"],
                "the real tool callback carried the tool arguments across the deployment boundary")
        bot_model_calls = [r for r in mock_state if not r["tool_callback"]
                           and "conversation" in r["marker_keys_seen"]]
        require(bool(bot_model_calls),
                "agent-bot's real model request carried the conversation body across the model boundary")

        # A real operation on the computer gateway: the pre-seat profile of a private Bot handed to
        # its owner's seat, asked the way the server asks, with the profile planted in the gateway's
        # own volume first and its arrival checked there afterwards.
        legacy_profile_dir = carry_bot
        seat_dir = f"ada2~{carry_bot}"
        docker(*app, "exec", "-T", "agent-computer", "sh", "-c",
               f"mkdir -p /profiles/{legacy_profile_dir}/Default && "
               f"printf carried > /profiles/{legacy_profile_dir}/Default/marker")
        carry_code, carry_body = 0, {}
        try:
            with urlopen(Request(f"http://127.0.0.1:{computer_port}/computers/carry-over",
                                 json.dumps({}).encode(),
                                 {"Content-Type": "application/json",
                                  "x-openbot-computer-token": computer_token,
                                  "x-openbot-bot-id": legacy_profile_dir,
                                  "x-openbot-person-id": "ada2"}, method="POST"),
                         timeout=60) as response:
                carry_code, carry_body = response.status, json.load(response)
        except HTTPError as error:
            carry_code, carry_body = error.code, {}
        require(carry_code == 200 and carry_body.get("outcome") == "moved",
                "agent-computer moved the legacy profile to the owner's seat for real")
        seat_listing = docker(*app, "exec", "-T", "agent-computer", "sh", "-c",
                              f"cat /profiles/{seat_dir}/Default/marker 2>/dev/null; "
                              f"test -d /profiles/{legacy_profile_dir} && echo still-there || echo gone")
        require("carried" in seat_listing.stdout and "gone" in seat_listing.stdout,
                "the moved profile is on the owner's seat and the old one is gone")
        # The Bots log no per-turn lines by design (their operations live in the server's run rows
        # and the audit stream), so the per-agent queryable record is their real startup event plus
        # this captured boundary traffic. Recorded, not claimed.
        (work / "bot-operations.json").write_text(json.dumps({
            "agent-bot": {"operation": "real AG-UI run through the model endpoint",
                          "run_finished": "RUN_FINISHED" in bot_stream,
                          "model_boundary_captured": bool(bot_model_calls),
                          "per_turn_stdout_logs": "none by design; queryable record is the "
                                                 "agent-listening startup event"},
            "agent-langgraph": {"operation": "real AG-UI run with a deployment tool callback",
                                "run_finished": "RUN_FINISHED" in langgraph_stream,
                                "tool_result_returned_by_model":
                                    markers["tool-result"] in langgraph_stream,
                                "tool_callback_captured": bool(langgraph_calls)},
            "agent-computer": {"operation": "real pre-seat profile carry-over on the gateway",
                               "outcome": carry_body.get("outcome"),
                               "seat": seat_dir,
                               "profile_on_seat": "carried" in seat_listing.stdout,
                               "old_profile_removed": "gone" in seat_listing.stdout},
            "marker_values_note": "only marker keys are recorded here, never their values",
        }, indent=2) + "\n")

        # The crash window: a real routine run is triggered and the database is stopped while the
        # run is provably in flight. When the headless turn's deadline arrives, the runner's
        # finishRun hits the database that is genuinely down, and the runner logs the real run id
        # on its own stderr — the source record the runtime stream is checked against, value by
        # value. (This stack's Intelligence gateway is a REST-level mock; the runner protocol over
        # its WebSocket is not emulated, so a server-driven turn reliably ends at its deadline —
        # which is what puts a real run, mid-flight, inside a real database outage.)
        # Its own channel: a headless turn runs one at a time per thread, and the first routine's
        # turn is still inside its deadline when this run starts — sharing the thread would end
        # this run with "thread busy" instead of the crash the window exists to produce.
        code, crash_channel = http(app_url, "/api/channels", {"agentIds": [agent_id]})
        require(code == 201 and crash_channel.get("channel", {}).get("id"),
                "created the crash-window conversation")
        code, crash_routine = http(app_url, "/api/routines",
                                   {"agentId": agent_id, "channelId": crash_channel["channel"]["id"],
                                    "cron": cron,
                                    "title": "verification crash window",
                                    "instruction": f"Summarise nothing. {markers['prompt']} {crash_trigger}"})
        require(code == 201 and crash_routine.get("routine", {}).get("id"),
                "created the crash-window routine")
        code, crash_run = http(app_url, f"/api/routines/{crash_routine['routine']['id']}/run", {})
        require(code == 202 and crash_run.get("runId"), "run now accepted the crash-window run")
        crash_run_id = crash_run["runId"]

        def crash_run_in_flight():
            row = docker(*app, "exec", "-T", "postgres", "psql", "-U", "openbot", "-d", "openbot",
                         "-tAc", f"SELECT status FROM routine_runs WHERE id = '{crash_run_id}'",
                         check=False).stdout.strip()
            return row == "" or None
        retry(crash_run_in_flight, "the crash-window run is open and in flight")
        pg_container = docker(*app, "ps", "-q", "postgres").stdout.strip()
        docker("stop", pg_container)
        error_window_start = int((time.time() - 5) * 1_000_000)

        def crash_logged():
            log = docker(*app, "logs", "--since", "60s", "server", check=False)
            return [line for line in (log.stdout + log.stderr).splitlines()
                    if '"routine-run-crashed"' in line and crash_run_id in line] or None
        retry(crash_logged, "the runner logged the real run id as crashed while PostgreSQL was down",
              timeout=480)
        # The source record: the server's own stderr, read from the container that wrote it.
        server_log = docker(*app, "logs", "--since", "600s", "server")
        crashed_lines = [line for line in (server_log.stdout + server_log.stderr).splitlines()
                         if '"routine-run-crashed"' in line and crash_run_id in line]
        (work / "crash-window-source-log.txt").write_text(server_log.stdout + server_log.stderr)
        require(bool(crashed_lines) and crash_run_id in crashed_lines[0],
                "the server's own stderr carries the real run id as a crashed run")
        retry(lambda: [h for h in hits(f'SELECT * FROM "openbot_runtime" WHERE service_name = \'server\' '
                                       f"AND run_id = '{crash_run_id}' "
                                       "AND openbot_log_type = 'routine-run-crashed' "
                                       "AND severity = 'Error'")] or None,
              "the runtime stream stores the real run id from the source record")
        retry(lambda: hits("SELECT * FROM \"openbot_runtime\" WHERE service_name = 'server' "
                           "AND openbot_log_type = 'responsibility-dispatch-error' "
                           "AND severity = 'Error'", start_time=error_window_start),
              "real server responsibility sweep failure recorded as Error while PostgreSQL was stopped")
        retry(lambda: hits("SELECT * FROM \"openbot_runtime\" WHERE service_name = 'worker' "
                           "AND openbot_log_type = 'routine-sweep-tick-failed' AND severity = 'Warn'",
                           start_time=error_window_start),
              "real worker sweep tick failure recorded as Warn while PostgreSQL was stopped")
        docker("start", pg_container)
        retry(lambda: http(app_url, "/health")[0] == 200, "server recovered after PostgreSQL restart", timeout=240)
        require(True, "controlled real Error and Warn from a live database outage")

        # Value-by-value correlation: the run id the API returned is the one in the authoritative
        # audit row and the one stored in OpenObserve. Selected by the API's own id, because the
        # crash-window routine's audit row is a different real run with its own id.
        def audit_row():
            row = docker(*app, "exec", "-T", "postgres", "psql", "-U", "openbot", "-d", "openbot",
                         "-tAc", f"SELECT event_type, payload->>'runId' FROM audit_events "
                         f"WHERE event_type = 'routines.run_requested' AND payload->>'runId' = '{manual_run_id}' "
                         f"ORDER BY created_at DESC LIMIT 1", check=False).stdout.strip()
            return row or None
        event_type, db_run_id = retry(audit_row, "audit row for the real run").split("|", 1)
        require(db_run_id == manual_run_id,
                "audit database row carries the exact run id the API returned")
        def audit_stream_has_run_id():
            return [h for h in hits(f"SELECT * FROM \"openbot_audit\" WHERE run_id = '{manual_run_id}'")
                    if h.get("openbot_event_type") == event_type] or None
        try:
            retry(audit_stream_has_run_id,
                  "OpenObserve audit stream stores the same run id", timeout=300)
        except RuntimeError:
            # Diagnose: what did the audit stream actually receive?
            seen = [{"event": h.get("openbot_event_type"), "run_id": h.get("run_id"),
                     "log_class": h.get("log_class")} for h in all_hits('SELECT * FROM "openbot_audit"')]
            (work / "audit-stream-diagnostic.json").write_text(
                json.dumps({"records": seen, "expected_run_id": manual_run_id}, indent=2) + "\n")
            raise
        correlation = {"event_type": event_type, "api_run_id": manual_run_id,
                       "audit_db_run_id": db_run_id, "match": True,
                       "runtime_stream": {
                           "api_run_id": crash_run_id,
                           "source_record": "server stderr line routine-run-crashed, read from the "
                                            "server container after the crash window",
                           "source_log_evidence": "crash-window-source-log.txt",
                           "stored_under": ["routine-run-crashed"],
                           "match": True,
                           "note": "run id compared value-by-value: run-now API response -> server "
                                   "stderr source record -> openbot_runtime record; the turn ends at "
                                   "its deadline, so the crash event is the runtime record"},
                       "request_id_inventory": {
                           "emitting_sources": [],
                           "basis": "no first-phase service writes a requestId field to stdout or "
                                    "stderr (checked across server, worker and supervisor); audit "
                                    "payloads mint none, and the collector keeps the whitelist + "
                                    "UUID format guard for requestId keys wherever a producer "
                                    "does emit one",
                       },
                       "note": "run id compared value-by-value: API response -> PostgreSQL audit row "
                               "-> openbot_audit record; runtime chain above covers the run stream"}
        require(not hits('SELECT * FROM "openbot_runtime" WHERE service_name = \'postgres\' '
                         'AND run_id IS NOT NULL'),
                "system events without a run keep an empty run id")
        record("correlation.json", correlation)

        # Edge-case redaction fixtures, injected beside the real paths above: nested objects,
        # serialized JSON, exception text and free text on both stdout and stderr, plus the audit
        # OTLP path carrying untrusted resource/scope/body/attributes.
        record_data = {
            "type": "routine-sweep", "runId": edge_id, "message": markers["conversation"],
            "model": {"input": markers["prompt"], "output": markers["conversation"]},
            "tools": [{"arguments": markers["tool-input"], "result": markers["conversation"]}],
            "nested": {"message": markers["nested"]}, "serialized": json.dumps({"value": markers["encoded"]}),
            "error": f"TypeError: {markers['exception']}", "authorization": f"Bearer {markers['plain']}",
        }
        docker(*app, "exec", "-T", "server", "sh", "-c", "cat > /proc/1/fd/1",
               text=json.dumps(record_data) + "\n")
        docker(*app, "exec", "-T", "server", "sh", "-c", "cat > /proc/1/fd/2",
               text=f"unstructured failure {markers['plain']}\n")
        # Negative control for the format guard: a malformed run id must not reach OpenObserve.
        junk_id = "not-a-real-run-id"
        docker(*app, "exec", "-T", "server", "sh", "-c", "cat > /proc/1/fd/1",
               text=json.dumps({"type": "routine-sweep", "runId": junk_id}) + "\n")
        audit_fixture = {"resourceLogs": [{"resource": {"attributes": [{"key": "untrusted", "value": {"stringValue": markers["plain"]}}]},
                 "scopeLogs": [{"scope": {"name": markers["plain"]}, "logRecords": [{
                     "timeUnixNano": str(time.time_ns()), "severityNumber": 13,
                     "body": {"stringValue": markers["plain"]},
                     "attributes": [{"key": "openbot.event_type", "value": {"stringValue": "configuration.changed"}},
                                    {"key": "openbot.target_id", "value": {"stringValue": edge_id}},
                                    {"key": "openbot.payload.nested", "value": {"stringValue": markers["plain"]}}]
                 }]}]}]}
        docker(*app, "exec", "-T", "server", "bun", "-e",
               'const response = await fetch("http://otel-collector:4318/v1/logs", '
               '{method:"POST",headers:{"Content-Type":"application/json"},body:await Bun.stdin.text()}); '
               'if (!response.ok) process.exit(1);', text=json.dumps(audit_fixture))

        # A real goal with a real webhook trigger: one signed-secret delivery is the platform's own
        # path to a responsibility dispatch, so the server's business dispatch event is exercised,
        # not merely registered.
        code, goal = http(app_url, "/api/responsibilities",
                          {"agentId": agent_id, "channelId": channel_id, "title": "verification goal",
                           "instruction": "Report status once.", "successCriteria": "A status line exists."})
        require(code == 201 and goal.get("responsibility", {}).get("id"), "created a real goal")
        goal_id = goal["responsibility"]["id"]
        code, trigger = http(app_url, f"/api/responsibilities/{goal_id}/triggers",
                             {"config": {"kind": "webhook"}})
        require(code == 201 and trigger.get("secret"), "registered a real webhook trigger")
        code, delivered = http(app_url, f"/api/events/triggers/{trigger['trigger']['id']}",
                               {"type": "verification"}, auth=f"Bearer {trigger['secret']}")
        require(code == 200 and delivered.get("accepted") is True,
                "delivered a real authenticated trigger event")
        trigger_time = int((time.time() - 5) * 1_000_000)
        # The dispatch attempt itself, bounded to this delivery: the server's responsibility sweep
        # picks the goal up within seconds and records the attempt on its real path. In this stack
        # the turn cannot be carried to completion (the Intelligence gateway mock does not speak
        # the runner protocol), so the attempt surfaces as the server's Error event — recorded as
        # that boundary rather than claimed as a completed dispatch.
        retry(lambda: [h for h in hits("SELECT * FROM \"openbot_runtime\" WHERE service_name = 'server' "
                                       "AND (openbot_log_type = 'responsibility-dispatch' "
                                       "OR openbot_log_type = 'responsibility-dispatch-error')",
                                       start_time=trigger_time)] or None,
              "the server recorded the goal's dispatch attempt after the authenticated delivery")

        # Every required source must show queryable evidence from the real services.
        missing = lambda records: set(SOURCES) - {hit.get("service_name") for hit in records}
        runtime_sql = 'SELECT * FROM "openbot_runtime" WHERE log_class = \'runtime\''
        runtime = retry(lambda: (lambda rows: rows if rows and not missing(rows) else None)(
                            all_hits(runtime_sql)),
                        "runtime records from every required source", timeout=240)
        require(not missing(runtime), "runtime records queryable for " + ", ".join(SOURCES))
        by_source = {}
        for source in SOURCES:
            rows = [r for r in runtime if r.get("service_name") == source]
            by_source[source] = {"records": len(rows),
                                 "events": sorted({r.get("openbot_log_type") or "runtime-unclassified"
                                                   for r in rows}),
                                 "severities": sorted({r.get("severity") for r in rows})}
        # The Bots log nothing per turn, so their real operations are matched to their real
        # startup events by name, and to the captured model/tool boundary in bot-operations.json.
        for source, operation in (("agent-bot", "real AG-UI model turn"),
                                  ("agent-langgraph", "real AG-UI model turn with a tool callback"),
                                  ("agent-computer", "real profile carry-over on the gateway")):
            require(any(r.get("openbot_log_type") == "agent-listening"
                        for r in runtime if r.get("service_name") == source),
                    f"{source}'s real startup event is stored under its own name")
        worker_business = [r for r in runtime if r.get("service_name") == "worker" and
                           r.get("openbot_log_type") in ("routine-sweep", "routine-sweep-purge")]
        require(worker_business, "real worker business events are stored as named events, not only summaries")
        require(any(r.get("openbot_log_type") == "routine-sweep-purge" and r.get("severity") == "Info"
                    for r in runtime), "real worker purge processing kept its own Info event name")
        require(any(r.get("openbot_log_type") == "computer-legacy-stopped" and
                    r.get("service_name") == "supervisor" for r in runtime),
                "real supervisor legacy retirement kept its own event name")
        require(any(r.get("openbot_log_type") == "computer-profile-carried-over" and
                    r.get("service_name") == "supervisor" for r in runtime),
                "real carry-over outcome kept its own event name")
        require(any(r.get("openbot_log_type") == "postgres-ready" for r in runtime),
                "PostgreSQL readiness on the real Docker log stream")
        require({r.get("severity") for r in runtime} >= {"Info", "Warn", "Error"},
                "Info, Warn and Error severities all queryable from real events")
        operations = {"agent-bot": "real AG-UI model turn (see bot-operations.json)",
                      "agent-langgraph": "real AG-UI model turn with a deployment tool callback "
                                         "(see bot-operations.json)",
                      "agent-computer": "real pre-seat profile carry-over on the gateway "
                                        "(see bot-operations.json)"}
        record("sources.json", {
            source: {**by_source[source],
                     "collection": "docker fluentd driver (fixed tag) -> collector -> openbot_runtime",
                     **({"real_operation": operations[source]} if source in operations else {}),
                     "verified": True}
            for source in SOURCES} | {
            "spire-init": {"verified": "boundary", "reason": "one-shot chown produces no log lines; "
                           "driver attached and tag registered (see spire-init.json)"},
            "carry-over-helper": {"verified": "boundary", "reason": "success is signalled by exit "
                                  "code and the supervisor's computer-profile-carried-over event; "
                                  "the helper prints nothing on success (see dynamic-computer.json)"},
            "agent-harness": {"verified": "not enabled", "reason": "harness profile not enabled in "
                              "this deployment; the overlay already carries its tag"},
        })

        # Audit path: the real settings change is the authoritative operation, the OTLP copy is the
        # query copy, and the streams must not mix.
        audited = retry(lambda: all_hits('SELECT * FROM "openbot_audit" WHERE log_class = \'audit\''),
                        "server audit OTLP ingested")
        require(any(r.get("openbot_event_type") == "configuration.changed" and
                    r.get("openbot_target_id") != edge_id for r in audited),
                "real settings audit record reached OpenObserve")
        require(not hits('SELECT * FROM "openbot_runtime" WHERE log_class = \'audit\''),
                "audit records do not appear in the runtime stream")
        require(not hits('SELECT * FROM "openbot_audit" WHERE log_class = \'runtime\''),
                "runtime records do not appear in the audit stream")
        retry(lambda: hits(f'SELECT * FROM "openbot_audit" WHERE openbot_target_id = \'{edge_id}\' AND severity = \'Warn\''),
              "sanitized audit fixture was ingested as Warn")

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

        # The correlation edge fixture keeps its run id, and the format guard rejects junk.
        matching = retry(lambda: hits(f'SELECT * FROM "openbot_runtime" WHERE run_id = \'{edge_id}\''),
                         "positive runtime marker")
        require(matching[0].get("body") == "routine-sweep",
                "sanitized runtime record kept its correlation ID")
        require(not hits(f'SELECT * FROM "openbot_runtime" WHERE run_id = \'{junk_id}\''),
                "the format guard rejected a malformed run id")

        # ---- What the collector actually put on the wire. ----
        def seen_streams():
            bodies_now = forwarder.bodies()
            return bodies_now if (bodies_now.get("openbot_runtime") and
                                  bodies_now.get("openbot_audit")) else None
        bodies = retry(seen_streams, "the capture forwarder saw both streams", timeout=120)
        all_sent = "\n".join("\n".join(chunks) for chunks in bodies.values())
        positives = ["routine-sweep", "routine-sweep-purge", "responsibility-dispatch",
                     "computer-profile-carried-over", "configuration.changed", manual_run_id,
                     crash_run_id]
        require(all(p in all_sent for p in positives),
                "captured OTLP bodies contain the registered events and the real run ids of both streams")
        leaked = [name for name in list(markers.values()) + list(credentials.values()) +
                  [crash_trigger, tool_trigger]
                  if name in all_sent]
        require(not leaked, f"sensitive markers and live credentials absent from the actual sent payloads (checked {sum(len(v) for v in bodies.values())} fields)")
        payload = work / "payload.json"
        docker(*obs, "cp", "otel-collector:/var/lib/otelcol/sent-payload.json", str(payload))
        sent = payload.read_text()
        require(manual_run_id in sent and "configuration.changed" in sent,
                "exporter snapshot contains the positive controls (auxiliary evidence)")
        require(all(marker not in sent for marker in list(markers.values()) + list(credentials.values())),
                "sensitive fixtures and credentials absent from the exporter snapshot")
        forwarder_summary = forwarder.summary()
        record("otlp-capture.json", {
            "requests": len(forwarder_summary),
            "streams": sorted({r["stream"] for r in forwarder_summary if r["stream"]}),
            "all_authorized": all(r["authorized"] for r in forwarder_summary),
            "authorization_values_recorded": False,
            "content_types": sorted({r["content_type"] or "" for r in forwarder_summary}),
            "decoded_field_count": sum(len(v) for v in bodies.values()),
            "positive_controls_found": positives,
            "negative_hits": leaked,
        })
        require(all(r["authorized"] for r in forwarder_summary),
                "every captured OTLP request carried credentials (values not recorded)")

        # ---- Stored records: full scan of both streams. ----
        stored_runtime = all_hits('SELECT * FROM "openbot_runtime"')
        stored_audit = all_hits('SELECT * FROM "openbot_audit"')
        stored_blob = json.dumps(stored_runtime) + json.dumps(stored_audit)
        leaked_stored = [name for name in list(markers.values()) + list(credentials.values()) +
                         [crash_trigger, tool_trigger]
                         if name in stored_blob]
        require(not leaked_stored, "sensitive markers and credentials absent from all stored records")
        require(str(manual_run_id) in stored_blob, "the real run id is present in stored records")
        record("result.json", {
            "runtime_services": sorted({r["service_name"] for r in stored_runtime}),
            "runtime_records": len(stored_runtime), "audit_records": len(stored_audit),
            "redaction": {"edge_fixtures": len(markers), "live_credentials": len(credentials),
                          "boundary_triggers": 2, "leaked": leaked_stored},
            "capture": {"requests": len(forwarder_summary)},
            "correlation": correlation,
        })

        # ---- Access. ----
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
            "openbot_dev_user_search": search(plan, basic("dev@openbot.local", "not-an-openobserve-password"))[0],
            "ingest_token_search": search(plan, basic("default", ingest_token))[0],
            "ingest_token_user_list": http(query_url, "/api/default/users", auth=basic("default", ingest_token))[0],
        }
        require(statuses["administrator_search"] == 200 and all(
                status in {401, 403} for label, status in statuses.items() if label != "administrator_search"),
                "administrator query succeeds; anonymous, wrong password, OpenBot identity, and ingest token are denied")
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

        # An OpenBot session cookie, presented to OpenObserve as if it were a credential: whatever
        # OpenBot may issue its users, none of it opens this query path. A real non-admin OpenBot
        # session cannot exist in this stack by design — `OPENBOT_SINGLE_USER` mints no sessions and
        # a second identity needs an external IdP — so this is the boundary the deployment actually
        # has, verified rather than assumed.
        cookie_request = Request(query_url + "/api/default/_search",
                                 json.dumps({"query": {"sql": plan, "start_time": start,
                                                       "end_time": int(time.time() * 1_000_000),
                                                       "size": 10}}).encode(),
                                 {"Content-Type": "application/json",
                                  "Cookie": "better-auth.session_token=not-a-real-openbot-session"},
                                 method="POST")
        try:
            with urlopen(cookie_request, timeout=8) as response:
                statuses["openbot_session_cookie_search"] = response.status
        except HTTPError as error:
            statuses["openbot_session_cookie_search"] = error.code
        require(statuses["openbot_session_cookie_search"] in {401, 403},
                "an OpenBot session cookie is not a credential for the log store")
        statuses["ordinary_openbot_session_boundary"] = (
            "OPENBOT_EDITION=personal runs one administrator with OPENBOT_SINGLE_USER=true, which "
            "issues no sessions and admits no second identity; a non-admin OpenBot session requires "
            "an external IdP (team edition), out of this stack's scope. Verified instead: OpenBot-"
            "shaped cookies are rejected above, the app surface below carries no OpenObserve "
            "reference or credential, and a real authenticated OpenObserve user from another "
            "organization is denied (this matrix).")

        # Client surface: what the OpenBot app serves to a browser must not carry OpenObserve
        # credentials, and no application container may hold the ingestion token.
        with urlopen(Request(app_url + "/"), timeout=10) as response:
            client_code, client_text = response.status, response.read().decode("utf-8", "ignore")
        assets = re.findall(r'(?:src|href)="(/[^"]+\.(?:js|css))"', client_text)
        for asset in assets[:12]:
            with urlopen(Request(app_url + asset), timeout=10) as response:
                client_text += response.read().decode("utf-8", "ignore")
        client_leaks = [name for name in credentials.values() if name in client_text]
        require(client_code == 200 and not client_leaks,
                f"the app's served HTML and bundles contain no OpenObserve credentials ({len(assets)} assets checked)")
        # And no way in at all: the app never names the log store or its port, so an OpenBot user
        # is not handed an entry point the access matrix then has to police.
        oo_surface = [needle for needle in ("openobserve", f"127.0.0.1:{query_port}",
                                            f"localhost:{query_port}")
                      if needle.lower() in client_text.lower()]
        require(not oo_surface, "the app's served surface names no OpenObserve endpoint")
        statuses["client_surface_references"] = oo_surface
        # Only the ingestion token is an OpenObserve credential; the other minted secrets are the
        # deployment's own (they legitimately live in application environments and are already
        # covered as redaction fixtures). Both the raw token and its Basic form are scanned.
        oo_credential_forms = (ingest_token, basic("default", ingest_token))
        app_containers = {}
        for name in ("server", "worker", "supervisor", "agent-bot", "agent-computer"):
            container = docker(*app, "ps", "-q", name).stdout.strip()
            envs = docker("inspect", "--format", "{{json .Config.Env}}", container).stdout
            app_containers[name] = not any(token in envs for token in oo_credential_forms)
        require(all(app_containers.values()),
                "no application container carries an OpenObserve credential")
        collector_container = docker(*obs, "ps", "-q", "otel-collector").stdout.strip()
        collector_envs = docker("inspect", "--format", "{{json .Config.Env}}",
                                collector_container).stdout
        require(ingest_basic in collector_envs or ingest_token in collector_envs,
                "only the collector holds the write credential")
        statuses["client_credential_check"] = {"assets_checked": len(assets), "leaks": client_leaks}
        statuses["app_container_credential_check"] = app_containers
        record("access-status.json", statuses)

        # ---- Short outage: business and the authoritative audit continue, the copy follows. ----
        # The queued-delivery proof is bounded on both ends: every record asserted below carries a
        # timestamp from inside the outage window, so it was produced while OpenObserve was down
        # and can only have arrived through the collector's queue.
        oo_container = docker(*obs, "ps", "-q", "openobserve").stdout.strip()
        docker("stop", oo_container)
        outage_start = int((time.time() - 5) * 1_000_000)
        outage_started = time.monotonic()
        code, _ = http(app_url, "/api/settings/instructions",
                       {"instructions": f"outage-window {markers['outage']}"}, method="PUT")
        require(code == 200, "real settings operation succeeded with OpenObserve stopped")
        outage_count = int(docker(*app, "exec", "-T", "postgres", "psql", "-U", "openbot", "-d", "openbot",
                                  "-tAc", f"SELECT count(*) FROM audit_events "
                                          f"WHERE created_at >= to_timestamp({outage_start} / 1000000.0)",
                                  check=False).stdout.strip() or 0)
        require(outage_count >= 1, "authoritative PostgreSQL audit rows written during the outage window")
        # Held open past the worker's 30-second sweep cadence, so at least one real runtime record
        # is provably produced inside the window and its arrival can only be the queue's work.
        time.sleep(35)
        docker("start", oo_container)
        retry(lambda: http(query_url, "/healthz")[0] == 200, "OpenObserve health after the outage", timeout=240)
        recovery_time = int(time.time() * 1_000_000)
        outage_audit = retry(lambda: [h for h in hits('SELECT * FROM "openbot_audit" WHERE openbot_event_type = '
                                                      "'configuration.changed'",
                                                      start_time=outage_start, end_time=recovery_time)
                                      if h.get("_timestamp", 0) >= outage_start] or None,
                             "the audit copy written during the outage window arrived through the queue")
        require(markers["outage"] not in json.dumps(outage_audit),
                "outage-window audit copy arrived sanitized")
        outage_runtime = retry(lambda: [h for h in hits('SELECT * FROM "openbot_runtime" WHERE service_name = \'worker\' '
                                                        "AND openbot_log_type = 'routine-sweep'",
                                                        start_time=outage_start, end_time=recovery_time)
                                        if h.get("_timestamp", 0) >= outage_start] or None,
                               "worker runtime logs produced during the outage window arrived after recovery")
        require(bool(outage_runtime), "worker runtime logs queued during the outage arrived after recovery")
        record("outage.json", {
            "settings_http_status": code, "audit_rows_in_window": outage_count,
            "queued_records_delivered": {"audit": len(outage_audit), "runtime": len(outage_runtime or [])},
            "window_bounds_us": {"start": outage_start, "recovery": recovery_time},
            "queued_record_timestamps_within_window": True,
            "outage_seconds": round(time.monotonic() - outage_started, 1),
            "boundary": "a brief stop is verified here; sustained-failure and disk-pressure tests "
                        "belong to the follow-up fault ticket",
        })

        # ---- Restart persistence, with real records on both sides. ----
        # The retained records are bounded to before the restart, the fresh one to after it, so a
        # query cannot be satisfied by a row that merely predates the restart.
        restart_started = int(time.time() * 1_000_000)
        docker(*obs, "restart", "openobserve", "otel-collector")
        retry(lambda: http(query_url, "/healthz")[0] == 200, "OpenObserve after restart", timeout=240)
        retained_runtime = retry(lambda: [h for h in hits(f'SELECT * FROM "openbot_runtime" WHERE service_name = \'supervisor\' '
                                                          "AND openbot_log_type = 'computer-profile-carried-over'",
                                                          start_time=start, end_time=restart_started)
                                          if h.get("_timestamp", 0) < restart_started] or None,
                                 "record stored before the restart is still queryable afterwards")
        retained_audit = retry(lambda: [h for h in hits(f'SELECT * FROM "openbot_audit" WHERE run_id = \'{manual_run_id}\'',
                                                        start_time=start, end_time=restart_started)
                                        if h.get("_timestamp", 0) < restart_started] or None,
                               "audit record stored before the restart is still queryable afterwards")
        # routine-sweep fires every tick (30s); purge only fires on the first tick of a run, which
        # is long past by the time this restart happens.
        restart_marker = retry(lambda: [h for h in hits('SELECT * FROM "openbot_runtime" WHERE service_name = \'worker\' '
                                                        "AND openbot_log_type = 'routine-sweep'",
                                                        start_time=restart_started)
                                        if h.get("_timestamp", 0) > restart_started] or None,
                               "new real record written after the restart", timeout=180)
        require(bool(restart_marker), "new real record after restart")
        record("restart.json", {
            "restart_started_us": restart_started,
            "retained_before_restart": {"runtime": len(retained_runtime or []),
                                        "audit": len(retained_audit or [])},
            "new_after_restart": len(restart_marker or []),
            "bounded_queries": "retained records constrained to _timestamp < restart; new record "
                               "constrained to _timestamp > restart",
        })
        require(True, "stored records survive restart and new ones arrive")
        if keep:
            # Debugging aid for a retained stack only: the UI evidence check needs to sign in and
            # run the same query a person would. Delete this file after use; it holds the run's
            # disposable throwaway credentials for a stack that exists only on this host.
            record("keep-access.json", {"query_url": query_url, "email": email, "password": password,
                                        "run_id_to_query": manual_run_id})
    except subprocess.CalledProcessError as error:
        # Keep container diagnostics in the private evidence directory, without rendering config.
        (work / "command-errors.log").write_text((error.stdout or "") + (error.stderr or ""))
        raise RuntimeError(f"Docker command failed (exit {error.returncode}); see {work}/command-errors.log") from None
    except RuntimeError:
        # A timed-out readiness gate needs its containers' words, not just the timeout. The dump
        # lands in the private evidence directory and the containers are cleaned up as usual.
        dump = []
        for service in ("server", "worker", "migrate", "postgres", "supervisor"):
            dump.append(docker(*app, "logs", "--tail", "60", service, check=False).stdout)
        (work / "failure-container-logs.txt").write_text("\n".join(dump))
        raise
    finally:
        forwarder.stop()
        mock.stop()
        if not keep:
            leftovers = [unrelated, failing_worker, legacy_container, cutover_container, person_container]
            docker("container", "rm", "-f", *leftovers, check=False)
            volumes = [legacy_profile_volume, legacy_workspace_volume,
                       f"{namespace}-profile-bot-{cutover_bot}", f"{namespace}-workspace-bot-{cutover_bot}",
                       f"{namespace}-profile-person-{person_id}", f"{namespace}-workspace-person-{person_id}"]
            docker("volume", "rm", "-f", *volumes, check=False)
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
