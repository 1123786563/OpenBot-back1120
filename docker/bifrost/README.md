# The billing gateway (Bifrost) — pinned procedure

This directory holds what a deployment needs to run every billed model request through
[maximhq/bifrost](https://github.com/maximhq/bifrost) with OpenBot's per-call billing gate loaded
into it. Nothing here is on by default: the `bifrost` service sits behind the `gateway` Compose
profile, and a deployment without it runs the stack exactly as before.

- `config.json` — the gateway's configuration: the anthropic provider pointing at the controlled
  fixture, and the billing gate as the one plugin.
- `plugin/` — the gate's Go source (`main.go`), the module pinned to the release's core version,
  and the `Makefile` that builds the `.so`.

## What is pinned, and how

Lock these four values in the run record before the first request; never use a floating `latest`:

```sh
docker pull maximhq/bifrost:v2.5.1
docker image inspect --format '{{index .RepoDigests 0}}' maximhq/bifrost:v2.5.1
# → write the digest into .env as BIFROST_IMAGE=maximhq/bifrost@sha256:<digest>
sha256sum docker/bifrost/config.json
git rev-parse HEAD
```

| Factor | Value this tree is written against |
|---|---|
| Bifrost release | `transports/v2.5.1` (tag), image `maximhq/bifrost:v2.5.1`, digest recorded at execution |
| Go toolchain | **1.27.3** — the release's own (`transports/go.mod`, its Dockerfile builds on `golang:1.27.3-alpine`) |
| Bifrost core module | `github.com/maximhq/bifrost/core v1.15.2` (the version that release's transports depend on) |
| Plugin API | `HTTPTransportPreHook` short-circuit + `PostLLMHook`, per that release's `docs/plugins/writing-go-plugin.mdx` |

The Go toolchain matters twice over: the release's image is built with 1.27.3, and a Go plugin
built with any other toolchain is refused at load. Build on the platform the gateway runs on —
Go plugins do not cross-compile (`make build` in `plugin/`).

## Turning the gateway on

Three `.env` lines beside the stack's own:

```ini
# The harness sends its model requests to the gateway's anthropic endpoint. The Compose service
# already passes this through to agent-harness; nothing in the harness changes.
ANTHROPIC_BASE_URL=http://bifrost:8080/anthropic
# The pinned image, digest and all (see above).
BIFROST_IMAGE=maximhq/bifrost@sha256:<digest>
# The OpenBot billing seam the gate confirms reservations on. Without it the gate refuses every
# request — that is the correct failure until ticket #66 delivers the ledger.
OPENBOT_LEDGER_URL=http://host.docker.internal:3001
```

Then `docker compose --profile harness --profile gateway up -d bifrost agent-harness`, and build
the plugin first (`cd docker/bifrost/plugin && make build`) so the mounted `.so` exists.

## The gate's contract

One header decides everything: `x-openbot-correlation-id`, put on the request by the harness from
the server's `forwardedProps.openbotCorrelationId` (`server/src/billing-gateway.ts`). Before the
provider is contacted, the gate calls the ledger's `verify`; no live reservation, no request — the
caller gets a 402 whose body says so, and the provider's request count does not move. After the
provider answers, the measured usage is settled; an error answer releases the hold in full. An
unreachable ledger fails closed, never open.

## What execution still has to confirm

Recorded here because this tree could not run the gateway (no container runtime on the machine
that produced it). What has already been proved off-container: the plugin compiles as a Go plugin
(`-buildmode=plugin`, go 1.27.3, `go vet` clean) against that release's own `core v1.15.2`, and
`config.json` validates against that release's own `config.schema.json`. Still to observe on a
live run:

1. **Load**: the `.so` built here loads into the pinned image (same toolchain, same core version
   — but only a `docker compose up` proves it).
2. **Config references**: `env.ANTHROPIC_API_KEY` / `env.FIXTURE_BASE_URL` in `config.json` and
   the `env.…` forms in the plugin's block resolve at load rather than arriving as literals. The
   release's schema documents `env.VAR` values for keys; the plugin's block taking them is read
   from that same mechanism and is the less-confirmed of the two.
3. **Hook coverage on the anthropic route**: that release's anthropic integration runs Claude Code
   requests through core (so `PostLLMHook` fires on usage) with a provider-native passthrough
   body. Confirm on a live run that a request refused by the gate never reaches the provider —
   the fixture's request log is the counter this hinges on.
4. **SDK self-recovery**: the stream-recovery re-request `agent-claude-sdk/src/adapter.py`
   documents arrives on the same base URL, so the gate sees it; confirm the reservation covers it
   or the attempt increments, per the verification matrix.
