/**
 * Casdoor T04 rework: the same browser switches from A to B while A has a save in flight.
 *
 * Tab one holds A's standing-instructions save, its response held by a route handler. Tab two
 * signs out through the real UI and signs B in through the real Casdoor flow. The switch
 * broadcast must leave tab one with nothing of A's: it reloads into B's session, the held
 * response never paints, and B reads and writes the same screen normally. Runs through the Agent
 * browser with the controller up. Sanitized facts only.
 */
(async (page) => {
  const base = "http://localhost:14003";
  const control = "http://127.0.0.1:14099";
  const CASDOOR = "http://localhost:19002";
  const evidence = { scenarios: [], timeline: [] };
  const RUN = `t04sw${Date.now().toString(36).slice(-5)}`;
  const A_MARKER = `A-LATE-${RUN}`;
  const B_MARKER = `B-OWN-${RUN}`;
  const at = (label) => evidence.timeline.push({ at: new Date().toISOString(), label });

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
    await p.getByRole("textbox", { name: "Display name*", exact: true }).fill("T04 switch");
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

  async function signIn(context, tab, user) {
    // Casdoor keeps its own session across OpenBot sign-outs; clear it, or the authorize
    // endpoint silently re-approves whoever it still remembers.
    await tab.goto(`${CASDOOR}/logout`).catch(() => {});
    const redirect = await context.request.fetch(`${base}/api/auth/sign-in/social`, {
      method: "POST",
      headers: { "content-type": "application/json", Origin: base },
      data: { provider: "casdoor", callbackURL: base, errorCallbackURL: `${base}/sign?error=AUTH_CALLBACK_FAILED` },
    });
    await tab.goto((await redirect.json()).url);
    await tab.getByRole("textbox", { name: "Username", exact: true }).fill(user.name);
    await tab.getByRole("textbox", { name: "Password", exact: true }).fill(user.password);
    await tab.locator("button.login-button").dispatchEvent("click");
    await tab.waitForURL((u) => u.origin === base, { timeout: 30000, waitUntil: "commit" });
    let ready = false;
    for (let n = 0; n < 40; n++) {
      const session = await context.request.fetch(`${base}/api/auth/get-session`).then((r) => r.json()).catch(() => null);
      if (session?.session?.activeOrganizationId) { ready = true; break; }
      await page.waitForTimeout(500);
    }
    if (!ready) throw Error("session never named a workspace");
    await tab.waitForLoadState("load");
  }

  /** First sign-ins land on onboarding; the settings screen sits behind its completion. */
  async function completeOnboarding(context) {
    const done = await context.request.fetch(`${base}/api/me/onboarding`, {
      method: "POST",
      headers: { Origin: base, "content-type": "application/json" },
      data: { completed: true },
    });
    if (done.status() !== 200)
      throw Error(`onboarding completion got ${done.status()}`);
  }

  async function signOutFromUi(tab, user) {
    // The sign-out lives in the account menu behind the person's own row in the sidebar footer.
    // The row names them by their display name, which every fixture sets to "T04 switch".
    await tab.getByText("T04 switch").first().click({ timeout: 15000 });
    await tab
      .getByRole("menuitem", { name: /Sign out|退出登录/ })
      .click({ timeout: 15000 });
    await tab.waitForURL((u) => u.pathname.startsWith("/sign"), { timeout: 30000 });
  }

  const browser = page.context().browser();
  const context = await browser.newContext({ locale: "en-US", viewport: { width: 1500, height: 900 } });

  // The one-shot response hold: the FIRST standing-instructions save of this context is
  // intercepted and kept unanswered until the scenario releases it.
  let held = null;
  await context.route("**/api/settings/instructions", async (route) => {
    const request = route.request();
    if (request.method() === "PUT" && !held) {
      const response = await route.fetch();
      held = { response, route, at: new Date().toISOString() };
      at("A's save intercepted, response held");
      return;
    }
    await route.continue();
  });

  const tab1 = await context.newPage();
  const tab2 = await context.newPage();

  try {
    const userA = await register("t04d.example.test");
    const userB = await register("t04e.example.test");

    await signIn(context, tab1, userA);
    await completeOnboarding(context);
    at("A signed in on tab one, onboarding completed");

    // A writes standing instructions through the real dialog.
    await tab1.goto(`${base}/settings`);
    await tab1
      .getByRole("button", { name: /Standing instructions|持续指令/ })
      .click();
    const box = tab1.getByRole("textbox", {
      name: /Standing instructions|持续指令/,
    });
    await box.waitFor({ timeout: 15000 });
    await box.fill(A_MARKER);
    await tab1.getByRole("button", { name: /Save|保存/ }).click();
    at("A clicked Save; response held by the route");

    // Wait until the save request is actually the one being held.
    for (let n = 0; n < 40 && !held; n++) await page.waitForTimeout(250);
    if (!held) throw Error("A's save never reached the wire");

    // Tab two, same cookie: A's session. Sign out through the real UI.
    await tab2.goto(`${base}/`);
    await signOutFromUi(tab2, userA);
    at("tab two signed out through the UI");

    // And signs B in through the real Casdoor flow, on the same browser profile.
    await signIn(context, tab2, userB);
    await completeOnboarding(context);
    at("B signed in on tab two, onboarding completed");

    // Tab one heard the switch: it clears, then reloads into the cookie's new identity.
    let tab1Url = "";
    for (let n = 0; n < 60; n++) {
      await page.waitForTimeout(500);
      try { tab1Url = tab1.url(); } catch { tab1Url = "(navigating)"; }
      const body = await tab1.locator("body").textContent().catch(() => "");
      if (body && !body.includes(A_MARKER) && tab1Url.includes("/settings")) {
        const dialogGone = (await tab1.getByRole("textbox", { name: "Standing instructions" }).count()) === 0;
        if (dialogGone) break;
      }
    }
    const tab1Body = await tab1.locator("body").textContent().catch(() => "(gone)");
    const tab1HasAMarker = tab1Body.includes(A_MARKER);
    const tab1DialogStillOpen =
      (await tab1.getByRole("textbox", { name: "Standing instructions" }).count()) > 0;
    evidence.scenarios.push({
      name: "tab one after the switch",
      url: tab1Url,
      showsAMarkers: tab1HasAMarker,
      aDialogStillOpen: tab1DialogStillOpen,
      instructionsRow:
        (tab1Body.match(/None yet|暂无/) || [null])[0],
    });

    // Release A's held response now — B owns the browser, and the document that asked for it
    // is gone. If the request itself died with that document, fulfilling throws, which is its
    // own answer: the response reached nothing.
    if (held) {
      let released = false;
      try {
        await held.route.fulfill({ response: held.response });
        released = true;
      } catch {
        released = false;
      }
      evidence.scenarios.push({
        name: "A's held response released after B owns the browser",
        delivered: released,
      });
      at("A's held response released");
    }
    await page.waitForTimeout(1500);

    const afterReleaseBody = await tab1.locator("body").textContent().catch(() => "(gone)");
    evidence.scenarios.push({
      name: "tab one after A's held response is released",
      showsAMarkers: afterReleaseBody.includes(A_MARKER),
    });

    // Positive control: B reads and writes the same screen, and B's value persists.
    await tab1.goto(`${base}/settings`);
    await tab1
      .getByRole("button", { name: /Standing instructions|持续指令/ })
      .click();
    const boxB = tab1.getByRole("textbox", {
      name: /Standing instructions|持续指令/,
    });
    await boxB.waitFor({ timeout: 15000 });
    const bSees = await boxB.inputValue();
    await boxB.fill(B_MARKER);
    await tab1.getByRole("button", { name: /Save|保存/ }).click();
    let saved = false;
    for (let n = 0; n < 40 && !saved; n++) {
      saved =
        (await tab1.getByText(/Saved|已保存/, { exact: true }).count()) > 0;
      await page.waitForTimeout(250);
    }
    await tab1.reload();
    await tab1
      .getByRole("button", { name: /Standing instructions|持续指令/ })
      .click();
    const persisted = await tab1
      .getByRole("textbox", { name: /Standing instructions|持续指令/ })
      .inputValue();
    evidence.scenarios.push({
      name: "B reads and writes normally",
      bBoxAfterSwitch: bSees === "" ? "(empty)" : bSees,
      bSaved: saved,
      bValuePersisted: persisted === B_MARKER,
    });

    evidence.finishedAt = new Date().toISOString();
    return evidence;
  } catch (error) {
    return { error: String((error && error.message) || error), scenarios: evidence.scenarios, timeline: evidence.timeline };
  } finally {
    await tab1.close().catch(() => {});
    await tab2.close().catch(() => {});
    await context.close().catch(() => {});
  }
})
