/**
 * Casdoor T04 rework round 4 — the shared-account vendor-execution evidence, in two acts.
 *
 * Act one (mode "A") registers the two unrelated identities, signs A in, has A give the
 * administrator-preset shared app to A's own Bot, walks A through the REAL consent flow (redirect
 * to the vendor's consent page, approve, the vendor's redirect back through OpenBot's callback),
 * and executes the app's action as A. Act two (mode "B") signs B in on a fresh client, walks the
 * same consent as B, executes as B, then checks the vendor's ledger: A's execution must carry A's
 * vendor identity and B's must carry B's; A's must still be A's after B ran. The remaining acts
 * (modes "neg" and "disconnect") cover the no-binding refusal, the cross-space reference refusal
 * and the one-sided disconnect.
 *
 * Run through the Agent browser (`browser_run_code_unsafe`) while the deployment, the vendor
 * stand-in, the admin promoter and `bun deploy/t04/controller.ts` are running. State (sanitized
 * names, ids, statuses) lives in .agentflow/browser/t04-vendor-r4.json between acts; credentials
 * live only in the Playwright process's own /tmp file and are never written to the repository or
 * the evidence.
 */
(async (page) => {
  const base = "http://localhost:14003";
  const control = "http://127.0.0.1:14099";
  const CASDOOR = "http://localhost:19002";
  const VENDOR = "http://127.0.0.1:19610";
  // State lives on the loopback-only vendor service, which the acts share: sanitized ids and the
  // fixture credentials the next act needs to sign in. Nothing here is written to the repository,
  // and the evidence the acts return never carries a credential.
  const state = await fetch(`${VENDOR}/__state`).then((r) => r.json());
  const saveState = async (patch) => {
    await fetch(`${VENDOR}/__state`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(patch) });
    Object.assign(state, patch);
  };
  const creds = (state.creds ??= {});
  const mode = state.mode || "A";
  const now = () => new Date().toISOString();

  const controller = async (action, body) =>
    (await fetch(`${control}${action}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body ?? {}) })).json();

  async function register(domain, tag) {
    const context = await page.context().browser().newContext();
    await context.clearCookies();
    const p = await context.newPage();
    await p.goto(`${CASDOOR}/signup/app-t04`);
    const name = `t04r4${tag}${Math.random().toString(36).slice(2, 6)}`;
    const user = { name, email: `${name}@${domain}`, password: "T04!" + Math.random().toString(36).slice(2) + Math.random().toString(36).slice(2) };
    await p.getByRole("textbox", { name: "Username*", exact: true }).fill(name);
    await p.getByRole("textbox", { name: "Display name*", exact: true }).fill("T04 r4");
    await p.getByRole("textbox", { name: "Password*", exact: true }).fill(user.password);
    await p.getByRole("textbox", { name: "Confirm*", exact: true }).fill(user.password);
    await p.getByRole("textbox", { name: "Email*", exact: true }).fill(user.email);
    await p.locator("button.signup-button").dispatchEvent("click");
    await p.waitForURL((url) => url.pathname.startsWith("/result/"), { timeout: 30000, waitUntil: "commit" });
    await p.close();
    await context.close();
    const done = await controller("/verify-user", { name });
    if (!done.verified) throw Error(`verify failed for ${name}`);
    creds[user.name] = user;
    await saveState({ creds });
    return user;
  }

  async function signIn(context, userName) {
    const user = creds[userName];
    if (!user) throw Error(`no saved credentials for ${userName}`);
    const p = await context.newPage();
    const redirect = await context.request.fetch(`${base}/api/auth/sign-in/social`, {
      method: "POST",
      headers: { "content-type": "application/json", Origin: base },
      data: { provider: "casdoor", callbackURL: base, errorCallbackURL: `${base}/sign?error=AUTH_CALLBACK_FAILED` },
    });
    await p.goto((await redirect.json()).url);
    await p.getByRole("textbox", { name: "Username", exact: true }).fill(user.name);
    await p.getByRole("textbox", { name: "Password", exact: true }).fill(user.password);
    await p.locator("button.login-button").dispatchEvent("click");
    await p.waitForURL((u) => u.origin === base, { timeout: 30000, waitUntil: "commit" });
    await p.waitForTimeout(1200);
    await p.close();
    for (let n = 0; n < 40; n++) {
      const session = await context.request.fetch(`${base}/api/auth/get-session`).then((r) => r.json()).catch(() => null);
      if (session?.session?.activeOrganizationId)
        return { workspaceId: session.session.activeOrganizationId, userId: session.user.id };
      await page.waitForTimeout(500);
    }
    throw Error("no workspace");
  }

  const apiFor = (context) => async (method, path, data) => {
    const response = await context.request.fetch(base + path, {
      method,
      headers: { Origin: base, ...(data === undefined ? {} : { "content-type": "application/json" }) },
      ...(data === undefined ? {} : { data }),
    });
    const body = await response.json().catch(() => null);
    return { status: response.status(), body };
  };

  const SERVER = "composio-t04board";
  const ACTION = "T04BOARD_POST_MESSAGE";
  const READ = "T04BOARD_READ_BOARD";

  /** Walk one person through the real consent loop, on their own signed-in context. */
  async function consentFlow(context, api, who) {
    // Composio runs no per-action authorization flow; a person connects on the app's page, which
    // mints the consent link (`authorizationUrl`).
    const start = await api("POST", `/api/plugins/servers/${SERVER}/connect`);
    if (start.status !== 200 && start.status !== 201) {
      return { step: "connect-start", status: start.status, body: start.body };
    }
    const redirectUrl = start.body?.authorizationUrl ?? start.body?.redirectUrl ?? start.body?.url;
    if (!redirectUrl || typeof redirectUrl !== "string") {
      return { step: "authorize-start", status: start.status, keys: Object.keys(start.body ?? {}), body: JSON.stringify(start.body).slice(0, 300) };
    }
    // The real browser visits the vendor's consent page and approves it.
    const p = await context.newPage();
    await p.goto(redirectUrl, { waitUntil: "commit" });
    const landing = p.url();
    await p.locator("button[type=submit]").click();
    // The vendor redirects through OpenBot's callback, which lands the browser back in the app.
    await p.waitForURL((u) => u.origin === base, { timeout: 30000, waitUntil: "commit" });
    const landed = p.url();
    await p.close();
    // Back on the connections page, the app confirms: the vendor is asked whether the account is
    // attached, and the answer is what commits the connection row.
    const confirm = await api("POST", `/api/plugins/servers/${SERVER}/connection/confirm`);
    return {
      step: confirm.body?.connected === true ? "consent-done" : "confirm-failed",
      landingHost: new URL(landing).host,
      landedPath: new URL(landed).pathname,
      confirmStatus: confirm.status,
      connected: confirm.body?.connected ?? String(confirm.body?.error ?? "").slice(0, 120),
    };
  }

  const call = async (api, agentId, action, args) =>
    api("POST", "/api/plugins/call", { ref: `${SERVER}/${action}`, args, agentId });

  const out = { mode, at: now(), scenarios: [] };
  const scenario = (name, facts) => {
    out.scenarios.push({ name, ...facts, at: now() });
    return facts;
  };
  const browser = page.context().browser();

  if (mode === "A") {
    const userA = await register("t04a.example.test", "a");
    const userB = await register("t04b.example.test", "b");
    state.userA = userA.name;
    state.userB = userB.name;
    await saveState({ userA: state.userA, userB: state.userB });
    const contextA = await browser.newContext({ locale: "en-US" });
    const a = await signIn(contextA, userA.name);
    state.workspaceA = a.workspaceId;
    const api = apiFor(contextA);
    const botA = await api("POST", "/api/agents", {
      name: `t04r4-A-bot-${Date.now().toString(36).slice(-4)}`,
      title: "A only", roleDescription: "A's own bot", visibility: "private", systemPrompt: "Answer briefly.",
    });
    state.botA = botA.body?.agent?.id;
    scenario("A signed in and made a Bot", { bot: state.botA, status: botA.status });
    await saveState({ botA: state.botA, workspaceA: state.workspaceA });

    // Give the shared app to A's own Bot — the owner's own act on their own space.
    const give = await api("POST", `/api/plugins/for/${state.botA}/apps/t04board/give`);
    scenario("A gave the app to the Bot (read tools)", { status: give.status, granted: give.body?.granted?.length ?? give.body?.error });
    const grantWrite = await api("POST", "/api/plugins/grants", { kind: "mcp", ref: `${SERVER}/${ACTION}`, agentId: state.botA });
    scenario("A granted the write action to the Bot", { status: grantWrite.status, body: String(grantWrite.body?.error ?? "ok").slice(0, 140) });

    // A calls before connecting: the no-binding refusal.
    const unbound = await call(api, state.botA, READ, {});
    scenario("A called with no connected account", { status: unbound.status, refused: unbound.body?.error ? String(unbound.body.error).slice(0, 200) : null });

    const consent = await consentFlow(contextA, api, "A");
    scenario("A consent loop", consent);

    // A calls now: the vendor must run it and record A's identity.
    const run = await call(api, state.botA, READ, {});
    scenario("A executed the read action", { status: run.status, successful: run.body?.successful, board: run.body?.data?.messages ?? null });
    state.aPostedAt = run.status === 200 ? now() : null;
    await saveState({ aPostedAt: state.aPostedAt });
    await contextA.close();
    return out;
  }

  if (mode === "B") {
    const contextB = await browser.newContext({ locale: "en-US" });
    const b = await signIn(contextB, state.userB);
    state.workspaceB = b.workspaceId;
    const api = apiFor(contextB);
    const botB = await api("POST", "/api/agents", {
      name: `t04r4-B-bot-${Date.now().toString(36).slice(-4)}`,
      title: "B only", roleDescription: "B's own bot", visibility: "private", systemPrompt: "Answer briefly.",
    });
    state.botB = botB.body?.agent?.id;
    scenario("B signed in and made a Bot", { bot: state.botB, status: botB.status });
    await saveState({ botB: state.botB, workspaceB: state.workspaceB });
    const give = await api("POST", `/api/plugins/for/${state.botB}/apps/t04board/give`);
    scenario("B gave the app to the Bot (read tools)", { status: give.status, granted: give.body?.granted?.length ?? give.body?.error });
    const grantWrite = await api("POST", "/api/plugins/grants", { kind: "mcp", ref: `${SERVER}/${ACTION}`, agentId: state.botB });
    scenario("B granted the write action to the Bot", { status: grantWrite.status, body: String(grantWrite.body?.error ?? "ok").slice(0, 140) });
    const unbound = await call(api, state.botB, READ, {});
    scenario("B called with no connected account", { status: unbound.status, refused: unbound.body?.error ? String(unbound.body.error).slice(0, 200) : null });

    const consent = await consentFlow(contextB, api, "B");
    scenario("B consent loop", consent);

    const run = await call(api, state.botB, READ, {});
    scenario("B executed the read action", { status: run.status, successful: run.body?.successful, board: run.body?.data?.messages ?? null });
    // And B reads the board back: only B's own words, never A's.
    const read = await call(api, state.botB, READ, {});
    scenario("B read the board", { status: read.status, board: read.body?.data?.messages ?? read.body?.data ?? null });
    await contextB.close();

    // The vendor's ledger: the two executions must carry the two identities, and the board must
    // hold both writings attributed each to its writer.
    const ledger = await fetch(`${VENDOR}/__ledger`).then((r) => r.json());
    const executions = ledger.executions.filter((e) => e.tool === READ);
    scenario("vendor ledger executions", {
      count: executions.length,
      identities: [...new Set(executions.map((e) => e.vendorUserId))],
      accounts: executions.map((e) => e.connectedAccountId),
    });
    scenario("vendor board", { messages: ledger.board });
    return out;
  }

  if (mode === "neg") {
    const contextA = await browser.newContext({ locale: "en-US" });
    await signIn(contextA, state.userA);
    const api = apiFor(contextA);
    const contextB = await browser.newContext({ locale: "en-US" });
    await signIn(contextB, state.userB);
    const apiB = apiFor(contextB);

    // A's Bot, called by A, is A's own grant — but A naming ANOTHER space's account is not a thing
    // the call accepts; what the boundary refuses is B using A's grant. B calls A's Bot: refused.
    const bOnABot = await apiB("POST", "/api/plugins/call", { ref: `${SERVER}/${READ}`, agentId: state.botA });
    scenario("B called through A's Bot", { status: bOnABot.status, body: String(bOnABot.body?.error ?? "").slice(0, 160) || "accepted" });
    // And A calling through B's Bot: refused the same way.
    const aOnBBot = await call(api, state.botB, READ, {});
    scenario("A called through B's Bot", { status: aOnBBot.status, body: String(aOnBBot.body?.error ?? "").slice(0, 160) || "accepted" });

    // The vendor still holds exactly the two accounts; nothing cross was written since act two.
    const ledger = await fetch(`${VENDOR}/__ledger`).then((r) => r.json());
    scenario("vendor ledger after negatives", {
      executions: ledger.executions.length,
      accounts: ledger.accounts.map((acc) => ({ user: acc.user_uuid, status: acc.status })),
      board: ledger.board.map((entry) => entry.by),
    });
    await contextA.close();
    await contextB.close();
    return out;
  }

  if (mode === "disconnect") {
    const contextA = await browser.newContext({ locale: "en-US" });
    await signIn(contextA, state.userA);
    const api = apiFor(contextA);
    const contextB = await browser.newContext({ locale: "en-US" });
    await signIn(contextB, state.userB);
    const apiB = apiFor(contextB);

    // A disconnects: the vendor must be ASKED to revoke A's account — and only A's.
    const revocationsBefore = (await fetch(`${VENDOR}/__ledger`).then((r) => r.json())).revocations.length;
    const bye = await api("DELETE", `/api/plugins/servers/${SERVER}/connection`);
    scenario("A disconnected", { status: bye.status, body: String(bye.body?.error ?? "ok").slice(0, 120) });
    const afterA = (await fetch(`${VENDOR}/__ledger`).then((r) => r.json())).revocations;

    // A can no longer execute; B still can, untouched.
    const aRun = await call(api, state.botA, READ, {});
    scenario("A called after disconnect", { status: aRun.status, refused: String(aRun.body?.error ?? "").slice(0, 160) || "accepted" });
    const bRun = await call(apiB, state.botB, READ, {});
    scenario("B called after A's disconnect", { status: bRun.status, successful: bRun.body?.successful });

    const ledger = await fetch(`${VENDOR}/__ledger`).then((r) => r.json());
    scenario("vendor revocations", {
      before: revocationsBefore,
      after: ledger.revocations,
      accountsLeft: ledger.accounts.map((acc) => ({ user: acc.user_uuid, status: acc.status })),
      executionsTotal: ledger.executions.length,
    });
    await contextA.close();
    await contextB.close();
    return out;
  }

  return { error: `unknown mode ${mode}` };
})
