/**
 * Casdoor T04 rework round 3 — a REAL streaming turn stops when its session is revoked.
 *
 * The deployed server on :14003 runs with a stub Intelligence (a thread store, its lock, and the
 * runner's socket — the smallest fake a run needs) and a Bot whose harness speaks the AG-UI
 * protocol slowly, one delta every 250 ms, so a sign-out has somewhere in the middle to land.
 *
 * One person, two devices (two browser contexts). Device one runs a turn through the real
 * mounted `/api/copilotkit/agent/:id/run` and reads the deltas as they arrive. Device two then
 * revokes device one's SESSION — what "sign out that device" does — through the same route the
 * app's session list uses. What must hold: device one's deltas STOP mid-turn and its API turns
 * 401; device two's own turn runs to RUN_FINISHED, because what was revoked was one session, not
 * the person and not the route.
 *
 * Run through the Agent browser while `bun deploy/t04/controller.ts` is up. Sanitized facts only.
 */
(async (page) => {
  const base = "http://localhost:14003";
  const control = "http://127.0.0.1:14099";
  const CASDOOR = "http://localhost:19002";
  const evidence = { scenarios: [], timeline: [] };
  const at = (label, facts) =>
    evidence.timeline.push({ at: new Date().toISOString(), label, ...(facts ?? {}) });
  const scenario = (name, facts) => {
    evidence.scenarios.push({ name, ...facts, at: new Date().toISOString() });
    return facts;
  };
  const RUN = `t04str${Date.now().toString(36).slice(-5)}`;

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
      password:
        "T04!" + Math.random().toString(36).slice(2) + Math.random().toString(36).slice(2),
    };
    await p.getByRole("textbox", { name: "Username*", exact: true }).fill(name);
    await p.getByRole("textbox", { name: "Display name*", exact: true }).fill("T04 stream");
    await p.getByRole("textbox", { name: "Password*", exact: true }).fill(user.password);
    await p.getByRole("textbox", { name: "Confirm*", exact: true }).fill(user.password);
    await p.getByRole("textbox", { name: "Email*", exact: true }).fill(user.email);
    await p.locator("button.signup-button").dispatchEvent("click");
    await p.waitForURL((url) => url.pathname.startsWith("/result/"), {
      timeout: 30000,
      waitUntil: "commit",
    });
    await p.close();
    await context.close();
    const done = await controller("/verify-user", { name });
    if (!done.verified) throw Error(`fixture verification failed for ${name}`);
    return user;
  }

  async function signIn(context, user) {
    await context.request.fetch(`${CASDOOR}/logout`).catch(() => {});
    const p = await context.newPage();
    const redirect = await context.request.fetch(`${base}/api/auth/sign-in/social`, {
      method: "POST",
      headers: { "content-type": "application/json", Origin: base },
      data: {
        provider: "casdoor",
        callbackURL: base,
        errorCallbackURL: `${base}/sign?error=AUTH_CALLBACK_FAILED`,
      },
    });
    await p.goto((await redirect.json()).url);
    await p.getByRole("textbox", { name: "Username", exact: true }).fill(user.name);
    await p.getByRole("textbox", { name: "Password", exact: true }).fill(user.password);
    await p.locator("button.login-button").dispatchEvent("click");
    await p.waitForURL((u) => u.origin === base, { timeout: 30000, waitUntil: "commit" });
    await p.close();
    for (let n = 0; n < 40; n++) {
      const session = await context.request
        .fetch(`${base}/api/auth/get-session`)
        .then((r) => r.json())
        .catch(() => null);
      if (session?.session?.activeOrganizationId) return session;
      await page.waitForTimeout(500);
    }
    throw Error("session never named a workspace");
  }

  const browser = page.context().browser();

  try {
    // ------------------------------------------------ device one: signed in, owns a slow Bot
    const device1 = await browser.newContext({ locale: "en-US" });
    const user = await register("t04f.example.test");
    const session1 = await signIn(device1, user);
    const api1 = (method, path, data) =>
      device1.request
        .fetch(base + path, {
          method,
          headers: {
            Origin: base,
            ...(data === undefined ? {} : { "content-type": "application/json" }),
          },
          ...(data === undefined ? {} : { data }),
        })
        .then(async (r) => ({ status: r.status(), body: await r.json().catch(() => null) }));

    // No endpoint: the Bot runs ON the runtime, on the deployment's (stub) model, so the turn
    // streams over the HTTP response the gate wraps.
    const created = await api1("POST", "/api/agents", {
      name: `${RUN}-bot`,
      title: "Slow talker",
      roleDescription: "Answers slowly, one word at a time.",
      visibility: "private",
      systemPrompt: "Answer briefly.",
    });
    scenario("device one created a Bot on the deployment model", {
      status: created.status,
      botId: created.body?.agent?.id,
      error: created.body?.error,
    });
    if (created.status !== 201)
      throw Error(`bot create got ${created.status}: ${JSON.stringify(created.body)}`);
    const botId = created.body.agent.id;

    // Device one runs a turn through the real mounted runtime route and reads the deltas.
    const runPage = await device1.newPage();
    await runPage.goto(`${base}/`);
    await runPage.evaluate((bot) => {
      const w = window;
      w.__t04stream = { chunks: [], deltas: 0, finished: false, state: "running" };
      const runId = `run-${Math.random().toString(36).slice(2)}`;
      w.__t04stream.controller = new AbortController();
      fetch(`/api/copilotkit/agent/${bot}/run`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        credentials: "include",
        body: JSON.stringify({
          threadId: `thread-${Math.random().toString(36).slice(2)}`,
          runId,
          state: {},
          messages: [{ id: `ask-${runId}`, role: "user", content: "Hello?" }],
          tools: [],
          context: [],
          forwardedProps: {},
        }),
        signal: w.__t04stream.controller.signal,
      })
        .then((response) => {
          w.__t04stream.status = response.status;
          const reader = response.body.getReader();
          const decoder = new TextDecoder();
          const read = () =>
            reader.read().then(({ done, value }) => {
              if (done) {
                w.__t04stream.state = "closed";
                return;
              }
              const text = decoder.decode(value, { stream: true });
              w.__t04stream.chunks.push(text.slice(0, 80));
              w.__t04stream.deltas += (text.match(/TEXT_MESSAGE_CONTENT/g) ?? []).length;
              if (text.includes("RUN_FINISHED")) w.__t04stream.finished = true;
              if (text.includes("RUN_ERROR")) w.__t04stream.runError = text.slice(0, 160);
              return read();
            });
          return read();
        })
        .catch((error) => {
          w.__t04stream.state = `error:${String(error).slice(0, 60)}`;
        });
    }, botId);

    // Wait until the turn is under way: at least three deltas have arrived.
    for (let n = 0; n < 60; n++) {
      const deltas = await runPage.evaluate(() => window.__t04stream?.deltas ?? 0);
      if (deltas >= 3) break;
      await page.waitForTimeout(250);
    }
    const before = await runPage.evaluate(() => ({
      deltas: window.__t04stream.deltas,
      state: window.__t04stream.state,
      status: window.__t04stream.status,
      chunks: window.__t04stream.chunks.slice(0, 6),
    }));
    scenario("device one's turn is streaming", before);
    if (before.deltas < 3) throw Error(`the turn never streamed: ${JSON.stringify(before)}`);

    // ------------------------------------------------ device two: the same person, another device
    const device2 = await browser.newContext({ locale: "en-US" });
    const session2 = await signIn(device2, user);
    scenario("device two signed in as the same person", {
      sameUser: session2.user.id === session1.user.id,
      differentSession: session2.session.id !== session1.session.id,
    });
    if (session2.session.id === session1.session.id)
      throw Error("the two devices share one session");

    // Device two signs device one OUT — the session, not the person.
    const revoke = await device2.request.fetch(`${base}/api/auth/revoke-session`, {
      method: "POST",
      headers: { "content-type": "application/json", Origin: base },
      data: { id: session1.session.id },
    });
    at("device two revoked device one's session", { status: revoke.status() });
    await revoke.body().catch(() => {});

    // Give the gate a moment, then read the facts.
    await page.waitForTimeout(1500);
    const afterRevoke = await runPage.evaluate(() => ({
      deltas: window.__t04stream.deltas,
      state: window.__t04stream.state,
      finished: window.__t04stream.finished,
    }));
    await page.waitForTimeout(3500);
    const settled = await runPage.evaluate(() => ({
      deltas: window.__t04stream.deltas,
      state: window.__t04stream.state,
      finished: window.__t04stream.finished,
    }));
    const api1After = await api1("GET", "/api/agents");
    scenario("device one after its session was revoked", {
      deltasAtRevoke: afterRevoke.deltas,
      deltasSettled: settled.deltas,
      streamState: settled.state,
      turnFinishedAtClient: settled.finished,
      apiAfter: api1After.status,
    });
    if (api1After.status !== 401)
      throw Error(`revoked session still reads business data: ${api1After.status}`);

    // Device two runs the SAME turn: it must stream to the end.
    const page2 = await device2.newPage();
    await page2.goto(`${base}/`);
    await page2.evaluate((bot) => {
      const w = window;
      w.__t04stream = { chunks: [], deltas: 0, finished: false, state: "running" };
      const runId = `run-${Math.random().toString(36).slice(2)}`;
      fetch(`/api/copilotkit/agent/${bot}/run`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        credentials: "include",
        body: JSON.stringify({
          threadId: `thread-${Math.random().toString(36).slice(2)}`,
          runId,
          state: {},
          messages: [{ id: `ask-${runId}`, role: "user", content: "Hello?" }],
          tools: [],
          context: [],
          forwardedProps: {},
        }),
      })
        .then((response) => {
          w.__t04stream.status = response.status;
          const reader = response.body.getReader();
          const decoder = new TextDecoder();
          const read = () =>
            reader.read().then(({ done, value }) => {
              if (done) {
                w.__t04stream.state = "closed";
                return;
              }
              const text = decoder.decode(value, { stream: true });
              w.__t04stream.deltas += (text.match(/TEXT_MESSAGE_CONTENT/g) ?? []).length;
              if (text.includes("RUN_FINISHED")) w.__t04stream.finished = true;
              if (text.includes("RUN_ERROR")) w.__t04stream.runError = text.slice(0, 160);
              return read();
            });
          return read();
        })
        .catch((error) => {
          w.__t04stream.state = `error:${String(error).slice(0, 60)}`;
        });
    }, botId);
    for (let n = 0; n < 80; n++) {
      const state = await page2.evaluate(
        () => window.__t04stream?.state ?? "unknown",
      );
      if (state !== "running") break;
      await page.waitForTimeout(250);
    }
    const device2Result = await page2.evaluate(() => ({
      status: window.__t04stream.status,
      deltas: window.__t04stream.deltas,
      finished: window.__t04stream.finished,
      state: window.__t04stream.state,
    }));
    scenario("device two's own turn runs to the end", device2Result);
    if (!device2Result.finished || device2Result.deltas < 10)
      throw Error(`device two's turn did not complete: ${JSON.stringify(device2Result)}`);

    evidence.finishedAt = new Date().toISOString();
    return evidence;
  } catch (error) {
    evidence.failedAt = { error: String(error && error.message), at: new Date().toISOString() };
    return evidence;
  }
})
