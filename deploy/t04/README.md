# Casdoor T04: two users' business resources and connections are strictly isolated

This deployment adapts the T03 environment (itself derived from T02) to the cross-user isolation
ticket. Run from the repository root with Bun 1.4.x. These scripts use only the `openbot-t04`
Compose project, the private `deploy/t04/.env.t04` file and the private `.runtime/` directory.
Host ports bind to 127.0.0.1 only: Casdoor 19002, OpenBot 14003, PostgreSQL 56434, Mailpit 18027
— an instance isolated from T01/T02/T03 and from any real deployment.

1. `bun deploy/t04/setup.ts` once (never overwrites; creates random local secrets). The example
   config ships placeholder Intelligence endpoints, because this run has no test Intelligence
   project and the team edition refuses to boot without them; the business APIs under test do
   not call them, and model turns are therefore NOT part of this verification.
2. `bun install --frozen-lockfile`. Then `bash deploy/t04/up.sh`: starts postgres/casdoor-db/
   casdoor/mailpit, provisions the dedicated Casdoor application (`app-t04`, organization
   `openbot-t04`, redirect `http://localhost:14003/api/auth/callback/casdoor`), applies
   migrations, prepares the isolated unit database, builds the web app, starts the source
   server and worker, and checks the listeners.
3. `bun deploy/t04/controller.ts` (loopback-only test controller on 14099) must be running.
4. THE ISOLATION VERIFICATION: run `deploy/t04/verify-isolation.js` through the provided Agent
   browser (`browser_run_code_unsafe`). It creates two unrelated identities through Casdoor's
   own signup page, signs each in through the real OAuth password flow on ONE client, has A
   build a Bot, a conversation and a file attachment, then has B — on that same client — list,
   read, edit, delete and reference everything of A's by id, sign A out, sign B back in, and
   finish with A re-checking all of their resources from a fresh client. Every refusal is
   paired with the owner's read of the same resource, and anonymous requests are asserted
   separately as 401 so a general failure cannot pass for isolation. Sanitized evidence:
   `deploy/t04/evidence/verification-isolation.json`.
5. `bun deploy/t04/run.ts secrets` asserts no private configuration value leaked into tracked
   source, the web build or the implementation report.

The copy of T03's fault-injection script is retained as `verify-t04.js` for the initialization
scenarios the earlier ticket covered; the isolation run above is what this ticket adds.

What the isolation run asserts: two unrelated users of two personal workspaces cannot list,
read, modify, delete or reference each other's Bots, conversations or attachments (404 that
carries nothing); the id they cannot reach is the same id the owner reads back byte-for-byte;
sign-out ends the session's access to business data (401) and an account switch on one client
leaves nothing of the previous identity in what the next one sees; anonymous requests answer
401, distinguishable from B's authenticated 404. Connections and shared accounts are verified
at the store/route level by `server/tests/casdoor-cross-user-isolation.integration.test.ts`
against a real PostgreSQL, including the workspace binding of a deployment-held shared account
and its rebinding on re-consent.

Not covered here: real model turns (no Intelligence project), native mobile/desktop clients
(the shared backend contract is exercised by two independent browser contexts), and T05's
computer-runtime isolation, which is its own ticket.

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
`OPENBOT_TEST_FAULT_FILE` is set, which only `deploy/t04/launch.ts` does; the file lives in the
0700 `.runtime` directory, is consumed after one hit, and no request can steer it. The
controller's `/verify-user` fixture marks a test identity verified in the Casdoor database (the
IdP's own data) so password logins carry a verified claim; the one real mail-code verification is
demonstrated in the S0 scenario.

`bun deploy/t04/run.ts kill` terminates only the tracked server process (ownership verified via
`lsof` executable match); `bun deploy/t04/run.ts stop`, or `bash deploy/t04/stop.sh`, stops the
tracked processes and the Compose project. Neither removes volumes. Secrets stay in `.env.t04`
(0600) and `.runtime` (0700); `deploy/t04/secret-check.ts` asserts none leaked into tracked
source, the web build or the implementation report.

Not covered here: native mobile/desktop clients (the shared backend contract is covered by two
independent web contexts), model conversations (no Intelligence calls are made), and production
SLA timings — the retry budget above is a test policy, not an SLO.
