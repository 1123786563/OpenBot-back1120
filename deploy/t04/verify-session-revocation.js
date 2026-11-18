/**
 * Casdoor T04 rework: revocation is PER SESSION.
 *
 * One person signs in on two independent sessions (two browser contexts = two devices). The
 * session that signs out loses its business APIs and its live event socket at once; the same
 * person's OTHER session keeps working and keeps receiving. Runs through the Agent browser with
 * `bun deploy/t04/controller.ts` up. Returns sanitized facts only.
 */
(async (page) => {
  const base = "http://localhost:14003";
  const control = "http://127.0.0.1:14099";
  const CASDOOR = "http://localhost:19002";
  const evidence = { scenarios: [] };
  const RUN = `t04rev${Date.now().toString(36).slice(-5)}`;

  async function controller(action, body) {
    const r = await fetch(`${control}${action}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body ?? {}),
    });
    return r.json();
  }

  async function register(domain) {
    const context = await page.context().browser().newContext();
    const p = await context.newPage();
    await p.goto(`${CASDOOR}/signup/app-t04`);
    const name = `${RUN}${Math.random().toString(36).slice(2, 7)}`;
    const user = {
      name,
      email: `${name}@${domain}`,
      password: "T04!" + Math.random().toString(36).slice(2) + Math.random().toString(36).slice(2),
    };
    await p.getByRole("textbox", { name: "Username*", exact: true }).fill(name);
    await p.getByRole("textbox", { name: "Display name*", exact: true }).fill("T04 session");
    await p.getByRole("textbox", { name: "Password*", exact: true }).fill(user.password);
    await p.getByRole("textbox", { name: "Confirm*", exact: true }).fill(user.password);
    await p.getByRole("textbox", { name: "Email*", exact: true }).fill(user.email);
    await p.locator("button.signup-button").dispatchEvent("click");
    await p.waitForURL((url) => url.pathname.startsWith("/result/"), { timeout: 30000, waitUntil: "commit" });
    await p.close();
    await context.close();
    const done = await controller("/verify-user", { name });
    if (!done.verified) throw Error(`fixture verification failed for ${name}`);
    return user;
  }

  async function signIn(context, user) {
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
    await p.close();
    let workspaceReady = false;
    for (let n = 0; n < 40; n++) {
      const session = await context.request.fetch(`${base}/api/auth/get-session`).then((r) => r.json()).catch(() => null);
      if (session?.session?.activeOrganizationId) { workspaceReady = true; break; }
      await page.waitForTimeout(500);
    }
    if (!workspaceReady) throw Error("session never named a workspace");
  }

  function apiFor(context) {
    return async function api(method, path, data) {
      const response = await context.request.fetch(base + path, {
        method,
        headers: { Origin: base, ...(data === undefined ? {} : { "content-type": "application/json" }) },
        ...(data === undefined ? {} : { data }),
      });
      return { status: response.status(), body: await response.json().catch(() => null) };
    };
  }

  /** Open the live event socket in a context and watch its life. */
  async function openSocket(context, label) {
    const p = await context.newPage();
    await p.goto(`${base}/`);
    const events = [];
    await p.evaluate((lbl) => {
      const w = window;
      w.__t04sock = w.__t04sock ?? {};
      const proto = location.protocol === "https:" ? "wss" : "ws";
      const socket = new WebSocket(`${proto}://${location.host}/api/channels/events`);
      w.__t04sock[lbl] = socket;
      socket.addEventListener("open", () => w.__t04sock[lbl + ":state"] = "open");
      socket.addEventListener("close", () => w.__t04sock[lbl + ":state"] = "closed");
      socket.addEventListener("message", (m) => (w.__t04sock[lbl + ":frames"] = [...(w.__t04sock[lbl + ":frames"] ?? []), String(m.data).slice(0, 120)]));
    }, label);
    // Wait for the socket to be open.
    for (let n = 0; n < 40; n++) {
      const state = await p.evaluate((lbl) => window.__t04sock?.[lbl + ":state"], label);
      if (state === "open") break;
      await page.waitForTimeout(250);
    }
    return {
      state: () => p.evaluate((lbl) => window.__t04sock?.[lbl + ":state"] ?? "unknown", label),
      frames: () => p.evaluate((lbl) => window.__t04sock?.[lbl + ":frames"] ?? [], label),
      page: p,
      label,
    };
  }

  const browser = page.context().browser();
  const ctx1 = await browser.newContext({ locale: "en-US" });
  const ctx2 = await browser.newContext({ locale: "en-US" });

  try {
    const user = await register("t04c.example.test");
    await signIn(ctx1, user);
    await signIn(ctx2, user); // The SAME person's second device.

    const api1 = apiFor(ctx1);
    const api2 = apiFor(ctx2);

    // A resource of this person's, created from device one.
    const bot = await api1("POST", "/api/agents", {
      name: `${RUN}-bot`, title: "two devices", roleDescription: "own bot",
      visibility: "public", systemPrompt: "Answer briefly.",
    });
    if (bot.status !== 201) throw Error(`bot create got ${bot.status}`);
    const botId = bot.body.agent.id;
    const channel = await api1("POST", "/api/channels", { agentIds: [botId] });
    if (channel.status !== 201) throw Error(`channel create got ${channel.status}`);
    const channelId = channel.body.channel.id;
    evidence.scenarios.push({ name: "one person, two sessions", user: user.name, botId, channelId });

    // Both sessions hold live event sockets.
    const sock1 = await openSocket(ctx1, "s1");
    const sock2 = await openSocket(ctx2, "s2");
    const state1Before = await sock1.state();
    const state2Before = await sock2.state();
    evidence.scenarios.push({ name: "both sockets open", state1: state1Before, state2: state2Before });

    // Device one signs out. THE SESSION ENDS; the person does not.
    const out = await ctx1.request.fetch(`${base}/api/auth/sign-out`, { method: "POST", headers: { Origin: base } });
    evidence.scenarios.push({ name: "device one signs out", status: out.status() });

    // Give the server a moment to close the socket and the other replica checks to settle.
    await page.waitForTimeout(1500);

    const after1 = await api1("GET", "/api/agents");
    const after2 = await api2("GET", "/api/agents");
    const state1After = await sock1.state();
    const state2After = await sock2.state();
    evidence.scenarios.push({
      name: "after one session signs out",
      signedOutApi: after1.status,
      otherSessionApi: after2.status,
      signedOutSocket: state1After,
      otherSessionSocket: state2After,
      otherSeesOwnBot: (after2.body?.agents ?? []).some((row) => row.id === botId),
    });

    // The surviving session keeps WORKING: it creates a conversation and reads its bot.
    const channel2 = await api2("POST", "/api/channels", { agentIds: [botId] });
    const read2 = await api2("GET", `/api/agents/${botId}`);
    evidence.scenarios.push({
      name: "surviving session keeps working",
      newConversationStatus: channel2.status,
      botReadStatus: read2.status,
      botTitle: read2.body?.agent?.title,
    });

    await sock1.page.close();
    await sock2.page.close();
    evidence.finishedAt = new Date().toISOString();
    return evidence;
  } catch (error) {
    return { error: String((error && error.message) || error), scenarios: evidence.scenarios };
  } finally {
    await ctx1.close();
    await ctx2.close();
  }
})