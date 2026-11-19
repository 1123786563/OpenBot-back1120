# Billing Contract (#62) — final artifact locations, tooling and verification

Issue #62 (parent #61): unified executable contract for accounts, credits,
orders, payment channels, usage metering and model execution. **Contract
passed does NOT mean a real backend, gateway, payment channel or production
capability exists** — those are delivered by tickets #64–#78.

## 1. Artifact layout (single source of truth)

| Artifact | Path | Role |
| --- | --- | --- |
| Source contract | `contracts/billing/openapi.yaml` | ONLY authoritative API definition (OpenAPI 3.1); all paths are NEW v1 interfaces specified here, not mirrors of existing capability |
| Domain schemas | `contracts/billing/schemas/*.yaml` | named JSON Schemas (`scalars` `common` `objects` `problem` `pagination` `channel` `idempotency`), `$ref`-ed into openapi.yaml; no second authoritative copy exists anywhere |
| Lint config | `contracts/billing/redocly.yaml` | Redocly rule set |
| Fixtures | `contracts/billing/fixtures/{valid,invalid}/*.json` | machine-verified positive/negative examples incl. state machines and idempotency cases |
| Generated client | `generated/billing-client/schema.d.ts` | openapi-typescript output; COMMITTED and regen-checked (never hand-edited) |
| Checker | `server/src/billing-contract/validate-fixtures.ts` | semantic contract checker (see §3) |
| Money/time primitives | `server/src/billing-contract/money-time.ts` | BigInt-exact parsing, HALF_UP, microsecond instants, lot conservation |
| Isolated environment | `tests/billing/compose.yml` | dedicated PostgreSQL 17 + Lago CE v1.57.0 stack; NEVER touches the app's root `docker-compose.yml` |
| Guard | `tests/billing/guard.ts` | target whitelist, `billing62_<run_id>` naming, zero-write abort |
| Runner | `tests/billing/runner.ts` | single entry: guard → boot → health → seed → assert → cleanup |
| Payment substitute | `tests/billing/payment-stub/payment-adapter-stub.ts` | the ONLY allowed external-payment stand-in (create/query/close/refund/queryRefund/downloadStatement/raw notifications) |
| Full-mode case | `tests/billing/cases/lago-zero-amount-metering.ts` | AC5/AC8 procedure on a Docker-capable host |

## 2. Tool versions (locked in the root `package.json` / `bun.lock`)

- Bun 1.4.3 (`packageManager`), repo-declared; contract tooling run under it.
- `@redocly/cli` 2.3.1 — `bun run billing:contract:lint`
- `openapi-typescript` 7.9.1 — `bun run billing:contract:generate`
- `ajv` 8.17.1 + `ajv-formats` 3.0.1 — schema validation inside the checker
- Biome 2.5.10 — repo lint (`generated/` is ignored to keep regen diffs clean)

## 3. Commands (repeatable)

```sh
cd OpenBot
bun install --frozen-lockfile
bun run billing:contract:lint        # Redocly lint of the single source contract
bun run billing:contract:generate    # regenerate generated/billing-client/schema.d.ts
bun run billing:contract:check       # lint + generate + git diff --exit-code + semantic checker
bun run billing:test:guard           # guard suite vs REAL disposable PostgreSQL 17 (no docker needed)
bun run billing:test:integration     # full isolated stack (needs docker; fails non-zero without it)
bun test tests/billing               # payment-substitute boundary tests
bun run lint                         # Biome over the new TS files
```

`billing:contract:check` asserts (last run: **424 checks, 0 failures**):
- all VALID fixtures pass their named schema + semantic bounds; all INVALID
  fixtures are rejected via the declared layer (`schema` or `semantic`);
- scalar range bounds (`x-value-min/max`) — int64 max ±1, timestamp
  9999-12-31T23:59:59.999999Z +1µs — rejected (JSON Schema alone cannot do
  this over decimal strings; the checker closes that expressiveness gap);
- credit-lot conservation `granted = available+reserved+frozen+consumed+expired+revoked`;
- closed state machines (Reservation/CreditLot/BillingAccount/Order/
  PaymentAttempt/Refund/MeteringRelationship) incl. terminal-state regressions;
- idempotency examples bind to real operationIds, five-field scope, closed
  error codes (same-key-same-content replay / different-content 409 /
  in-flight 409 + Retry-After / different-key business-uniqueness);
- HALF_UP rounding (0.0000005 → 1, 0.0000004 → 0), summed-then-rounded step
  costs, >2^53 round-trips, six-decimal display, microsecond adjacency,
  24h unknown-usage deadline;
- OpenAPI structure: unique operationIds, Idempotency-Key + x-idempotency-scope
  on every business write (never GET, never channel callbacks), explicit
  failure responses via `application/problem+json`, x-error-codes coverage
  EQUAL to the closed `ErrorCode` enum (18 codes), internal ops under
  `/internal/v1/` with `x-internal` + service credential, channel callback
  `x-channel-auth: protocol` + `x-no-session-auth` answering
  `ChannelAcknowledgment` (never problem+json, never session auth), and no
  free-form object anywhere in the contract.

## 4. Isolated environment contract

- Project/db naming: `billing62_<run_id>`; the guard rejects any other target
  (default `postgres` db, foreign run id, non-whitelisted host, malformed URL)
  BEFORE opening a connection — rejection is pure and therefore provably
  zero-write. Verified live against real PostgreSQL 17.12.0 (see §5).
