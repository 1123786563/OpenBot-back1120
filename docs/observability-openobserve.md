# Collect OpenBot server logs in OpenObserve

Use OpenObserve to query runtime log metadata and an audit copy. PostgreSQL remains the authoritative audit store. Opik and Activity keep their existing data paths.

## Choose which services to collect

The Compose overlay enables Docker's Fluentd log driver per service. Traffic goes from the Docker daemon to the collector's loopback port. The collector has no Docker socket or host log-directory mount.

| Compose service | Source of runtime records |
| --- | --- |
| `server` | API startup, authentication, business events, background work |
| `worker` | Routine sweeps, purge and worker failures |
| `migrate` | Migration completion and failures |
| `postgres` | Database startup, readiness and diagnostics |
| `agent-bot`, `agent-langgraph`, `agent-computer` | Managed Agent startup and runtime diagnostics |
| `supervisor`, `agent-harness` | Supervisor and the optional Compose harness when enabled |
| `spire-init`, `spire-server`, `spire-agent` | Identity initialization, registration and workload-attestation runs |
| Computers and carry-over helpers the supervisor creates | Per-Bot browser and workspace runs, one-shot profile copies |

Only containers recreated with the overlay forward new records. Earlier logs, other Compose projects, desktop or CLI logs stay outside this configuration.

Computers created by the supervisor pick the driver up through `COMPUTER_LOG_FORWARD_ADDRESS`, which the overlay sets on the supervisor from the same `OO_FORWARD_PORT`. The supervisor passes a Fluentd `LogConfig` with a fixed source tag (`openbot.computer`, or `openbot.carry-over` for the one-shot volume-copy helpers) at container create time; a Bot's id, its environment or anything a request carried never becomes a log tag, and the address never enters a computer's `Env`. A computer that already exists keeps the driver it was created with until the supervisor replaces it (image, token or network change) — forwarding is not retroactive. Deployments that do not apply the overlay, including the desktop and the CLI, leave the setting unset and keep Docker's default driver.

The overlay also sets the server's audit OTLP endpoint. Audit export uses the deployment's data network, away from the default Agent network.

## Start OpenObserve and the collector

1. Confirm the OpenBot deployment's data network exists. The default is `openbot_data`. If you used a different Compose project name, set `OO_NETWORK` to its data network name.
2. Copy `docker/observability/env.openobserve.example` to `docker/observability/env.openobserve`, set mode `0600`, and set the dedicated operator account and a strong password. On ARM64, uncomment the pinned ARM64 image settings in the example.
3. Start OpenObserve on its own.

   ```sh
   docker compose -f docker/observability/compose.yml \
     --env-file docker/observability/env.openobserve up -d openobserve
   curl --fail http://127.0.0.1:5080/healthz
   ```

4. Sign in as the dedicated operator. In the `default` organization, create an ingestion token using `POST /api/default/ingestion-tokens` with `{"name":"openbot-collector","description":""}`. Set `OO_INGEST_BASIC` to the Base64 encoding of `default:<token>`, using the returned `data.token`. Keep the token and its Base64 form in the private env file.
5. Start the collector, then apply the logging overlay to the OpenBot services you are running. If you override `OO_FORWARD_PORT`, use the same value in both Compose commands.

   ```sh
   docker compose -f docker/observability/compose.yml \
     --env-file docker/observability/env.openobserve up -d otel-collector
   docker compose -f docker-compose.yml -f docker/observability/openbot-logging.compose.yml \
     --profile openbot up -d
   ```

OpenObserve v1.1.2 and Collector Contrib 0.165.0 are pinned by digest. The `openobserve-data` volume holds stored logs. The `collector-state` volume holds the bounded exporter queue and rotates a sanitized export snapshot. Compose recreation preserves both volumes. Docker forwarding is asynchronous with bounded buffers and retries. Extended outages can drop records. Size the storage volume for the expected rate.

## Separate streams and retention

The collector writes runtime records to the `openbot_runtime` stream and audit copies to `openbot_audit`, using OpenObserve's `stream-name` header on the OTLP endpoint. Each stream carries its own retention: runtime 30 days, audit 90. Both streams come into existence on their first record, so set the retention after the first records arrive:

```sh
curl --fail -X PUT "http://127.0.0.1:5080/api/default/streams/openbot_runtime/settings" \
  -u "$ZO_ROOT_USER_EMAIL:$ZO_ROOT_USER_PASSWORD" -H 'Content-Type: application/json' \
  -d '{"data_retention": 30}'
curl --fail -X PUT "http://127.0.0.1:5080/api/default/streams/openbot_audit/settings" \
  -u "$ZO_ROOT_USER_EMAIL:$ZO_ROOT_USER_PASSWORD" -H 'Content-Type: application/json' \
  -d '{"data_retention": 90}'
```

Read the values back from `GET /api/default/streams` (`settings.data_retention` per stream). A stream with no setting falls back to the global `ZO_COMPACT_DATA_RETENTION_DAYS`, which the Compose file pins to 30 — set the audit stream explicitly or its copies expire with the runtime window.

## Query as the operator

Open `http://127.0.0.1:5080`, sign in with the dedicated administrator, and select Logs → `default`. The query listener is published only on host loopback. OpenObserve shares its network with the collector. The collector receives audit OTLP over the separate data network.

The collector uses an organization ingestion token, which cannot sign in to the UI, query logs, or list users. Keep the `default` organization restricted to administrators and avoid provisioning ordinary OpenBot users there. OSS v1.1.2 does not provide a same-organization basic member role. A native account in another organization cannot query the `default` organization's logs.

Useful fields include `_timestamp`, `service_name`, `deployment_environment`, `severity`, `log_class`, and `openbot_log_type`. Use `request_id` or `run_id` when the source includes a UUID for that field.

```sql
SELECT _timestamp, service_name, severity, openbot_log_type, request_id, run_id, body
FROM "openbot_runtime"
WHERE service_name = 'server' AND severity = 'Error'
ORDER BY _timestamp DESC
```

Audit copies live in the `openbot_audit` stream and keep the authoritative `openbot_event_type`, `openbot_target_type` and `openbot_target_id` fields. The `body` of every record is a fixed label or summary — locate the free-form diagnostic in the deployment's restricted local logs.

The collector replaces all raw runtime and audit bodies with a registered event label or a fixed summary. It discards free text, exception details, arbitrary attributes, audit payloads, tool data, model input and output, and nested values before the exporter. Forks adding an event label must register it in the allowlist. Inspect the original diagnostic through the deployment's restricted local logs when you need the free-form text.

## Run Docker acceptance

Run from the repository root with Docker Compose and Python 3. Build the application images from the checkout with `--build`. Omit the flag when the default OpenBot application images are already available locally.

```sh
bash scripts/observability/verify-openobserve.sh --build
```

The command creates a disposable project, generates scoped credentials, and uses free loopback ports. It builds the supervisor from the checkout on every run, so the dynamic-computer path is exercised against this checkout's code. It checks records from every source above — including the SPIRE services and a computer the real supervisor creates through its API with the Fluentd `LogConfig` — an audit event from the settings API, stream separation and per-stream retention (30/90 days, read back from the settings API), content removal in the exporter and in stored results, authorization, and reads before and after restarting the collector and OpenObserve. It uses synthetic sensitive text and removes the test projects and volumes on exit. `--keep` retains them for diagnosis. The command prints the location of its local evidence.
