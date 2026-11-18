async function _verifyT03(page) {
  try {
  /*
   * Casdoor T03: concurrent first sign-ins and initialization recovery, through the real pages.
   *
   * Everything below uses the public OpenBot API and the real Casdoor login — no session is ever
   * minted directly. Failures and restarts are driven through the private T03 controller
   * (deploy/t03/controller.ts, loopback only), which writes the fault file and signals the server
   * process exactly as the launcher scripts do. The object returned at the end holds only
   * sanitized facts: identifiers, statuses, timestamps. No password, mail code, cookie, token or
   * callback URL is kept.
   *
   * Signup is provisioned with auto-sign-in off, so every identity below starts genuinely
   * uninitialized: known to Casdoor, never seen by OpenBot. That is what makes the first OAuth
   * callback raceable and breakable on purpose.
   */
  const base = "http://localhost:14002";
  const control = "http://127.0.0.1:14099";
  const evidence = [];
  const check = (ok, message) => {
    if (!ok) throw Error(message);
  };
  const now = () => new Date().toISOString();
  const consumedMails = new Set();
  // Every converged identity this run touched, for the persistence conclusions.
  const identitiesAll = [];
  const recordIdentity = (userId, workspaceId) => {
    identitiesAll.push({ userId, workspaceId });
  };
  // No fault from a previous run may greet the first scenario.
  await clearFault();

  async function clearFault() {
    return controller("/clear");
  }
  async function controller(action, body) {
    const r = await fetch(`${control}${action}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body ?? {}),
    });
    const j = await r.json();
    check(j.ok !== false || action === "/ping", `controller ${action} failed`);
    return j;
  }
  const armFault = async (point) => {
    await clearFault();
    return controller("/arm", { mode: "fault", point });
  };
  const armBarrier = async (point, parties) => {
    await clearFault();
    return controller("/arm", { mode: "barrier", point, parties });
  };

  function apiFor(context) {
    return async function api(method, path, data, expected) {
      const response = await context.request.fetch(base + path, {
        method,
        ...(data ? { data } : {}),
        headers: { Origin: base },
      });
      const body = await response.json().catch(() => null);
      check(
        response.status() === expected,
        `${method} ${path.split("?")[0]} expected ${expected}, got ${response.status()}`,
      );
      return { status: response.status(), body };
    };
  }

  async function newClient() {
    const browser = page.context().browser();
    // English UI in every client: the browser's locale decides which language OpenBot renders.
    const context = await browser.newContext({ locale: "en-US" });
    return { context, api: apiFor(context) };
  }

  async function mailCode(email) {
    // Only mails not consumed by an earlier read count: two code logins for one address must
    // each take their own message.
    for (let n = 0; n < 60; n++) {
      const list = await (
        await page.request.get("http://localhost:18026/api/v1/messages")
      ).json();
      const found = list.messages.find(
        (m) =>
          !consumedMails.has(m.ID) &&
          m.To?.some((to) => to.Address === email),
      );
      if (found) {
        const mail = await (
          await page.request.get(
            `http://localhost:18026/api/v1/message/${found.ID}`,
          )
        ).json();
        const code = mail.Text.match(/\b\d{6}\b/)?.[0];
        if (code) {
          consumedMails.add(found.ID);
          return code;
        }
      }
      await page.waitForTimeout(250);
    }
    throw Error("Casdoor verification mail did not arrive");
  }

  const CASDOOR = "http://localhost:19001";
  async function registerOn(context, domain, leaveUnverified = false) {
    /*
     * Register through Casdoor's own application signup page, not through the OpenBot sign-in
     * flow. The OAuth-linked signup (`/signup/oauth/authorize`) continues the authorization after
     * creating the account, which would initialize the identity here before any scenario starts.
     * The standalone page leaves the account known to Casdoor and unseen by OpenBot — the
     * genuinely uninitialized state the first sign-in scenarios need.
     */
    await context.clearCookies();
    const p = await context.newPage();
    await p.goto(`${CASDOOR}/signup/app-t03`);
    const name = `t03${Date.now()}${Math.random().toString(36).slice(2, 7)}`;
    const user = {
      name,
      email: `${name}@${domain}`,
      unverified: leaveUnverified,
      password:
        "T03!" +
        Math.random().toString(36).slice(2) +
        Math.random().toString(36).slice(2),
    };
    await p
      .getByRole("textbox", { name: "Username*", exact: true })
      .fill(name);
    await p
      .getByRole("textbox", { name: "Display name*", exact: true })
      .fill("T03 verification");
    await p
      .getByRole("textbox", { name: "Password*", exact: true })
      .fill(user.password);
    await p
      .getByRole("textbox", { name: "Confirm*", exact: true })
      .fill(user.password);
    await p
      .getByRole("textbox", { name: "Email*", exact: true })
      .fill(user.email);
    // Casdoor's submit button never satisfies Playwright's stability check (it re-renders on
    // every keystroke), so the click is delivered as an event.
    await p.locator("button.signup-button").dispatchEvent("click");
    await p.waitForURL((url) => url.pathname.startsWith("/result/"), {
      timeout: 30000,
      waitUntil: "commit",
    });
    const fresh = await context.request
      .fetch(`${base}/api/auth/get-session`, { headers: { Origin: base } })
      .then((r) => r.json())
      .catch(() => null);
    check(!fresh?.session, "registration must not create a local session");
    await p.close();
    // Test-IdP fixture: mark the address verified in Casdoor's own data, so a password login
    // carries a verified claim. OpenBot's database is never touched by hand; the one real
    // mail-code verification is demonstrated separately in S0.
    if (!user.unverified) {
      const done = await controller("/verify-user", { name });
      check(done.verified, "fixture verification of the new identity failed");
    }
    return user;
  }

  async function beginSignIn(context) {
    const body = await apiFor(context)(
      "POST",
      "/api/auth/sign-in/social",
      {
        provider: "casdoor",
        callbackURL: base,
        errorCallbackURL: `${base}/sign?error=AUTH_CALLBACK_FAILED`,
      },
      200,
    );
    return body.body.url;
  }

  async function passwordLogin(context, user) {
    const p = await context.newPage();
    const started = now();
    try {
      await context.clearCookies();
      await p.goto(await beginSignIn(context));
      await p
        .getByRole("textbox", { name: "Username", exact: true })
        .fill(user.name);
      await p
        .getByRole("textbox", { name: "Password", exact: true })
        .fill(user.password);
      await p.locator("button.login-button").dispatchEvent("click");
      await p.waitForURL((u) => u.origin === base, { timeout: 30000, waitUntil: "commit" });
      // The app routes client-side after landing; give the router a moment to settle so the
      // final path (sign page for a refused callback, onboarding for success) is the real one.
      await p.waitForTimeout(1500);
      const url = p.url();
      return {
        ended: now(),
        started,
        atSign: new URL(url).pathname.startsWith("/sign"),
      };
    } finally {
      await p.close().catch(() => {});
    }
  }

  /** Prepare a code login up to the filled code; the caller submits when it wants. */
  async function prepareCodeLogin(context, user) {
    const p = await context.newPage();
    await context.clearCookies();
    await p.goto(await beginSignIn(context));
    await p.getByRole("tab", { name: "Code", exact: true }).click();
    await p
      .getByRole("textbox", { name: "Email or phone", exact: true })
      .fill(user.email);
    const sent = p.waitForResponse((r) =>
      r.url().includes("/api/send-verification-code"),
    );
    await p.getByRole("button", { name: "Get Code", exact: true }).click();
    check((await (await sent).json()).status === "ok", "Email send failed");
    const code = await mailCode(user.email);
    for (let i = 0; i < 6; i++) await p.getByRole("textbox").nth(i).fill(code[i]);
    return p;
  }

  /** Prepare a password login up to the filled credentials; the caller submits when it wants. */
  async function preparePasswordLogin(context, user) {
    const p = await context.newPage();
    await context.clearCookies();
    await p.goto(await beginSignIn(context));
    await p
      .getByRole("textbox", { name: "Username", exact: true })
      .fill(user.name);
    await p
      .getByRole("textbox", { name: "Password", exact: true })
      .fill(user.password);
    return p;
  }

  async function submitPrepared(p) {
    const started = now();
    await p.locator("button.login-button").dispatchEvent("click");
    await p.waitForURL((u) => u.origin === base, { timeout: 30000, waitUntil: "commit" });
    await p.waitForTimeout(1500);
    const url = p.url();
    return {
      started,
      ended: now(),
      atSign: new URL(url).pathname.startsWith("/sign"),
      url,
    };
  }

  async function codeLogin(context, user) {
    const p = await prepareCodeLogin(context, user);
    try {
      return await submitPrepared(p);
    } finally {
      await p.close().catch(() => {});
    }
  }

  /** Submit two prepared Casdoor pages at the same moment, on two independent contexts. */
  async function simultaneousSubmit(pa, pb) {
    const started = now();
    const [ra, rb] = await Promise.allSettled([
      submitPrepared(pa),
      submitPrepared(pb),
    ]);
    const outcome = (r) =>
      r.status === "fulfilled"
        ? { through: true, atSign: r.value.atSign, started: r.value.started, ended: r.value.ended }
        : { through: false, error: String(r.reason).split("\n")[0].slice(0, 120) };
    return { started, ended: now(), a: outcome(ra), b: outcome(rb) };
  }

  const sessionOf = async (context) =>
    context.request
      .fetch(`${base}/api/auth/get-session`, { headers: { Origin: base } })
      .then((r) => r.json())
      .catch(() => null);
  const me = async (api) => {
    const user = (await api("GET", "/api/me", null, 200)).body.user;
    recordIdentity(user.id, user.workspace.id);
    return user;
  };
  const anonymousChecks = async (api, stage) => {
    await api("GET", "/api/agents", null, 401);
    await api("POST", "/api/agents", { name: "x" }, 401);
    await api("GET", "/api/admin/people", null, 401);
    evidence.push({ scenario: `anonymous-after-${stage}`, refused: true });
  };
  const denialChecks = async (api, otherBotId, otherOrgId, stage) => {
    // A session without business readiness: own resources and everyone else's are refused, and
    // a forged organization pointer buys nothing.
    await api("GET", "/api/me", null, 403);
    await api("GET", "/api/agents", null, 403);
    await api("POST", "/api/agents", { name: "x" }, 403);
    if (otherBotId) await api("GET", `/api/agents/${otherBotId}`, null, 403);
    if (otherOrgId)
      await api(
        "POST",
        "/api/auth/organization/set-active",
        { organizationId: otherOrgId },
        403,
      );
    await api("GET", "/api/admin/people", null, 403);
    evidence.push({ scenario: `denial-after-${stage}`, refused: true });
  };
  const botBody = {
    name: "T03 real bot",
    title: "Personal",
    roleDescription: "Help in my workspace",
    visibility: "private",
  };

  /*
   * S0 — baseline: identity A verifies, owns one workspace, does Bot CRUD; B cannot reach it.
   * This is the AC-06 shape every later scenario re-asserts after recovery.
   */
  // Identity A alone takes the unverified path (real mail-code verification after it); every
  // later identity is fixture-verified at registration.
  // A gets a context of its own that no later registration will clear.
  const clientA = await newClient();
  const a = await registerOn(clientA.context, "gmail.com", true);
  const firstLoginA = await passwordLogin(clientA.context, a);
  check(
    firstLoginA.atSign,
    "an unverified password sign-in returns to the sign page (documented behaviour)",
  );
  const apiMain = clientA.api;
  // The unverified session exists but is closed to the business API.
  const unverifiedSession = await sessionOf(clientA.context);
  check(!!unverifiedSession?.session, "unverified sign-in still holds a session");
  await denialChecks(apiMain, null, null, "S0-unverified");
  // Real verification: the Casdoor mail-code login, read from the local mailbox.
  await codeLogin(clientA.context, a);
  const meA = await me(apiMain);
  check(meA.role === "user" && meA.workspace.role === "owner", "A authority");
  await apiMain("PATCH", "/api/workspace", { name: "T03 verified workspace" }, 200);
  check(
    (await apiMain("GET", "/api/workspace", null, 200)).body.workspace.name ===
      "T03 verified workspace",
    "rename persisted",
  );
  const botA = (await apiMain("POST", "/api/agents", botBody, 201)).body.agent;
  check(
    (await apiMain("GET", `/api/agents/${botA.id}`, null, 200)).body.agent
      .organizationId === meA.workspace.id,
    "bot scope",
  );
  await apiMain("GET", "/api/admin/people", null, 403);
  // Registration never touches A's context: clearCookies there would end A's session.
  const scratch = await newClient();
  const b = await registerOn(scratch.context, "outlook.com");
  await scratch.context.close();
  const clientB = await newClient();
  await codeLogin(clientB.context, b);
  await clientB.api("GET", `/api/agents/${botA.id}`, null, 404);
  await clientB.api(
    "POST",
    "/api/auth/organization/set-active",
    { organizationId: meA.workspace.id },
    403,
  );
  const meB = await me(clientB.api);
  check(meB.workspace.id !== meA.workspace.id, "separate workspaces");
  evidence.push({
    scenario: "S0-baseline",
    a: { userId: meA.id, workspaceId: meA.workspace.id, botId: botA.id },
    b: { userId: meB.id, workspaceId: meB.workspace.id },
  });

  /*
   * S1 — AC-01: two independent clients race the same uninitialized identity at the user-creation
   * write, released together by the server-side barrier. One wins; the loser sees the safe retry
   * page, and its retry converges on the winner's user and workspace.
   */
  const c = await registerOn(page.context(), "gmail.com");
  let meC;
  {
    // Casdoor itself occasionally refuses one of two simultaneous logins (state mismatch) —
    // a safe, retryable failure of the provider flow, not of convergence. The race is retried
    // up to three times within the fixed budget; only an attempt where both real callbacks
    // were released together by the barrier counts as the overlap evidence.
    let attempt = 0;
    let race = null;
    let armed = null;
    let clientC1 = null;
    let clientC2 = null;
    let winner = null;
    let loser = null;
    let winnerId = null;
    while (attempt < 3) {
      attempt += 1;
      armed = await armBarrier("before-user-insert", 2);
      clientC1 = await newClient();
      clientC2 = await newClient();
      const pa = await clientC1.context.newPage();
      const pb = await clientC2.context.newPage();
      await pa.goto(await beginSignIn(clientC1.context));
      await pb.goto(await beginSignIn(clientC2.context));
      for (const p of [pa, pb]) {
        await p
          .getByRole("textbox", { name: "Username", exact: true })
          .fill(c.name);
        await p
          .getByRole("textbox", { name: "Password", exact: true })
          .fill(c.password);
      }
      race = await simultaneousSubmit(pa, pb);
      await pa.close().catch(() => {});
      await pb.close().catch(() => {});
      await clearFault();
      const s1 = await sessionOf(clientC1.context);
      const s2 = await sessionOf(clientC2.context);
      const winners = [s1, s2].filter((s) => s?.session);
      if (winners.length === 1) {
        winner = s1?.session ? clientC1 : clientC2;
        loser = s1?.session ? clientC2 : clientC1;
        winnerId = (s1 ?? s2).user.id;
        break;
      }
      evidence.push({
        scenario: "S1-race-retry",
        attempt,
        race,
        note: "no session or both sessions; provider-level refusal, retried",
      });
      await clientC1.context.close();
      await clientC2.context.close();
      clientC1 = clientC2 = winner = loser = null;
    }
    check(winner !== null, "exactly one racing client may sign in (3 attempts)");
    // The race loser holds no session and no business access.
    await anonymousChecks(loser.api, "S1-loser");
    // The loser retries through the ordinary entry and lands on the winner's identity.
    const retry = await passwordLogin(loser.context, c);
    check(!retry.atSign, "loser retry should sign in");
    const loserId = (await sessionOf(loser.context)).user.id;
    check(loserId === winnerId, "retry converged on the same user");
    // Both verified clients are business-ready on the same space right after convergence.
    const meC1 = await me(winner.api);
    const meC2 = await me(loser.api);
    meC = meC1;
    check(meC1.id === winnerId, "verified session kept the raced user id");
    check(meC2.id === meC1.id, "both clients on one user");
    check(meC1.workspace.id === meC2.workspace.id, "both clients on one workspace");
    const bot = (await winner.api("POST", "/api/agents", botBody, 201)).body.agent;
    check(
      (await loser.api("GET", `/api/agents/${bot.id}`, null, 200)).body.agent.id === bot.id,
      "both racing clients read the same bot",
    );
    evidence.push({
      scenario: "S1-concurrent-first-login",
      attempts: attempt,
      armed: armed.stdout,
      race,
      identity: { userId: meC1.id, workspaceId: meC1.workspace.id },
    });
    await clientC1.context.close();
    await clientC2.context.close();
  }

  /*
   * S1b — AC-01 at the workspace write: two clients complete verified logins for the same
   * uninitialized identity, released together at the workspace boundary; both land on one
   * organization.
   */
  const d = await registerOn(page.context(), "gmail.com");
  {
    // Same retry contract as S1: Casdoor can refuse one of two simultaneous logins; a clean
    // attempt is retried up to three times.
    let dRace = null;
    let dArmed = null;
    let clientD1 = null;
    let clientD2 = null;
    for (let attempt = 1; attempt <= 3; attempt++) {
      dArmed = await armBarrier("before-workspace-ensure", 2);
      clientD1 = await newClient();
      clientD2 = await newClient();
      const p1 = await preparePasswordLogin(clientD1.context, d);
      const p2 = await preparePasswordLogin(clientD2.context, d);
      dRace = await simultaneousSubmit(p1, p2);
      await p1.close().catch(() => {});
      await p2.close().catch(() => {});
      await clearFault();
      const anySession =
        (await sessionOf(clientD1.context))?.session ||
        (await sessionOf(clientD2.context))?.session;
      if (anySession) break;
      evidence.push({
        scenario: "S1b-race-retry",
        attempt,
        race: dRace,
      });
      await clientD1.context.close();
      await clientD2.context.close();
      clientD1 = clientD2 = null;
    }
    check(clientD1 !== null, "workspace race produced a session (3 attempts)");
    // Whoever the race held back retries through the ordinary entry.
    for (const client of [clientD1, clientD2]) {
      const s = await sessionOf(client.context);
      if (!s?.session) await passwordLogin(client.context, d);
    }
    const meD1 = await me(clientD1.api);
    const meD2 = await me(clientD2.api);
    check(meD1.id === meD2.id, "D clients converge on one user");
    check(meD1.workspace.id === meD2.workspace.id, "D clients share one workspace");
    evidence.push({
      scenario: "S1b-concurrent-workspace-ensure",
      armed: dArmed.stdout,
      race: dRace,
      identity: { userId: meD1.id, workspaceId: meD1.workspace.id },
    });
    await clientD1.context.close();
    await clientD2.context.close();
  }

  /*
   * S2 — AC-02/AC-04: one real server fault at each of the initialization boundaries, each with a
   * fresh uninitialized identity. After every failure the client must be closed out of the
   * business API, A's resources, and the platform; after disarming, an ordinary new authorization
   * converges on the surviving identity, user id and workspace id, with a working Bot.
   */
  async function faultScenario(name, point) {
    const user = await registerOn(page.context(), "gmail.com");
    const armed = await armFault(point);
    const client = await newClient();
    const failure = await passwordLogin(client.context, user);
    check(failure.atSign, `${name}: failure must land on the safe sign page`);
    await clearFault();
    await anonymousChecks(client.api, name);
    const recovery = await passwordLogin(client.context, user);
    check(!recovery.atSign, `${name}: retry must complete`);
    const m = await me(client.api);
    check(m.role === "user" && m.workspace.role === "owner", `${name} authority`);
    const bot = (await client.api("POST", "/api/agents", botBody, 201)).body.agent;
    check(
      bot.organizationId === m.workspace.id &&
        (await client.api("GET", `/api/agents/${bot.id}`, null, 200)).body.agent.id === bot.id,
      `${name} bot usable after recovery`,
    );
    await client.api("GET", `/api/agents/${botA.id}`, null, 404);
    evidence.push({
      scenario: name,
      faultPoint: point,
      armed: armed.stdout,
      failure: { atSign: failure.atSign, ended: failure.ended },
      recovery: { ended: recovery.ended },
      identity: { userId: m.id, workspaceId: m.workspace.id },
    });
    await client.context.close();
  }
  await faultScenario("S2a-before-user-insert", "before-user-insert");
  await faultScenario("S2b-user-committed", "user-committed");
  await faultScenario("S2c-before-workspace-ensure", "before-workspace-ensure");
  await faultScenario("S2d-workspace-ensured", "workspace-ensured");
  await faultScenario("S2e-session-committed", "session-committed");

  /*
   * S3 — AC-03: kill the server inside the write, twice. First inside the identity transaction
   * (nothing committed yet), then at the workspace boundary with the account already committed.
   * The database stays; the restarted process must converge from what is on disk, and the two
   * recoveries must run in parallel against it.
   */
  {
    const e = await registerOn(page.context(), "gmail.com");
    const armedE = await armBarrier("before-user-insert", 2);
    const clientE1 = await newClient();
    const clientE2 = await newClient();
    const pa = await clientE1.context.newPage();
    const pb = await clientE2.context.newPage();
    await pa.goto(await beginSignIn(clientE1.context));
    await pb.goto(await beginSignIn(clientE2.context));
    for (const [p, u] of [[pa, e], [pb, e]]) {
      await p.getByRole("textbox", { name: "Username", exact: true }).fill(u.name);
      await p.getByRole("textbox", { name: "Password", exact: true }).fill(u.password);
    }
    const racePromise = Promise.allSettled([
      submitPrepared(pa),
      submitPrepared(pb),
    ]);
    await page.waitForTimeout(2500);
    const killed = await controller("/kill-server");
    await racePromise.catch(() => {});
    await pa.close().catch(() => {});
    await pb.close().catch(() => {});
    await clearFault();
    const restarted = await controller("/start-server", { faults: false });
    check(restarted.up, "server restarted after identity-stage kill");
    const retryE1 = await passwordLogin(clientE1.context, e);
    const retryE2 = await passwordLogin(clientE2.context, e);
    check(!retryE1.atSign && !retryE2.atSign, "both restart retries succeed");
    const meE1 = await me(clientE1.api);
    const meE2 = await me(clientE2.api);
    check(meE1.id === meE2.id, "restart converged on one user");
    check(meE1.workspace.id === meE2.workspace.id, "restart converged on one workspace");
    const botE = (await clientE1.api("POST", "/api/agents", botBody, 201)).body.agent;
    check(
      (await clientE2.api("GET", `/api/agents/${botE.id}`, null, 200)).body.agent.id === botE.id,
      "both clients read the same bot after restart",
    );
    evidence.push({
      scenario: "S3a-kill-inside-identity-transaction",
      armed: armedE.stdout,
      killedAt: killed.at,
      restartedUp: restarted.up,
      identity: { userId: meE1.id, workspaceId: meE1.workspace.id },
    });
    await clientE1.context.close();
    await clientE2.context.close();
  }
  {
    // The account is committed, the workspace is not; two verified logins are held at the
    // workspace boundary, the server dies under them, and both recover in parallel.
    const f = await registerOn(page.context(), "gmail.com", true);
    const clientF1 = await newClient();
    const clientF2 = await newClient();
    // First login while the fixture address is still unverified: user and account commit, the
    // workspace does not exist yet.
    await passwordLogin(clientF1.context, f);
    const idF = (await sessionOf(clientF1.context)).user.id;
    const meFPre = await clientF1.api("GET", "/api/me", null, 403);
    evidence.push({ scenario: "S3b-pre-state", unverifiedRefused: meFPre.status });
    const doneF = await controller("/verify-user", { name: f.name });
    check(doneF.verified, "fixture verification of F failed");
    const armedF = await armBarrier("before-workspace-ensure", 2);
    const pf1 = await preparePasswordLogin(clientF1.context, f);
    const pf2 = await preparePasswordLogin(clientF2.context, f);
    const raceF = Promise.allSettled([submitPrepared(pf1), submitPrepared(pf2)]);
    await page.waitForTimeout(2500);
    const killedF = await controller("/kill-server");
    await raceF.catch(() => {});
    await pf1.close().catch(() => {});
    await pf2.close().catch(() => {});
    await clearFault();
    const restartedF = await controller("/start-server", { faults: false });
    check(restartedF.up, "server restarted after workspace-stage kill");
    // Both clients retry at the same time: recovery under concurrent load, not in sequence.
    const [recF1, recF2] = await Promise.allSettled([
      passwordLogin(clientF1.context, f),
      passwordLogin(clientF2.context, f),
    ]);
    for (const r of [recF1, recF2]) {
      if (r.status === "rejected")
        console.log(`S3b retry note: ${String(r.reason).split("\n")[0].slice(0, 120)}`);
    }
    const sF1 = await sessionOf(clientF1.context);
    const sF2 = await sessionOf(clientF2.context);
    check(sF1?.session || sF2?.session, "at least one parallel recovery succeeds");
    if (!sF1?.session) await passwordLogin(clientF1.context, f);
    if (!sF2?.session) await passwordLogin(clientF2.context, f);
    const meF1 = await me(clientF1.api);
    const meF2 = await me(clientF2.api);
    check(meF1.id === idF, "recovery kept the committed user id");
    check(meF2.id === idF, "second recovery kept the committed user id");
    check(meF1.workspace.id === meF2.workspace.id, "one workspace after parallel recovery");
    evidence.push({
      scenario: "S3b-kill-at-workspace-boundary",
      armed: armedF.stdout,
      killedAt: killedF.at,
      restartedUp: restartedF.up,
      identity: { userId: meF1.id, workspaceId: meF1.workspace.id },
    });
    await clientF1.context.close();
    await clientF2.context.close();
  }

  /*
   * S4 — AC-05: replay of a genuinely captured callback — sequential and concurrent — plus wrong
   * state and invalid code, refresh and a later full relogin. Replays grant nothing; the
   * legitimate client keeps its exact ids and name.
   */
  {
    const g = await registerOn(page.context(), "gmail.com");
    const clientG = await newClient();
    // The callback URL is captured on the very page that signs in.
    const p = await preparePasswordLogin(clientG.context, g);
    let capturedCallback = null;
    p.on("request", (req) => {
      if (req.url().startsWith(`${base}/api/auth/callback/casdoor?code=`))
        capturedCallback = req.url();
    });
    await submitPrepared(p);
    check(capturedCallback !== null, "captured a real callback URL");
    await p.close();
    const meBefore = await me(clientG.api);
    await clientG.api("PATCH", "/api/workspace", { name: "T03 replay-kept name" }, 200);

    // Sequential replay from a context with no cookies.
    const replay1 = await newClient();
    await replay1.context.request
      .fetch(capturedCallback, { headers: { Origin: base } })
      .then((r) => r.status());
    await anonymousChecks(replay1.api, "S4-sequential-replay");
    // Concurrent replay from two fresh contexts.
    const replay2 = await newClient();
    const replay3 = await newClient();
    const [rr2, rr3] = await Promise.all([
      replay2.context.request
        .fetch(capturedCallback, { headers: { Origin: base } })
        .then((r) => r.status()),
      replay3.context.request
        .fetch(capturedCallback, { headers: { Origin: base } })
        .then((r) => r.status()),
    ]);
    await anonymousChecks(replay2.api, "S4-concurrent-replay-1");
    await anonymousChecks(replay3.api, "S4-concurrent-replay-2");
    // The legitimately signed-in client is untouched by all of it.
    const meAfter = await me(clientG.api);
    check(
      meAfter.id === meBefore.id && meAfter.workspace.id === meBefore.workspace.id,
      "legit client unchanged by replays",
    );

    // Wrong state and invalid code, straight to the public callback route.
    for (const [label, url] of [
      ["wrong-state", `${base}/api/auth/callback/casdoor?code=invalid&state=wrong-state`],
      ["invalid-code", `${base}/api/auth/callback/casdoor?code=invalid&state=not-a-state`],
    ]) {
      const visitor = await newClient();
      // Redirects are not followed: the assertion is that the callback itself refuses with a
      // redirect to the safe error page, never a session.
      const status = await visitor.context.request
        .fetch(url, { headers: { Origin: base }, maxRedirects: 0 })
        .then((r) => r.status());
      check(status >= 300 && status < 400, `${label} must not authenticate`);
      await anonymousChecks(visitor.api, `S4-${label}`);
      await visitor.context.close();
    }

    // Refresh and a later full relogin keep ids, name and resources.
    await passwordLogin(clientG.context, g);
    const meRelogin = await me(clientG.api);
    check(meRelogin.id === meBefore.id, "relogin keeps user id");
    check(meRelogin.workspace.id === meBefore.workspace.id, "relogin keeps workspace id");
    check(
      (await clientG.api("GET", "/api/workspace", null, 200)).body.workspace.name ===
        "T03 replay-kept name",
      "relogin keeps workspace name",
    );
    evidence.push({
      scenario: "S4-replay-and-idempotence",
      replayStatuses: { concurrent: [rr2, rr3] },
      identity: { userId: meBefore.id, workspaceId: meBefore.workspace.id },
    });
    await replay1.context.close();
    await replay2.context.close();
    await replay3.context.close();
    await clientG.context.close();
  }

  /*
   * S5 — AC-06 final: A's workspace, id and Bot are exactly where S0 left them after every
   * scenario above ran against the same deployment, and B still cannot reach A's bot.
   */
  {
    const meAFinal = await me(apiMain);
    check(meAFinal.id === meA.id, "A unchanged");
    check(meAFinal.workspace.id === meA.workspace.id, "A workspace unchanged");
    check(
      (await apiMain("GET", `/api/agents/${botA.id}`, null, 200)).body.agent.id === botA.id,
      "A bot readable",
    );
    await clientB.api("GET", `/api/agents/${botA.id}`, null, 404);
    evidence.push({
      scenario: "S5-final-stability",
      a: { userId: meAFinal.id, workspaceId: meAFinal.workspace.id, botId: botA.id },
    });
  }

    return {
      evidence,
      identities: [
        { userId: meA.id, workspaceId: meA.workspace.id },
        { userId: meB.id, workspaceId: meB.workspace.id },
        { userId: meC.id, workspaceId: meC.workspace.id },
      ],
      identitiesAll,
      botId: botA.id,
    };
  } catch (error) {
    return { failed: String(error), stack: error.stack };
  }
}