- Images pinned by tag + linux/amd64 manifest digest (registry-fetched
  2026-11-17): `postgres:17` @ `sha256:6f7593c161689b6b02c78668b314af7da8811b592c5519108c57a49d0b6ad788`,
  `getlago/postgres-partman:15.0-alpine` @ `sha256:ff4616c24367f3643aac27061a0c4e757ca8f78af967249cb4b3fd64049d290d`,
  `redis:7-alpine` @ `sha256:e4ee3e03ce8f75471f40937a7c6b2b0e500390b6812fcdf5cb32c01295ded446`,
  `getlago/api:v1.57.0` @ `sha256:8ccbea4191f30d85ee98dd0fa9b7091128286f764aedb122831e78180fa69faa`
  (api/migrate/clock/worker share one image; Lago front/pdf services are
  deliberately omitted — not needed for metering).
- Lago v1.57.0 existence verified against the upstream tag
  `getlago/lago@v1.57.0` `docker-compose.yml` (image names match). Boot
  corrections verified live against the pinned image during #65's first full
  run: service commands point at `/app/scripts/...`, the api healthcheck uses
  `/health` with curl, the stack reads `DATABASE_URL`/`REDIS_URL` (not the
  legacy `LAGO_*` names) and needs `SECRET_KEY_BASE`, and the RSA env var is
  the Base64 of the PEM. See `tests/billing/compose.yml` for details.
- Credentials are one-time per run, generated by the runner, injected via a
  0600 env file; logs keep environment names + versions only.
- Cleanup: `down -v` limited to `-p billing62_<run_id>`; leftover check; no
  global prune, no wildcard drops, no reads of repo `.env`/`DATABASE_URL`.

## 5. Verified vs unverified (honest split)

Verified in this working tree (Bun 1.4.3, Debian 12 arm64, no Docker engine
available to the run):
- `bun run billing:contract:check` — exit 0, 424 checks / 0 failures.
- `bun test tests/billing` — 7 pass / 0 fail (payment boundary incl. forged
  callback failing REAL HMAC verification).
- `bun run billing:test:guard` — exit 0 against REAL PostgreSQL 17.12.0
  (standalone aarch64 binaries, temp data dir `billing62_<run_id>_pgdata_*`,
  loopback-only listener, removed after the run): accepts own target,
  connects, rejects default/foreign/public targets with zero writes, cleans up.
- Redocly lint + double regeneration → byte-identical client.

Unverified here (declared, not faked):
- Full-stack boot of `tests/billing/compose.yml` (requires Docker; the
  runner exits 2 with an explicit unverified report instead of pretending).
- Lago v1.57.0 live health, zero-amount metering evidence, microsecond-boundary
  event placement, outbox/reconciliation behavior (AC5 boot/AC8) — procedure
  in `tests/billing/cases/lago-zero-amount-metering.ts`, host prerequisite:
  `BILLING62_RUN_ID=<id> bun run billing:test:integration` on a Docker host.
- ADR 0003/0004 original texts remain unavailable locally; constraint wording
  follows #61/requirement.md restatements. If original ADRs surface, do a
  diff review before treating any conflict as resolved.
- All ledger enforcement (state machines/conservation at RUNTIME), concurrency
  (AC7), identity (#67) and real channel protocols (#69/#70/#72): contract
  declared here, enforcement belongs to #64–#78.

## 6. Alignment with #32/#33 (recorded; no waiting, no circular dependency)

| Verified upstream need | This contract provides | Completion owner |
| --- | --- | --- |
| #32 distinguish call/Run/user/Bot/payer | immutable linkage `root_run_id`/`run_id`/`step_id`/`call_id` + `bot_id` (required execution context) + `payer_authorization_id` + `billing_account_id` on Reservation; payer resolved server-side only (402-class `unknown_payer`), never from bot owner or client claims | #67 provides identity; #32 proves the non-bypassable execution entry |
| #32 ledger expressing lock/reserve/settle/release/idempotency | §3 schemas + business-unique constraints + five-field idempotency scope; RootRunBudget independent of gateway budgets | #66 implements the atomic ledger; #32 consumes |
| #33 per-call reservation with max cost | one `call_id` → one Reservation; `max_cost_microcredits` required and enforceable; unbounded cost rejected (`unbounded_cost`); reserve-before-execute | #33 proves at execution entry + provider HTTP boundary |
| #33 concurrency/duplicates/out-of-order/ledger outage | atomic terminal race (settle vs release vs 24h deadline), replay semantics, 503 `ledger_unavailable` stops new consumption, late costs platform-borne | #33 / #36–#38 |

Dependency direction: #62 → #64/#65 → #66; #64+identity → #67; #66/#67 →
#32 → #33. This ticket neither blocks on nor blocks #32/#33.

Payment boundary: `ScriptedPaymentStub` replaces ONLY the external adapter
surface; signature verification logic is real (HMAC-SHA256, per-run keys);
order service/idempotency/review/freezing/ledger/outbox are never stubbed.
Real WeChat/Alipay protocols and merchant results are separately accepted by
#69/#70/#72 — stub success proves nothing about production channels.

Sandbox note: the guard-only suite runs PostgreSQL from standalone binaries
under a `getpwuid` LD_PRELOAD shim so a uid without an `/etc/passwd` entry
can still own a disposable cluster (runner env `BILLING62_NSS_SHIM`,
`BILLING62_PG_BIN_DIR`). Production environments with normal users do not
need the shim.
