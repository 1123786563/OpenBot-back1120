async (page) => {
  const browser = page.context().browser();
  const results = [];
  for (const [scenario, token] of [
    ["malformed-client-idToken", "not-a-jwt"],
    [
      "unsigned-client-idToken",
      "eyJhbGciOiJub25lIn0.eyJzdWIiOiJmb3JnZWQiLCJpc3MiOiJodHRwOi8vbG9jYWxob3N0OjE4MDAwIiwiYXVkIjoidDAxLW9wZW5ib3QiLCJleHAiOjQxMDI0NDQ4MDB9.",
    ],
  ]) {
    const c = await browser.newContext();
    try {
      const r = await c.request.post(
        "http://localhost:13001/api/auth/sign-in/social",
        { data: { provider: "okta", idToken: { token } } },
      );
      const j = await r.json();
      const me = (
        await c.request.get("http://localhost:13001/api/me")
      ).status();
      if (r.status() !== 401 || me !== 401 || j.code !== "INVALID_TOKEN")
        throw new Error(`${scenario} unexpectedly accepted`);
      results.push({ scenario, status: r.status(), error: j.code, me });
    } finally {
      await c.close();
    }
  }
  const c = await browser.newContext();
  try {
    const start = await c.request.post(
      "http://localhost:13001/api/auth/sign-in/social",
      { data: { provider: "okta", callbackURL: "/home" } },
    );
    if (start.status() !== 200)
      throw new Error("could not initiate real OIDC state");
    const authorization = new URL((await start.json()).url);
    const state = authorization.searchParams.get("state");
    if (!state) throw new Error("no state");
    const callback = new URL("http://localhost:13001/api/auth/callback/okta");
    callback.searchParams.set("state", state);
    callback.searchParams.set(
      "code",
      "t01-deliberately-invalid-authorization-code",
    );
    const r = await c.request.get(callback.toString(), { maxRedirects: 0 });
    const me = (await c.request.get("http://localhost:13001/api/me")).status();
    const location = r.headers().location || "";
    if (r.status() !== 302 || me !== 401 || !location.includes("error="))
      throw new Error("invalid authorization code accepted");
    results.push({
      scenario: "invalid-code-with-real-state",
      status: r.status(),
      error: new URL(location, "http://localhost:13001").searchParams.get(
        "error",
      ),
      me,
    });
  } finally {
    await c.close();
  }
  return { passed: true, results };
};
