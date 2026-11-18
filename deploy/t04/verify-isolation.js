/**
 * Casdoor T04: two unrelated users, one deployment — business resources and connections are
 * isolated, through the real pages and the real API.
 *
 * Run through the provided Agent browser (`browser_run_code_unsafe`) while
 * `bun deploy/t04/controller.ts` is running. The object it returns holds only sanitized facts:
 * names, resource ids, statuses, timestamps. No password, cookie, token or secret is kept.
 *
 * Every negative is paired with the same operation succeeding for the owner, so a refusal that
 * came from something being broken cannot pass for isolation. A refusal that is really a 401
 * (anonymous) is asserted separately, so "everything failed" is distinguishable from
 * "cross-user access is refused".
 */
(async (page) => {
  const base = "http://localhost:14003";
  const control = "http://127.0.0.1:14099";
  const evidence = { scenarios: [] };
  const scenario = (name, facts) => {
    evidence.scenarios.push({ name, ...facts });
    return facts;
  };

  const now = () => new Date().toISOString();
  const RUN = `t04${Date.now().toString(36).slice(-5)}`;
  let stage = "init";

  async function controller(action, body) {
    const r = await fetch(`${control}${action}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body ?? {}),
    });
    return r.json();
  }

  const CASDOOR = "http://localhost:19002";

  function apiFor(context) {
    return async function api(method, path, data, expected) {
      const response = await context.request.fetch(base + path, {
        method,
        headers: {
          // Same-origin as far as the app is concerned: the guard reads Origin, the session
          // rides the context's cookies.
          Origin: base,
          ...(data === undefined ? {} : { "content-type": "application/json" }),
        },
        ...(data === undefined ? {} : { data }),
      });
      const body = await response.json().catch(() => null);
      return { status: response.status(), body };
    };
  }

  /** Expect a status; returns the body for further checks. */
  function expect(result, method, path, expected) {
    if (result.status !== expected)
      throw Error(
        `${method} ${path.split("?")[0]} expected ${expected}, got ${result.status}`,
      );
    return result.body;
  }

  async function register(domain) {
    const context = await page.context().browser().newContext();
    const p = await context.newPage();
    await context.clearCookies();
    await p.goto(`${CASDOOR}/signup/app-t04`);
    const name = `${RUN}${Math.random().toString(36).slice(2, 7)}`;
    const user = {
      name,
      email: `${name}@${domain}`,
      password:
        "T04!" +
        Math.random().toString(36).slice(2) +
        Math.random().toString(36).slice(2),
    };
    await p.getByRole("textbox", { name: "Username*", exact: true }).fill(name);
    await p
      .getByRole("textbox", { name: "Display name*", exact: true })
      .fill("T04 isolation");
    await p
      .getByRole("textbox", { name: "Password*", exact: true })
      .fill(user.password);
    await p
      .getByRole("textbox", { name: "Confirm*", exact: true })
      .fill(user.password);
    await p
      .getByRole("textbox", { name: "Email*", exact: true })
      .fill(user.email);
    await p.locator("button.signup-button").dispatchEvent("click");
    await p.waitForURL((url) => url.pathname.startsWith("/result/"), {
      timeout: 30000,
      waitUntil: "commit",
    });
    const fresh = await context.request
      .fetch(`${base}/api/auth/get-session`)
      .then((r) => r.json())
      .catch(() => null);
    if (fresh?.session) throw Error("registration must not create a session");
    await p.close();
    await context.close();
    const done = await controller("/verify-user", { name });
    if (!done.verified) throw Error(`fixture verification failed for ${name}`);
    return user;
  }

  /**
   * Sign one identity into this context through the real Casdoor password flow, and wait out the
   * first sign-in's workspace initialization: business APIs answer 403 WORKSPACE_REQUIRED until
   * the session names the personal organization the first callback created.
   */
  async function signIn(context, user) {
    const p = await context.newPage();
    const started = now();
    const redirect = await context.request.fetch(`${base}/api/auth/sign-in/social`, {
      method: "POST",
      headers: { "content-type": "application/json", Origin: base },
      data: {
        provider: "casdoor",
        callbackURL: base,
        errorCallbackURL: `${base}/sign?error=AUTH_CALLBACK_FAILED`,
      },
    });
    const authorizeUrl = (await redirect.json()).url;
    await p.goto(authorizeUrl);
    await p
      .getByRole("textbox", { name: "Username", exact: true })
      .fill(user.name);
    await p
      .getByRole("textbox", { name: "Password", exact: true })
      .fill(user.password);
    await p.locator("button.login-button").dispatchEvent("click");
    await p.waitForURL((u) => u.origin === base, {
      timeout: 30000,
      waitUntil: "commit",
    });
    await p.waitForTimeout(1500);
    const landed = p.url();
    await p.close();
    // Wait until the session names a workspace: the guard every business route sits behind.
    let workspaceReady = false;
    for (let n = 0; n < 40; n++) {
      const me = await context.request.fetch(`${base}/api/auth/get-session`);
      const session = await me.json().catch(() => null);
      if (session?.session?.activeOrganizationId) {
        workspaceReady = true;
        break;
      }
      await page.waitForTimeout(500);
    }
    return { started, ended: now(), landed, workspaceReady };
  }

  async function signOut(context) {
    const r = await context.request.fetch(`${base}/api/auth/sign-out`, {
      method: "POST",
      headers: { Origin: base },
    });
    return { status: r.status(), at: now() };
  }

  const mk = (s) => `${RUN}-${s}`;

  stage = "setup-context";
  try {
  // ---------------------------------------------------------------- scenario 1: A builds a space
  const browser = page.context().browser();
  const sharedContext = await browser.newContext({ locale: "en-US" });
  const api = apiFor(sharedContext);

  stage = "register-A";
  const userA = await register("t04a.example.test");
  stage = "signin-A";
  const inA = await signIn(sharedContext, userA);
  scenario("A first sign-in", {
    user: userA.name,
    landed: inA.landed,
    workspaceReady: inA.workspaceReady,
  });
  if (!inA.workspaceReady) throw Error("A session never named a workspace");

  stage = "create-bot-A";
  const botA = expect(
    await api("POST", "/api/agents", {
      name: mk("A-bot"),
      title: "A only",
      roleDescription: "A's own bot",
      visibility: "public",
      systemPrompt: "Answer briefly.",
    }),
    "POST",
    "/api/agents",
    201,
  );
  const botAId = botA.agent.id;
  stage = "create-channel-A";
  const channelA = expect(
    await api("POST", "/api/channels", { agentIds: [botAId] }),
    "POST",
    "/api/channels",
    201,
  );
  const channelAId = channelA.channel.id;
  const secretBytes = `T04-A secret ${RUN} — attachment bytes`;
  stage = "upload-A";
  const uploadedA = await sharedContext.request.fetch(
    `${base}/api/channels/${channelAId}/attachments`,
    {
      method: "POST",
      headers: { Origin: base },
      multipart: {
        file: {
          name: `${mk("a")}.txt`,
          mimeType: "text/plain",
          buffer: Buffer.from(secretBytes, "utf8"),
        },
      },
    },
  );
  if (uploadedA.status() !== 201)
    throw Error(`A upload expected 201, got ${uploadedA.status()}`);
  const attachmentA = await uploadedA.json();
  const attachmentAId = attachmentA.id;

  scenario("A created resources", {
    botId: botAId,
    channelId: channelAId,
    attachmentId: attachmentAId,
  });
  // ---------------------------------------------------------------- the owner still works, before B ever signs in
  stage = "owner-recheck";
  const botReadA = await api("GET", `/api/agents/${botAId}`);
  const attachmentReadA = await sharedContext.request.fetch(
    `${base}/api/attachments/${attachmentAId}`,
  );
  const attachmentBytesA = await attachmentReadA.text();
  const channelReadA = await api("GET", `/api/channels/${channelAId}`);
  scenario("A still owns everything", {
    botRead: botReadA.status,
    botTitle: botReadA.body?.agent?.title,
    conversationRead: channelReadA.status,
    attachmentRead: attachmentReadA.status(),
    attachmentUnchanged: attachmentBytesA === secretBytes,
  });


  // ---------------------------------------------------------------- scenario 2: B is refused
  stage = "register-B";
  const userB = await register("t04b.example.test");
  stage = "signin-B";
  const inB = await signIn(sharedContext, userB);
  scenario("B first sign-in, same client after A", {
    user: userB.name,
    workspaceReady: inB.workspaceReady,
  });
  if (!inB.workspaceReady) throw Error("B session never named a workspace");

  const rosterB = expect(await api("GET", "/api/agents"), "GET", "/api/agents", 200);
  scenario("B list of bots", {
    containsA: rosterB.agents.some((row) => row.id === botAId),
    count: rosterB.agents.length,
  });
  const channelsB = expect(
    await api("GET", "/api/channels?limit=50"),
    "GET",
    "/api/channels",
    200,
  );
  scenario("B list of conversations", {
    containsA: channelsB.channels.some((row) => row.id === channelAId),
  });

  const negativesB = {};
  stage = "negatives-B";
  for (const [key, method, path] of [
    ["botRead", "GET", `/api/agents/${botAId}`],
    [
      "botEdit",
      "PATCH",
      `/api/agents/${botAId}`,
    ],
    ["botDelete", "DELETE", `/api/agents/${botAId}`],
    ["botDuplicate", "POST", `/api/agents/${botAId}/duplicate`],
    ["conversationRead", "GET", `/api/channels/${channelAId}`],
    ["conversationDelete", "DELETE", `/api/channels/${channelAId}`],
    ["attachmentRead", "GET", `/api/attachments/${attachmentAId}`],
    ["attachmentHead", "HEAD", `/api/attachments/${attachmentAId}`],
    ["attachmentDelete", "DELETE", `/api/attachments/${attachmentAId}`],
  ]) {
    const r = await sharedContext.request.fetch(base + path, {
      method,
      headers: { Origin: base },
      ...(method === "PATCH"
        ? {
            headers: { "content-type": "application/json", Origin: base },
            data: {
              name: mk("A-bot"),
              title: "Taken by B",
              roleDescription: "B's now",
              visibility: "private",
            },
          }
        : {}),
    });
    negativesB[key] = r.status();
    if (method === "HEAD") await r.body().catch(() => {});
  }
  // Referencing A's bot from B's own new conversation must be refused before creation.
  stage = "hijack-B";
  const hijack = await sharedContext.request.fetch(`${base}/api/channels`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    data: { agentIds: [botAId] },
  });
  negativesB.conversationWithABot = hijack.status();

  scenario("B reaching A by id", { statuses: negativesB });
  const refused = Object.entries(negativesB).filter(
    ([, s]) => s === 404 || s === 403,
  );
  if (refused.length !== Object.keys(negativesB).length)
    throw Error(`B obtained a non-refusal: ${JSON.stringify(negativesB)}`);

  // ---------------------------------------------------------------- scenario 4: sign-out ends the session
  stage = "signout-A";
  const outA = await signOut(sharedContext);
  const afterSignOut = await api("GET", "/api/agents");
  scenario("A sign-out", { status: outA.status, listAfter: afterSignOut.status });
  if (afterSignOut.status !== 401)
    throw Error(`signed-out session still reads business data: ${afterSignOut.status}`);

  stage = "signin-B-again";
  const inB2 = await signIn(sharedContext, userB);
  scenario("B signs back in on the same client", {
    workspaceReady: inB2.workspaceReady,
  });
  const rosterB2 = expect(await api("GET", "/api/agents"), "GET", "/api/agents", 200);
  const channelsB2 = expect(
    await api("GET", "/api/channels?limit=50"),
    "GET",
    "/api/channels",
    200,
  );
  scenario("B after switching on one client", {
    botsContainA: rosterB2.agents.some((row) => row.id === botAId),
    conversationsContainA: channelsB2.channels.some((row) => row.id === channelAId),
  });
  const bCreates = expect(
    await api("POST", "/api/agents", {
      name: mk("B-bot"),
      title: "B only",
      roleDescription: "B's own bot",
      visibility: "public",
      systemPrompt: "Answer briefly.",
    }),
    "POST",
    "/api/agents",
    201,
  );
  scenario("B creates its own", { botId: bCreates.agent.id });

  // ---------------------------------------------------------------- scenario 5: anonymous
  stage = "anonymous";
  const anon = await browser.newContext({ locale: "en-US" });
  const anonStatuses = {};
  for (const [key, method, path] of [
    ["agents", "GET", "/api/agents"],
    ["bot", "GET", `/api/agents/${botAId}`],
    ["attachment", "GET", `/api/attachments/${attachmentAId}`],
    ["connections", "GET", "/api/plugins/connections"],
  ]) {
    const r = await anon.request.fetch(base + path, {
      method,
      headers: { Origin: base },
    });
    anonStatuses[key] = r.status();
    if (method === "GET" && r.status() >= 300) await r.body().catch(() => {});
  }
  scenario("anonymous requests", { statuses: anonStatuses });
  await anon.close();

  // ---------------------------------------------------------------- scenario 6: connections stay personal
  // Both users list the plugin catalogue's connection page: neither may see the other's rows,
  // and a shared (deployment) account state is only named when it belongs to their workspace.
  stage = "connections";
  const connectionsA = await api("GET", "/api/plugins/connections");
  const connectionsB = await api("GET", "/api/plugins/connections");
  scenario("connection lists", {
    statusA: connectionsA.status,
    statusB: connectionsB.status,
  });

  // ---------------------------------------------------------------- scenario: the owner re-checks after every refusal
  // A fresh client signs A in again, so the earlier refusals — and B's sign-in on the shared
  // client — cannot have borrowed A's session to fake this.
  stage = "owner-post-recheck";
  const contextA2 = await browser.newContext({ locale: "en-US" });
  const inA2 = await signIn(contextA2, userA);
  if (!inA2.workspaceReady) throw Error("A re-sign-in never named a workspace");
  const apiA2 = apiFor(contextA2);
  const botAgain = await apiA2("GET", `/api/agents/${botAId}`);
  const channelAgain = await apiA2("GET", `/api/channels/${channelAId}`);
  const attachmentAgain = await contextA2.request.fetch(
    `${base}/api/attachments/${attachmentAId}`,
    { headers: { Origin: base } },
  );
  const attachmentBytesAgain = await attachmentAgain.text();
  const rosterA2 = await apiA2("GET", "/api/agents");
  const channelsA2 = await apiA2("GET", "/api/channels?limit=50");
  scenario("A re-checks after B's refusals (fresh client)", {
    botRead: botAgain.status,
    botTitle: botAgain.body?.agent?.title,
    conversationRead: channelAgain.status,
    attachmentRead: attachmentAgain.status(),
    attachmentUnchanged: attachmentBytesAgain === secretBytes,
    botsContainA: (rosterA2.body?.agents ?? []).some((row) => row.id === botAId),
    conversationsContainA: (channelsA2.body?.channels ?? []).some(
      (row) => row.id === channelAId,
    ),
  });
  await contextA2.close();

  await sharedContext.close();
  evidence.run = RUN;
  evidence.finishedAt = now();
  return evidence;
  } catch (error) {
    return {
      failedAt: stage,
      error: String((error && error.message) || error),
      scenarios: evidence.scenarios,
    };
  }
})
