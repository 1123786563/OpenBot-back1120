# Verify public Casdoor registration and personal workspaces

Run commands from the repository root with Bun 1.4.3. These scripts use only the `openbot-t02` Compose project and the private `deploy/t02/.env.t02` file. The generated `OPENBOT_LISTEN_HOSTNAME=127.0.0.1` sets the actual Bun listener. `verify-listeners.ts` checks live sockets and health at startup. Host ports bind to 127.0.0.1: Casdoor 19000, OpenBot 14001, PostgreSQL 56432, Mailpit 18025. Do not reuse an occupied port or another deployment's configuration.

1. Run `bun deploy/t02/setup.ts` once. It refuses to overwrite existing secrets.
2. Run `bun deploy/t02/configure-model.ts <authorized-seven-field-env-file>`. The loader accepts only the seven Intelligence and model fields listed in `environment.ts`. It does not load authentication settings.
3. Run `bun install --frozen-lockfile`. Run `T02_BUN=bun bash deploy/t02/up.sh`. The script starts the independent data services, provisions the public application and local SMTP provider, applies migrations, builds the Web app, and starts the source server and worker. It also prepares the separate `openbot_t02_unit` test database.
4. Open `http://localhost:14001/sign`. Continue with Casdoor and choose **sign up now**. Register a new username and ordinary public email. Registration does not verify the address or grant business access.
5. A password login before verification returns to the sign-in page. Direct business API requests return 403 `EMAIL_VERIFICATION_REQUIRED`.
6. Start Casdoor sign-in again. Choose **Code**, enter the registered email, and request a code. Open the locally captured message in `http://localhost:18025`. Enter its code on the Casdoor page. This real Casdoor login verifies the existing address and completes the authorization-code callback. Do not use **Reset Email** with the same address: this fixed Casdoor build reports “Email already exists.”
7. Read `/api/me`. The user has platform role `user` and an owned personal workspace. Complete the existing onboarding screen. In **Settings → General → Your workspace**, rename the space and refresh to read the saved name.
8. Use the authenticated browser's public API session to POST `/api/agents` with `{"name":"Personal bot","title":"Personal","roleDescription":"Help in my workspace","visibility":"private"}`. Expect 201. GET `/api/agents/<returned-id>` returns 200 and the same owner and organization. No model request is needed for this CRUD check.

For repeatable verification, invoke the provided Agent browser's `browser_run_code_unsafe` with filename `OpenBot/deploy/t02/verify.js` from the run workspace. The script creates new Gmail and Outlook test identities through the actual Web pages, reads only Mailpit mail, completes real Casdoor callbacks, and asserts business, permission, bypass and recovery results. It keeps credentials and callbacks in browser memory and returns only sanitized evidence. Save that returned object to `deploy/t02/evidence/verification.json`, then run `bun deploy/t02/run.ts persistence` to independently assert database ownership and uniqueness. Repeated verification retains previous test data and creates fresh names.

The automatic recovery checks submit cancellation, wrong state, invalid code, and a previously consumed real callback to the public callback route. They require a retry message and no business session, then successfully reauthorize the same user and assert that the workspace is unchanged. They do not simulate an identity provider or mint sessions.

Run `bun deploy/t02/run.ts stop` to stop only tracked source processes, or `T02_BUN=bun bash deploy/t02/stop.sh` to also stop this Compose project. Neither command removes volumes. The PID checks refuse to signal a process whose command, start time or workspace differs.

Optional computer execution is under the Compose `execution` profile and port 46430. The CRUD acceptance does not start that profile or claim to validate model conversations, computer actions, concurrency, injected initialization failures, or full cross-feature isolation. T01 services remain outside these scripts.

Runtime files and secrets stay in ignored `.runtime` (0700) and `.env.t02` (0600), and both are excluded from Docker build context. Do not save raw mail, cookies, tokens or callback URLs in evidence or screenshots.
