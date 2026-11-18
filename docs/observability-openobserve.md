# Observability: server runtime logs in self-hosted OpenObserve

What this adds, what it deliberately does not do, and how to operate it. The reproducible
acceptance run is `scripts/observability/verify-openobserve.sh`; everything below is the
operational form of what that script proves.

## What is collected, and what is not

| Source | Class | Path into OpenObserve |
| --- | --- | --- |
| `server` (API, auth, Bots, background tasks) | `runtime` | container json-file → collector `filelog` |
| `worker` (routine sweep, purge) | `runtime` | same |
| `agent-bot`, `agent-langgraph`, `agent-computer`, every container the agent harness starts | `runtime` | same — the collector reads every container's json-file, so an agent enabled later is covered without new configuration |
| `migrate`, one-shot maintenance jobs | `runtime` | same |
| PostgreSQL's own server log | `runtime` | same (statement bodies are not logged by default) |
| Audit trail (`server/src/telemetry/otel.ts` over PostgreSQL `audit_events`) | `audit` | the server's OTLP export, pointed at the collector |
| Opik/Intelligence traces, conversation Activity | — | **not collected.** Their authoritative stores stay authoritative (ADR 0006); no conversation or model bodies are copied |
| Desktop app and CLI logs | — | **not collected.** They run on a person's machine, outside Docker and outside this pipeline; there is no upload path |

The three-way class boundary is `log_class`: `runtime` (service health and processing paths),
`audit` (the queryable copy of the append-only `audit_events` trail), and everything else —
Opik/Activity — absent by design.

Severity is the existing `console.*` level, mapped by the collector from a mechanical census of the
call sites (`server/src` + `worker/src` + `agent-computer/src`): every typed `console.warn` event is
Warn (49 server/worker types + 7 computer types, plus the egress-policy push states and
`model-list-unreadable` that reach the console through log callbacks), the audited `console.error`
event types are Error, a line that reaches stderr and is named by neither list is Error, and
everything else is Info. `agent-bot` and `agent-langgraph` have no `console.warn` call sites at all
(their runtime failures go to the caller as AG-UI `RUN_ERROR` events, not to stdout), so no Warn
record from them is expected — the verify run asserts that absence. Both levels exist in the code as
`console.warn`/`console.error`, and Bun writes both to stderr — the type census is what tells them
apart. Typed warn lines whose type was renamed in the code would fall to the stderr (Error) rule
until the census is regenerated; the computer's two untyped SPIRE warns (`identity.ts`) share that
residual approximation. That is checked by re-running the census in `verify-openobserve.sh` rounds.
Stored and queried as `Info`/`Warn`/`Error`. Nothing turns Debug on; no log library was added and no
business source file changed.

There are no request IDs or run IDs on runtime log lines in the code today, and none are invented:
a record that has none shows none. Audit records keep the identifiers they already carry
(`event_type`, `target_type`, `target_id`, `actor_user_id`, `initiator_id`) verbatim.

## Deployment (Compose)

Prerequisites, in the order a clean host needs them:

- **The OpenBot deployment's network must already exist.** This stack joins the network the
  OpenBot Compose project created (`OO_NETWORK`, default `openbot_default`) instead of creating a
  second one, so on a clean host it must exist before `compose up`:

  ```sh
  docker network inspect openbot_default >/dev/null 2>&1 || docker network create openbot_default
  ```

  (Bringing the OpenBot deployment up first is the normal way this becomes true. The verify
  script checks the network and exits with this instruction if it is missing.)
- **amd64 host.** Both images are pinned as amd64 builds (tag and digest), and `compose.yml` says
  `platform: linux/amd64` so an arm64 host fails at parse time with a pointer here instead of at
  pull time. On an arm64 node, pin the `-arm64` tag of the same versions with their own digests
  and re-run `scripts/observability/verify-openobserve.sh` — or run the same pinned binaries
  directly, which is what the script's native mode does.

