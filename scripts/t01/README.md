# T01 — isolated OpenBot + real Casdoor integration environment

Reusable, isolated integration environment for ticket #2 ([Casdoor T01]):
a fresh OpenBot server deployment plus a real Casdoor, on loopback ports that
cannot collide with an existing local deployment.

**Status: scaffolded, NOT RUN.** Every script fails loudly when a prerequisite
is missing (no container runtime was available when this tree was written —
see the ticket's implementation.md). Nothing here has produced a passing
claim yet, and the ticket stays blocked on the modifiable-server entry (AC-01)
regardless of how far this environment gets.

## What this proves and what it cannot

| AC | Coverage here |
| --- | --- |
| AC-01 modifiable entry | **NOT covered.** Upstream publishes only compiled images; no `server/` source exists in this checkout or upstream. Blocked. |
| AC-02 fixed & isolated | covered by `00-pin-images.sh` + `compose.t01.yml` (own project/network/volumes/ports, digests, fresh DBs) |
| AC-03 real login success | browser steps here + `30-login-success.sh` assertions |
| AC-04 login failures | `31-login-failures.sh` + browser cases below |
| AC-05 login-initialization hook | **NOT covered** — needs AC-01. Blocked. |
| AC-06 session revoke (own sessions only) | `40-session-revoke.sh`; admin-level/system-wide revoke = disclosed API gap |
| AC-07 stop execution/computer (single, with auto-restart semantics disclosed) | `50-stop-computer.sh`; global stop + no-reschedule = disclosed API gap |
| AC-08 cross-user isolation | `60-cross-user.sh` |
| AC-09 restart repeat | `70-restart-rerun.sh` + one fresh-deploy run from empty volumes |
| AC-10 config & secret audit | manual checklist below + `80-secret-scan.sh` |

## Prerequisites

- Docker with the compose v2 plugin; ports `127.0.0.1:18000/13010/13001` free.
- Pull access to ghcr.io (OpenBot server image) and Docker Hub.
- Node on PATH (the scripts parse JSON with it).
- gitleaks for the full AC-10 scan.
- CopilotKit license token / Intelligence settings: the server refuses to
  start without them (`docs/configuration.md`); put them in `.env.t01`.
- Casdoor admin credentials: the all-in-one image seeds a built-in admin;
  change its password on first login, then record the new one in `.env.t01`.

## Runbook

```sh
cd scripts/t01
cp .env.t01.example .env.t01     # fill every <generate> and every T01_ credential
00-pin-images.sh                 # resolves + locks the three image digests
10-up.sh                         # fresh stack from empty volumes, waits for health
```

1. Log into Casdoor at `http://127.0.0.1:18000` as the built-in admin,
   change its password, put it into `.env.t01`.
2. `20-casdoor-app.sh` — creates the `openbot-t01` application
   (confidential client, authorization-code + PKCE S256) and the test
   identities `t01-admin@t01.test`, `t01-user@t01.test`, `t01-user2@t01.test`.
3. Register the OIDC provider in OpenBot **Admin → Identity providers**:
   issuer/discovery `http://127.0.0.1:18000`, redirect URI
   `http://127.0.0.1:13010/api/auth/callback/<providerId>` — take the real
   `<providerId>` from the registration response and correct the Casdoor
   application's redirect URI to match, character for character. All
   discovery endpoints come from `127.0.0.1:18000`, which is in
   `TRUSTED_ORIGINS`; a registration attempt against any other host must be
   refused by the server (that refusal is itself AC-04 evidence).
4. Browser login chain (AC-03): in a real browser, sign in to OpenBot at
   `http://127.0.0.1:13010` via Casdoor as `t01-user` (and separately as
   `t01-admin`); record the authorize-redirect → callback 302 → exchange
   timeline. Export each session's cookies with curl's Netscape jar format:
   `T01_COOKIE_ADMIN=/path/admin.jar T01_COOKIE_USER=/path/user.jar`.
5. With the admin jar, read `T01_ORG_ID` and the person ids from
   `GET /api/v2/organizations` / `.../people` and export them.
6. Browser failure cases (AC-04) — record each observed rejection into
   `evidence/login-failures.md` under its case id: `denied-consent`,
   `wrong-password`, `wrong-issuer`, `state-mismatch`, `nonce-mismatch`.
   `31-login-failures.sh` refuses to pass while any section is missing.
7. Heartbeat writer inside the target computer container (AC-07):
   `while true; do date -u +%s >> /tmp/t01-heartbeat; sleep 10; done &`
   then run `50-stop-computer.sh` with the pre/post heartbeat tails exported.
8. `40-session-revoke.sh`, `60-cross-user.sh`, `70-restart-rerun.sh`,
   `80-secret-scan.sh`, then `t01-down.sh`.

Repeat the whole runbook from empty volumes at least once for the AC-09
fresh-deploy record.

## AC-10 manual checklist (report inputs)

- issuer in the server registration equals the Casdoor discovery `issuer`,
  character for character; recorded in the report.
- callback whitelist holds exactly `http://127.0.0.1:13010/api/auth/callback/<providerId>`.
- `TRUSTED_ORIGINS` = the two test origins only; proxy/trust assumptions stated.
- client secret lives only in the server's registration, encrypted at rest
  with `KEY_ENCRYPTION_KEY`; JWKS/key id and Casdoor cert rotation noted.
- `80-secret-scan.sh` clean; report and any client artifacts carry no server
  secret, private key, or reusable token/cookie/code.

## Known API gaps (disclosed, not simulated)

1. No admin-level "revoke any person's session" and no system-wide
   revoke-all: `deleteSession` is strictly self-service
   (`api/openapi/accounts.yaml`, `SignedInOwnOnly`).
2. `computers/stop` stops one computer but "it starts again when a Bot next
   needs it" (`api/openapi/computers.yaml`) — no entry stops all background
   execution and prevents re-scheduling.
3. No hook or extension point in the login-initialization path; needs the
   modifiable server entry (AC-01), which remains the ticket's blocker.
