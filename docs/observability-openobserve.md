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

Only containers recreated with the overlay forward new records. Earlier logs, other Compose projects, desktop or CLI logs, and computers created dynamically by the supervisor stay outside this configuration. Apply the same explicit forwarding policy to any additional deployment-specific jobs before adding them to your collection inventory.

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

OpenObserve v1.1.2 and Collector Contrib 0.165.0 are pinned by digest. The `openobserve-data` volume holds stored logs. The `collector-state` volume holds the bounded exporter queue and rotates a sanitized export snapshot. Compose recreation preserves both volumes. Docker forwarding is asynchronous with bounded buffers and retries. Extended outages can drop records. Set the global retention window with `ZO_COMPACT_DATA_RETENTION_DAYS` and size the storage volume for the expected rate.

## Query as the operator

Open `http://127.0.0.1:5080`, sign in with the dedicated administrator, and select Logs → `default`. The query listener is published only on host loopback. OpenObserve shares its network with the collector. The collector receives audit OTLP over the separate data network.

The collector uses an organization ingestion token, which cannot sign in to the UI, query logs, or list users. Keep the `default` organization restricted to administrators and avoid provisioning ordinary OpenBot users there. OSS v1.1.2 does not provide a same-organization basic member role. A native account in another organization cannot query the `default` organization's logs.

Useful fields include `_timestamp`, `service_name`, `deployment_environment`, `severity`, `log_class`, and `openbot_log_type`. Use `request_id` or `run_id` when the source includes a UUID for that field.

```sql
SELECT _timestamp, service_name, severity, openbot_log_type, body
FROM "default"
WHERE service_name = 'server' AND severity = 'Error'
ORDER BY _timestamp DESC
```

The collector replaces all raw runtime and audit bodies with a registered event label or a fixed summary. It discards free text, exception details, arbitrary attributes, audit payloads, tool data, model input and output, and nested values before the exporter. Forks adding an event label must register it in the allowlist. Inspect the original diagnostic through the deployment's restricted local logs when you need the free-form text.

## Run Docker acceptance

Run from the repository root with Docker Compose and Python 3. Build the application images from the checkout with `--build`. Omit the flag when the default OpenBot application images are already available locally.

```sh
bash scripts/observability/verify-openobserve.sh --build
```

The command creates a disposable project, generates scoped credentials, and uses free loopback ports. It checks actual service logs, an audit event from the settings API, content removal in the exporter and in stored results, authorization, and reads before and after restarting the collector and OpenObserve. It uses synthetic sensitive text and removes the test projects and volumes on exit. `--keep` retains them for diagnosis. The command prints the location of its local evidence.
