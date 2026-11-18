# Casdoor T03: concurrent first sign-ins and initialization recovery

Run from the repository root with Bun 1.4.x. These scripts use only the `openbot-t03` Compose
project, the private `deploy/t03/.env.t03` file and the private `.runtime/` directory. Host ports
bind to 127.0.0.1 only: Casdoor 19001, OpenBot 14002, PostgreSQL 56433, Mailpit 18026 — an
instance isolated from T01/T02 and from any real deployment.

1. `bun deploy/t03/setup.ts` once (never overwrites; creates random local secrets).
2. `bun install --frozen-lockfile`. Then `bash deploy/t03/up.sh`: starts postgres/casdoor-db/
   casdoor/mailpit, provisions the dedicated Casdoor application (`app-t03`, organization
   `openbot-t03`, redirect `http://localhost:14002/api/auth/callback/casdoor`), applies
   migrations (through `0091_identity_issuer_unique`), prepares the isolated unit database,
   builds the web app, starts the source server and worker with fault control armed, and checks
   the listeners.
3. `bun deploy/t03/verify-t03.js` through the provided Agent browser (`browser_run_code_unsafe`)
   while `bun deploy/t03/controller.ts` runs (loopback-only test controller on 14099). The script
   creates fresh identities through Casdoor's standalone signup page (`/signup/app-t03`, which
   does not continue the OAuth flow, so identities start genuinely uninitialized), performs real
   password and mail-code sign-ins, and drives one-shot faults, the concurrency barrier and two
   hard server kills through the controller. It returns sanitized evidence; save it to
   `deploy/t03/evidence/verification.json`.
4. `bun deploy/t03/run.ts persistence` re-checks, read-only, that each converged identity has
   exactly one Casdoor account row and one personal organization, that no duplicate identity rows
   or duplicate organizations exist, and that no identity of the run was left without its space.
   Output: `deploy/t03/evidence/persistence.json`.

What the scenarios assert (AC-01…AC-06 of the task): two clients racing the same uninitialized
identity at the user write converge on one user and one workspace, the loser sees the safe retry
page and retries in; one-shot server faults at each initialization boundary (before user insert,
after identity commit, before workspace, after workspace, after session commit) leave the client
closed to every business API, other users' resources and the platform, and an ordinary new
authorization completes initialization; `kill -9` inside the identity transaction and at the
workspace boundary recovers from the database alone with parallel retries; replayed callbacks,
wrong state and invalid code grant nothing while the legitimate client keeps its exact ids, name
and resources.

Fault control (`server/src/auth/initialization-faults.ts`) is inert unless
`OPENBOT_TEST_FAULT_FILE` is set, which only `deploy/t03/launch.ts` does; the file lives in the
0700 `.runtime` directory, is consumed after one hit, and no request can steer it. The
controller's `/verify-user` fixture marks a test identity verified in the Casdoor database (the
IdP's own data) so password logins carry a verified claim; the one real mail-code verification is
demonstrated in the S0 scenario.

`bun deploy/t03/run.ts kill` terminates only the tracked server process (ownership verified via
`lsof` executable match); `bun deploy/t03/run.ts stop`, or `bash deploy/t03/stop.sh`, stops the
tracked processes and the Compose project. Neither removes volumes. Secrets stay in `.env.t03`
(0600) and `.runtime` (0700); `deploy/t03/secret-check.ts` asserts none leaked into tracked
source, the web build or the implementation report.

Not covered here: native mobile/desktop clients (the shared backend contract is covered by two
independent web contexts), model conversations (no Intelligence calls are made), and production
SLA timings — the retry budget above is a test policy, not an SLO.
