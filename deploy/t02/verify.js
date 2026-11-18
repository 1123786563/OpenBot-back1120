async function _verifyT02(page) {
  const base = "http://localhost:14001";
  const evidence = [];
  const check = (ok, message) => {
    if (!ok) throw Error(message);
  };
  async function api(method, path, data, expected) {
    const response = await page.request.fetch(base + path, {
      method,
      ...(data ? { data } : {}),
      headers: { Origin: base },
    });
    const body = await response.json().catch(() => null);
    check(
      response.status() === expected,
      `${method} ${path.split("?")[0]} expected ${expected}, got ${response.status()}`,
    );
    evidence.push({
      method,
      path: path.split("?")[0],
      status: response.status(),
      ...(body?.error ? { error: body.error } : {}),
    });
    return body;
  }
  async function begin() {
    const body = await api(
      "POST",
      "/api/auth/sign-in/social",
      {
        provider: "casdoor",
        callbackURL: base,
        errorCallbackURL: `${base}/sign?error=AUTH_CALLBACK_FAILED`,
      },
      200,
    );
    await page.goto(body.url);
  }
  async function mailCode(email) {
    for (let n = 0; n < 30; n++) {
      const list = await (
        await page.request.get("http://localhost:18025/api/v1/messages")
      ).json();
      const found = list.messages.find((m) =>
        m.To?.some((to) => to.Address === email),
      );
      if (found) {
        const mail = await (
          await page.request.get(
            `http://localhost:18025/api/v1/message/${found.ID}`,
          )
        ).json();
        const code = mail.Text.match(/\b\d{6}\b/)?.[0];
        if (code) return code;
      }
      await page.waitForTimeout(200);
    }
    throw Error("Casdoor verification mail did not arrive");
  }
  async function login(user, verified, expectedVerified = verified) {
    const capture = (req) => {
      if (req.url().startsWith(`${base}/api/auth/callback/casdoor?code=`))
        page.t02LastCallback = req.url();
    };
    page.on("request", capture);
    await page.context().clearCookies();
    await begin();
    if (verified) {
      await page.getByRole("tab", { name: "Code", exact: true }).click();
      await page
        .getByRole("textbox", { name: "Email or phone", exact: true })
        .fill(user.email);
      const sent = page.waitForResponse((r) =>
        r.url().includes("/api/send-verification-code"),
      );
      await page.getByRole("button", { name: "Get Code", exact: true }).click();
      check((await (await sent).json()).status === "ok", "Email send failed");
      const code = await mailCode(user.email);
      for (let i = 0; i < 6; i++)
        await page.getByRole("textbox").nth(i).fill(code[i]);
    } else {
      await page
        .getByRole("textbox", { name: "Username", exact: true })
        .fill(user.name);
      await page
        .getByRole("textbox", { name: "Password", exact: true })
        .fill(user.password);
      await page.getByRole("button", { name: "Sign In", exact: true }).click();
    }
    await page.waitForURL(`${base}/**`);
    const s = await api("GET", "/api/auth/get-session", null, 200);
    check(
      !!s?.session && s.user.emailVerified === expectedVerified,
      "Trusted verification state mismatch",
    );
    page.off("request", capture);
    evidence.push({
      scenario: verified
        ? "mail-verified-code-callback"
        : expectedVerified
          ? "verified-password-relogin"
          : "real-unverified-callback",
      sessionCreated: true,
      verified: expectedVerified,
    });
  }
  async function register(domain) {
    await page.context().clearCookies();
    await page.goto(`${base}/sign`);
    await page
      .getByRole("button", { name: "Continue with Casdoor", exact: true })
      .click();
    await page.getByRole("link", { name: "sign up now", exact: true }).click();
    const name = `t02${Date.now()}${Math.random().toString(36).slice(2, 7)}`;
    const user = {
      name,
      email: `${name}@${domain}`,
      password:
        "T02!" +
        Math.random().toString(36).slice(2) +
        Math.random().toString(36).slice(2),
    };
    await page
      .getByRole("textbox", { name: "Username*", exact: true })
      .fill(name);
    await page
      .getByRole("textbox", { name: "Display name*", exact: true })
      .fill("T02 verification");
    await page
      .getByRole("textbox", { name: "Password*", exact: true })
      .fill(user.password);
    await page
      .getByRole("textbox", { name: "Confirm*", exact: true })
      .fill(user.password);
    await page
      .getByRole("textbox", { name: "Email*", exact: true })
      .fill(user.email);
    await page.getByRole("button", { name: "Sign Up", exact: true }).click();
    await page.waitForURL(
      (url) => url.origin === base || url.pathname.startsWith("/result/"),
    );
    if (new URL(page.url()).origin === base) {
      const session = await api("GET", "/api/auth/get-session", null, 200);
      check(
        session?.user?.email === user.email,
        "Registration callback identity mismatch",
      );
    }
    evidence.push({ scenario: "public-registration", domain, created: true });
    return user;
  }
  const a = await register("gmail.com");
  await login(a, false);
  await api("GET", "/api/me", null, 403);
  await api("GET", "/api/agents", null, 403);
  const bot = {
    name: "T02 real bot",
    title: "Personal",
    roleDescription: "Help in my workspace",
    visibility: "private",
  };
  await api("POST", "/api/agents", bot, 403);
  await api(
    "POST",
    "/api/copilotkit/agent/general_assistant/run",
    { threadId: "t02-unverified", runId: "denied", messages: [], state: {} },
    403,
  );
  await login(a, true);
  const meA = (await api("GET", "/api/me", null, 200)).user;
  check(
    meA.role === "user" &&
      meA.workspace.role === "owner" &&
      meA.workspace.ownerUserId === meA.id &&
      meA.workspace.id !== "default",
    "Personal workspace authority mismatch",
  );
  await api("PATCH", "/api/workspace", { name: "T02 verified workspace" }, 200);
  check(
    (await api("GET", "/api/workspace", null, 200)).workspace.name ===
      "T02 verified workspace",
    "Rename not persisted",
  );
  await api("GET", "/api/admin/people", null, 403);
  await api("POST", `/api/admin/people/${meA.id}/role`, { role: "admin" }, 403);
  await api(
    "PATCH",
    "/api/workspace",
    { name: "bad", ownerUserId: "default" },
    400,
  );
  await api(
    "POST",
    "/api/auth/organization/session",
    { organizationId: "default" },
    403,
  );
  await api(
    "POST",
    "/api/auth/organization/set-active",
    { organizationId: "default" },
    403,
  );
  const created = (await api("POST", "/api/agents", bot, 201)).agent;
  const read = (await api("GET", `/api/agents/${created.id}`, null, 200)).agent;
  check(
    read.ownerUserId === meA.id && read.organizationId === meA.workspace.id,
    "Bot ownership mismatch",
  );
  await api("POST", "/api/auth/sign-out", {}, 200);
  await login(a, false, true);
  const again = (await api("GET", "/api/me", null, 200)).user;
  check(
    again.id === meA.id && again.workspace.id === meA.workspace.id,
    "Relogin duplicated identity/workspace",
  );
  const b = await register("outlook.com");
  await login(b, true);
  const meB = (await api("GET", "/api/me", null, 200)).user;
  check(
    meB.workspace.id !== meA.workspace.id && meB.role === "user",
    "Second user shares workspace or admin",
  );
  await api("GET", `/api/agents/${created.id}`, null, 404);
  await api(
    "POST",
    "/api/auth/organization/set-active",
    { organizationId: meA.workspace.id },
    403,
  );
  for (const [method, path, body] of [
    ["POST", "/api/auth/sign-in/social", { provider: "google" }],
    ["POST", "/api/auth/sign-in/social", { provider: "okta" }],
    ["POST", "/api/auth/sign-in/social", { provider: "microsoft" }],
    [
      "POST",
      "/api/auth/sign-in/social",
      { provider: "casdoor", idToken: { token: "invalid" } },
    ],
    ["POST", "/api/auth/sign-in/sso", { email: b.email }],
    [
      "POST",
      "/api/auth/sign-in/email",
      { email: b.email, password: b.password },
    ],
    [
      "POST",
      "/api/auth/sign-up/email",
      { email: b.email, password: b.password, name: "Bad" },
    ],
    ["POST", "/api/auth/update-user", { emailVerified: true }],
    ["POST", "/api/auth/link-social", { provider: "google" }],
    ["POST", "/api/auth/sign-in/anonymous", {}],
    ["POST", "/api/auth/sign-in/magic-link", { email: b.email }],
    ["POST", "/api/auth/sign-in/oauth2", { providerId: "okta" }],
    ["GET", "/api/auth/desktop", null],
    ["GET", "/api/auth/desktop/token", null],
    ["GET", "/api/auth/callback/okta", null],
    ["PUT", "/api/auth/scim/v2/Users/x", { active: true }],
    ["PATCH", "/api/auth/scim/v2/Users/x", { active: true }],
    ["DELETE", "/api/auth/scim/v2/Users/x", null],
  ]) {
    await page.context().clearCookies();
    await api(method, path, body, 403);
    await api("GET", "/api/agents", null, 401);
  }
  for (const failure of ["cancel", "invalid-state", "invalid-code", "replay"]) {
    await page.context().clearCookies();
    await begin();
    const authorization = new URL(page.url());
    if (failure === "replay") {
      await page.goto(page.t02LastCallback);
    } else if (failure === "cancel") {
      await page.goto(
        base +
          "/api/auth/callback/casdoor?error=access_denied&state=" +
          encodeURIComponent(authorization.searchParams.get("state")),
      );
    } else {
      await page.goto(
        base +
          "/api/auth/callback/casdoor?code=invalid&state=" +
          encodeURIComponent(
            failure === "invalid-state"
              ? "wrong-state"
              : authorization.searchParams.get("state"),
          ),
      );
    }
    await page.waitForURL(`${base}/sign**`);
    check(
      await page
        .getByText(
          "Sign-in was cancelled or could not finish. You can try again.",
        )
        .isVisible(),
      "Missing recoverable error",
    );
    await api("GET", "/api/agents", null, 401);
    evidence.push({ scenario: failure, recoverable: true });
  }
  await page.context().clearCookies();
  await login(b, false, true);
  const afterFailure = (await api("GET", "/api/me", null, 200)).user;
  check(
    afterFailure.id === meB.id &&
      afterFailure.workspace.id === meB.workspace.id,
    "Failure retry changed workspace",
  );
  page.t02Evidence = {
    evidence,
    identities: [
      { userId: meA.id, workspaceId: meA.workspace.id },
      { userId: meB.id, workspaceId: meB.workspace.id },
    ],
    botId: created.id,
  };
  return page.t02Evidence;
}