```sh
cp docker/observability/env.openobserve.example docker/observability/env.openobserve
# edit credentials, then:
printf '%s:%s' "$ZO_ROOT_USER_EMAIL" "$ZO_ROOT_USER_PASSWORD" | base64   # -> OO_INGEST_BASIC
docker compose -f docker/observability/compose.yml \
  --env-file docker/observability/env.openobserve up -d
```

- **Versions are pinned by tag and digest** in `compose.yml`: OpenObserve `v1.1.2` and
  otel-collector-contrib `0.165.0`. Upgrading means changing both and re-running
  `scripts/observability/verify-openobserve.sh`.
- **Storage**: named volume `openobserve-data` (`ZO_DATA_DIR=/data`) for the log store, named
  volume `collector-state` for the collector's bounded disk queue and sent-payload snapshot.
  Recreating either container keeps the data; deleting the volume deletes it.
- **Ports and network**: `5080` (UI/API) is published to loopback only. gRPC `5081` and the
  collector's OTLP `4318` stay inside the Compose network. The stack attaches to the existing
  OpenBot network (`OO_NETWORK`, default `openbot_default`).
- **Credentials**: the OpenObserve root account lives only in `env.openobserve` (git-ignored).
  The collector's ingest credential (`OO_INGEST_BASIC`) lives only in the same file and the
  collector's environment. **No business process ever holds an OpenObserve credential** — the
  server exports audit OTLP to the collector unauthenticated over the internal network, and the
  collector is the only writer.
- **Retention**: `ZO_COMPACT_DATA_RETENTION_DAYS=30` globally (v1.1.2's key, verified in the
  1.1.2 binary), plus a stream-level `data_retention` you can set per stream in the UI
  (Stream Settings) or via `PUT /api/{org}/streams/{stream}/settings`; the smaller of the two
  wins. Compaction deletes past-retention data on its schedule; the disk volume should be sized
  for the deployment's log rate × retention.

## Reproducible acceptance

```sh
DATABASE_URL=postgres://... bash scripts/observability/verify-openobserve.sh
```

`OO_VERIFY_MODE=native` (default) runs the same pinned OpenObserve and collector as binaries and
the real server/worker/migrate as Bun processes through
`scripts/observability/container-log-driver.mjs`, which writes Docker's json-file envelope — the
collector config, parsing, attribution, redaction and exporter are byte-identical to the Compose
deployment. `OO_VERIFY_MODE=docker` uses the Compose stack against a live deployment. The run
leaves every query and response in its evidence directory and exits non-zero if any assertion
fails: before/after ingestion markers, Info/Warn/Error and ordinary-business triggers from real
code paths, restart survival, the auth matrix, and the synthetic-sentinel redaction experiment.

## Querying

UI: `http://127.0.0.1:5080` as the root account → Logs → the `default` stream (or your org).

API (administrator credentials):

```sh
curl -s -u "$ZO_ROOT_USER_EMAIL:$ZO_ROOT_USER_PASSWORD" \
  -H 'content-type: application/json' \
  -X POST http://127.0.0.1:5080/api/default/_search -d '{
    "query": {
      "sql": "SELECT _timestamp, service_name, severity, openbot_log_type, body FROM \"default\" WHERE service_name = '\''server'\'' AND severity = '\''Error'\''",
      "start_time": 1794900000000000, "end_time": 1794986400000000 }}'
```

Useful field names after OTLP flattening: `_timestamp` (µs, UTC), `service_name`,
`deployment_environment`, `severity` (`Info`/`Warn`/`Error`), `log_class` (`runtime`/`audit`),
`openbot_log_type` (the JSON `type` field of OpenBot's log convention), `body` (the raw line),
`container_name`, `collector_version`, and on audit records `event_type`, `target_type`,
`target_id`, `actor_user_id`, `initiator_kind`, `openbot_payload_*`.

## Redaction

The collector redacts before anything leaves it, in two layers:

1. **Text layer** on the whole raw line — token shapes (PEM, `AKIA`/`ASIA`, `ghp_`,
   `github_pat_`, `glpat-`, `xox*-`, `sk-`, `AIza`, Stripe, npm, JWT), `Authorization`/`x-api-key`
   headers, credentials by the name they travel under (`password=`, `--token`, JSON `"key":
   "value"` forms), `Bearer` tokens, and userinfo in any URL — the same shapes
   `server/src/telemetry/scrub.ts` uses. Because it runs on the raw line, nested objects, arrays,
   serialized JSON inside a value, and exception text are covered at any depth.
2. **Attribute layer** on the parsed flat fields, for anything parsing split apart, plus deletion
   of pure credential-carrier keys (`password`, `secret`, `token`, `authorization`).

The runtime pipeline exports only `openbot.log_type` taken out of a parsed line; the rest of the
parsed tree is deleted and never leaves the collector. The attribute-level net cannot recurse into
nested OTLP values (maps, arrays), so a parsed nested field would leave the collector raw while its
`body` was redacted — the verified guarantee instead is: the redacted full line is the body, and
the body is what OpenObserve indexes. Nothing of the log line is lost to a query, and nothing
unredacted is exported. (The audit pipeline's payload attributes are flat strings — the server
serializes nested values itself through `scrubCommands` — so the text net reaches them.)

Survivors become `[REDACTED]`. On top of the code's own convention of not logging conversation or
model bodies, `verify-openobserve.sh` injects synthetic credential-shaped sentinels
(`sk-sentinel-…`) that each travel in a different position — a nested JSON field, a
serialized-JSON value, an array element, exception text, a bare token — plus a real business body
(a saved settings text through the real API), and asserts none of them appear in the collector's
actual sent payload or anywhere in OpenObserve (`match_all`, every stored field).

## Collector operation

- `start_at: end` on `filelog`: only lines written after the collector starts are read. Existing
  container history is never scanned or uploaded; the script's PRE-marker assertion proves it.
- Exporting goes through a bounded, disk-backed sending queue (512 batches) with finite retry
  (`max_elapsed_time: 1h`); what still cannot be delivered is dropped and counted in the
  collector's own logs and `/metrics`. OpenObserve being down never touches a request, a Bot call
  or a database commit: the collector is a sidecar reader of log files and an OTLP sink, on no
  synchronous path. The server's audit export was already never-fatal (`otel.ts`).
- The collector's container and OpenObserve's own are excluded from discovery, so the collector
  never ingests its own output.
- Docker-path service attribution uses the Docker socket **read-only** (container names for
  `service.name`); the log store's data directory is mounted read-only too.

## Accounts: what v1.1.2 OSS actually does (verified, not assumed)

Probed against the pinned release by `verify-openobserve.sh` (evidence files `auth-*.json`):

- **No role below the organisation's admin can be issued.** Creating a user with `role: member`
  is refused outright — `400 {"message":"Custom roles not allowed"}`. The role ladder is an
  enterprise feature, so there is no such thing as an under-privileged account to worry about:
  any account that can be created reads its organisation's logs.
- **Organisation scoping works.** A valid, authenticated account created in a *different*
  organisation is denied this one's `_search` (401) and its user list (401). An OpenBot end user
  with no OpenObserve account has no credential and no network path (5080 binds to loopback).
- **An organisation-internal account cannot manage users** (403, root-only) — but it *can* read
  the organisation's logs. That is exactly why the deployment issues no account at all: the
  platform administrator's root account is the only account, and the collector's ingest
  credential is the only other secret.

If a deployment later needs per-team read scoping or a genuine read-only role, that is an
OpenObserve enterprise feature (or a proxy layer in front), not a configuration of this stack.

## Limits and follow-ups

- `ZO_COMPACT_DATA_RETENTION_DAYS` is the global floor; alerting, dashboards, backfill of
  pre-existing logs, and desktop/CLI collection are out of scope by decision (parent issue and
  ADR 0006).
- Full outage/capacity stress of the pipeline belongs to a later fault-tolerance ticket; this
  ticket ships the bounded queue/retry configuration and its restart-survival proof.
- The Compose/docker runtime path (socket discovery, container attribution) is validated by
  `otelcol-contrib validate` and the native run shares every parsing/redaction/export statement
  with it, but a round of `OO_VERIFY_MODE=docker` on a host with a Docker daemon and a live
  OpenBot deployment is the outstanding confirmation for the container-discovery half.
