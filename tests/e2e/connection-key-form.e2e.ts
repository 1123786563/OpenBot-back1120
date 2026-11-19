import { type Browser, test } from "@e2e-dev/web";
import { expect } from "e2e";
import { gmailServer } from "./fixtures/app-details";
import { optionalUrl, requiredKey } from "./fixtures/brokered-field";
import { brokeredProbeCases } from "./fixtures/brokered-probe-outcomes";

const account = "/connections/gmail";
const root =
  process.env.OPENBOT_E2E_SUITE === "personal"
    ? account
    : "/admin/plugins/gmail";
const helpUrl = "https://keys.example.test/gmail";
const help = "Create an API key in the provider's developer settings.";
const rejected = "The provider rejected that API key.";
const stranded =
  "Gmail rejected the key and could not withdraw the new connection. Disconnect it and try again.";
const unavailable = "The provider could not say what Gmail asks for.";
const key = {
  name: "generic_api_key",
  label: "API Key",
  help: "Use the private key issued for your account.",
  required: true,
  secret: true,
};
const retired = {
  name: "subdomain",
  label: "Subdomain",
  help: "",
  required: false,
  secret: false,
};
const baseUrl = {
  name: "base_url",
  label: "Base URL",
  help: "",
  required: true,
  secret: false,
  default: "https://api.service.example.test",
};
type Field = typeof key & { default?: string };
type Verdict = {
  verified: boolean;
  verifiedAt: string | null;
  probe?: string | null;
};
const unchecked = brokeredProbeCases[0].verdict;
const checked = brokeredProbeCases[1].verdict;
const failed = brokeredProbeCases[2].verdict;
const previousCheck = "2026-11-11T12:00:00Z";
const checkRefused = "Gmail refused the key during the check.";

async function serveKeyApp(
  browser: Browser,
  options: {
    authScheme?: "API_KEY" | "OAUTH2" | "NO_AUTH";
    fields?: (read: number) => Response | Promise<Response>;
    refusedSubmissions?: number;
    initialVerdict?: Verdict;
    recheck?: Verdict;
    connectionsUnavailable?: () => boolean;
    keepRejectedConnection?: boolean;
  } = {},
) {
  const writes: { method: string; body: unknown }[] = [];
  const accountActions: string[] = [];
  let reads = 0;
  let connected = Boolean(options.initialVerdict);
  let verdict = options.initialVerdict ?? unchecked;
  let checkable = Boolean(options.recheck);
  await browser.route(/\/api\/plugins$/, (route) =>
    route.fulfill({
      json: {
        catalogue: [],
        servers: [
          {
            ...gmailServer,
            id: "gmail",
            tools: [],
            authScheme: options.authScheme ?? "API_KEY",
          },
        ],
        skills: [],
        provider: "composio",
        composioConfigured: true,
      },
    }),
  );
  await browser.route(/\/api\/plugins\/connections$/, (route) => {
    if (options.connectionsUnavailable?.()) {
      return route.fulfill({
        status: 500,
        json: { error: "The connections could not be read." },
      });
    }
    return route.fulfill({
      json: {
        connections: connected
          ? [
              {
                serverId: "gmail",
                holder: "person",
                scope: "",
                connectedAt: "2026-11-10T00:00:00Z",
                ...verdict,
                checkable,
              },
            ]
          : [],
      },
    });
  });
  await browser.route(
    /\/api\/plugins\/servers\/gmail\/connection\/(confirm|siblings)$/,
    (route) =>
      route.fulfill({
        json: { connected, siblings: [], unanswered: 0 },
      }),
  );
  await browser.route(
    /\/api\/plugins\/servers\/gmail\/connection\/recheck$/,
    (route) => {
      accountActions.push(`${route.request.method} /connection/recheck`);
      const answer = options.recheck ?? unchecked;
      if (!answer.probe) {
        checkable = false;
        return route.fulfill({ json: answer });
      }
      verdict = answer;
      return answer.verified
        ? route.fulfill({ json: answer })
        : route.fulfill({ status: 400, json: { error: checkRefused } });
    },
  );
  await browser.route(
    /\/api\/plugins\/servers\/gmail\/connection$/,
    (route) => {
      accountActions.push(`${route.request.method} /connection`);
      connected = false;
      verdict = unchecked;
      return route.fulfill({ json: { ok: true } });
    },
  );
  await browser.route(
    /\/api\/plugins\/servers\/gmail\/connect(?:\?|$)/,
    async (route) => {
      const body = JSON.parse(route.request.postData ?? "null");
      if (!body?.values) {
        const response =
          (await options.fields?.(++reads)) ?? fieldResponse([key]);
        return route.fulfill({
          status: response.status,
          contentType: "application/json",
          body: await response.text(),
        });
      }
      writes.push({ method: route.request.method, body });
      if (options.keepRejectedConnection) {
        connected = true;
        verdict = failed;
        return route.fulfill({ status: 400, json: { error: stranded } });
      }
      if (writes.length <= (options.refusedSubmissions ?? 0))
        return route.fulfill({ status: 400, json: { error: rejected } });
      connected = true;
      verdict = unchecked;
      return route.fulfill({
        json: { connected: true, verified: false, probe: null },
      });
    },
  );
  return { accountActions, writes };
}

function fieldResponse(fields: Field[]) {
  return Response.json({ fields, guide: { steps: help, url: helpUrl } });
}

function dateShownInBrowser(browser: Browser, iso: string) {
  return browser.evaluate(
    (value) => new Date(value).toLocaleDateString("en-US"),
    iso,
  );
}

function retainedKey(browser: Browser, fixtureKey: string) {
  return browser.evaluate(async (value) => {
    const modulePath = "/src/query-client.ts";
    const { queryClient }: typeof import("../../app/src/query-client") =
      await import(modulePath);
    const submissions = queryClient
      .getMutationCache()
      .getAll()
      .map((mutation) => mutation.state.variables)
      .filter(
        (variables) =>
          typeof variables === "object" &&
          variables !== null &&
          "serverId" in variables &&
          variables.serverId === "gmail" &&
          "values" in variables,
      );
    return {
      submissions: submissions.length,
      retained: JSON.stringify(submissions).includes(value),
    };
  }, fixtureKey);
}

test("a key App describes its form and links to a key guide before any submission", async ({
  app,
  browser,
  screen,
}) => {
  const { writes } = await serveKeyApp(browser);
  await app.open(account);
  await expect(
    screen.getByText(
      /Needs a key from Gmail\. Connect shows where to get one\./,
    ),
  ).toBeVisible();
  await expect(screen.getByText(/to approve access/)).toHaveCount(0);
  const tabs = browser.tabs().length;
  await screen.getByRole("button", "Connect", { exact: true }).click();
  const dialog = screen.getByRole("dialog", "Connect your account", {
    exact: true,
  });
  await expect(dialog.getByLabel("API Key", { exact: true })).toBeVisible();
  await expect(
    browser.locator('[role="dialog"] input[type="password"]'),
  ).toHaveCount(1);
  await expect(dialog.getByText(key.help, { exact: true })).toBeVisible();
  const guide = dialog.getByTestId("key-guide");
  await expect(guide).toContainText(
    "Gmail doesn't offer a sign-in here, so it connects with a key from your Gmail account.",
  );
  await expect(guide).toContainText(help);
  const link = dialog.getByRole("link", "Get a key from Gmail", {
    exact: true,
  });
  await expect(link).toHaveAttribute("href", helpUrl);
  await expect(link).toHaveAttribute("target", "_blank");
  expect(browser.tabs()).toHaveLength(tabs);
  expect(writes).toEqual([]);
});

if (process.env.OPENBOT_E2E_SUITE !== "personal") {
  test("Admin distinguishes the optional account connection from completed App setup", async ({
    app,
    browser,
    screen,
  }) => {
    await serveKeyApp(browser);
    await app.open(root);
    await expect(
      screen.getByText(/Connect shows where to get one\./),
    ).toBeVisible();
    await expect(screen.getByText(/with a key from the app/)).toBeVisible();
    await expect(
      screen.getByText(
        /Setup is complete without it, and it reaches only your own Gmail account/,
      ),
    ).toBeVisible();
    await expect(screen.getByText(/There is no token to paste/)).toHaveCount(0);
  });
}

test("an invalid key remains in the open dialog while the refusal can still be read after closing", async ({
  app,
  browser,
  screen,
}) => {
  const { writes } = await serveKeyApp(browser, {
    refusedSubmissions: 2,
  });
  await app.open(account);
  const open = screen.getByRole("button", "Connect", { exact: true });
  const dialog = screen.getByRole("dialog", "Connect your account");
  const editor = dialog.getByLabel("API Key", { exact: true });
  const submit = dialog.getByRole("button", "Connect", { exact: true });
  await open.click();
  await editor.fill("fixture-mistyped");
  await submit.click();
  await expect(dialog.getByRole("alert")).toHaveText(rejected);
  expect(await retainedKey(browser, "fixture-mistyped")).toEqual({
    submissions: 1,
    retained: false,
  });
  await expect(editor).toBeVisible();
  await submit.click();
  await expect.poll(() => writes.length).toBe(2);
  await expect(dialog.getByRole("alert")).toHaveText(rejected);
  await dialog.getByRole("button", "Close", { exact: true }).click();
  await expect(dialog).toHaveCount(0);
  await expect(
    screen.getByRole("main").getByRole("alert").filter({ hasText: rejected }),
  ).toBeVisible();
  await open.click();
  await expect(
    browser.locator('[role="dialog"] input[type="password"]:invalid'),
  ).toHaveCount(1);
  await editor.fill("fixture-corrected");
  await submit.click();
  await expect(dialog).toHaveCount(0);
  await expect(
    screen.getByRole("button", "Disconnect", { exact: true }),
  ).toBeVisible();
  const afterSuccess = await retainedKey(browser, "fixture-corrected");
  expect(afterSuccess.submissions).toBeGreaterThan(0);
  expect(afterSuccess.retained).toBe(false);
  expect(writes).toEqual([
    {
      method: "POST",
      body: { values: { generic_api_key: "fixture-mistyped" } },
    },
    {
      method: "POST",
      body: { values: { generic_api_key: "fixture-mistyped" } },
    },
    {
      method: "POST",
      body: { values: { generic_api_key: "fixture-corrected" } },
    },
  ]);
});

test("a reopened key form keeps its previous fields until the provider replies and submits only current fields", async ({
  app,
  browser,
  screen,
}) => {
  const gate = Promise.withResolvers<void>();
  const { writes } = await serveKeyApp(browser, {
    fields: async (read) => {
      if (read === 1) return fieldResponse([key, retired]);
      await gate.promise;
      return fieldResponse([key, baseUrl]);
    },
  });
  await app.open(account);
  const open = screen.getByRole("button", "Connect", { exact: true });
  const dialog = screen.getByRole("dialog", "Connect your account");
  const retiredField = dialog.getByLabel("Subdomain", { exact: true });
  const secret = dialog.getByLabel("API Key", { exact: true });
  try {
    await open.click();
    await expect(retiredField).toBeVisible();
    await retiredField.fill("old-fixture-value");
    await dialog.getByRole("button", "Close", { exact: true }).click();
    await expect(dialog).toHaveCount(0);
    await open.click();
    await expect(retiredField).toBeVisible();
    await expect(retiredField).toHaveValue("");
    await expect(dialog.getByText(/Checking what the app needs/)).toHaveCount(
      0,
    );
    await secret.fill("fixture-typed-during-request");
  } finally {
    gate.resolve();
  }
  await expect(retiredField).toHaveCount(0);
  await expect(dialog.getByLabel("Base URL", { exact: true })).toHaveValue(
    baseUrl.default,
  );
  await dialog.getByRole("button", "Connect", { exact: true }).click();
  await expect(dialog).toHaveCount(0);
  expect(writes).toEqual([
    {
      method: "POST",
      body: {
        values: {
          generic_api_key: "fixture-typed-during-request",
          base_url: baseUrl.default,
        },
      },
    },
  ]);
});

for (const onReopen of [false, true]) {
  test(`a refused field lookup shows the provider's error ${onReopen ? "and removes stale fields" : "inside the new dialog"}`, async ({
    app,
    browser,
    screen,
  }) => {
    const { writes } = await serveKeyApp(browser, {
      fields: (read) =>
        onReopen && read === 1
          ? fieldResponse([key, retired])
          : Response.json({ error: unavailable }, { status: 502 }),
    });
    await app.open(account);
    const open = screen.getByRole("button", "Connect", { exact: true });
    const dialog = screen.getByRole("dialog", "Connect your account");
    await open.click();
    if (onReopen) {
      await expect(
        dialog.getByLabel("Subdomain", { exact: true }),
      ).toBeVisible();
      await dialog.getByRole("button", "Close", { exact: true }).click();
      await expect(dialog).toHaveCount(0);
      await open.click();
    }
    await expect(dialog.getByRole("alert")).toHaveText(unavailable);
    await expect(dialog.getByLabel("API Key", { exact: true })).toHaveCount(0);
    await expect(dialog.getByLabel("Subdomain", { exact: true })).toHaveCount(
      0,
    );
    await expect(
      dialog.getByRole("button", "Connect", { exact: true }),
    ).toHaveCount(0);
    expect(writes).toEqual([]);
    await dialog.getByRole("button", "Close", { exact: true }).click();
    await expect(dialog).toHaveCount(0);
    await expect(
      screen
        .getByRole("main")
        .getByRole("alert")
        .filter({ hasText: unavailable }),
    ).toBeVisible();
  });
}

test("a connect return opens the key form once and refresh clears that opening action", async ({
  app,
  browser,
  screen,
}) => {
  await serveKeyApp(browser);
  await app.open(`${account}?connect=true`);
  const dialog = screen.getByRole("dialog", "Connect your account");
  await expect(dialog.getByLabel("API Key", { exact: true })).toBeVisible();
  await expect(browser).toHaveURL(account);
  await browser.reload();
  await expect(
    screen.getByRole("button", "Connect", { exact: true }),
  ).toBeVisible();
  await expect(dialog).toHaveCount(0);
});

for (const initiallyChecked of [false, true]) {
  test(`a failed re-check updates ${initiallyChecked ? "a previously verified key" : "a key with no prior check"} immediately and after reload`, async ({
    app,
    browser,
    screen,
  }) => {
    const { accountActions } = await serveKeyApp(browser, {
      initialVerdict: initiallyChecked ? checked : unchecked,
      recheck: failed,
    });
    await app.open(account);
    const lastCheck = screen.getByText(/Last checked/);
    const neverChecked = screen.getByText(/It hasn't been checked with Gmail/);
    const refusal = screen.getByText(/Your key didn't pass a check with Gmail/);
    const recheck = screen.getByRole("button", "Re-check", { exact: true });
    await expect(initiallyChecked ? lastCheck : neverChecked).toBeVisible();
    if (!initiallyChecked) {
      await expect(neverChecked).toContainText(
        "At the time, Gmail had no safe way to check a key.",
      );
    }
    await recheck.click();
    await expect(screen.getByRole("alert")).toHaveText(checkRefused);
    await expect(refusal).toContainText("Your account is still connected.");
    await expect(lastCheck).toHaveCount(0);
    await expect(neverChecked).toHaveCount(0);
    await browser.reload();
    await expect(refusal).toBeVisible();
    await expect(lastCheck).toHaveCount(0);
    await expect(neverChecked).toHaveCount(0);
    await expect(recheck).toBeVisible();
    expect(accountActions).toEqual(["POST /connection/recheck"]);
  });
}

test("a re-check that finds no safe action leaves the previous failed verdict on the account", async ({
  app,
  browser,
  screen,
}) => {
  const { accountActions } = await serveKeyApp(browser, {
    initialVerdict: failed,
    recheck: unchecked,
  });
  await app.open(account);
  const recheck = screen.getByRole("button", "Re-check", { exact: true });
  const refusal = screen.getByText(/Your key didn't pass a check with Gmail/);
  await expect(refusal).toBeVisible();
  await recheck.click();
  await expect(recheck).toHaveCount(0);
  await expect(refusal).toContainText("Your account is still connected.");
  await expect(
    screen.getByText(/It hasn't been checked with Gmail/),
  ).toHaveCount(0);
  expect(accountActions).toEqual(["POST /connection/recheck"]);
});

test("disconnect clears a successful re-check and a replacement key starts unchecked", async ({
  app,
  browser,
  screen,
}) => {
  const { accountActions, writes } = await serveKeyApp(browser, {
    initialVerdict: { ...checked, verifiedAt: previousCheck },
    recheck: checked,
  });
  await app.open(account);
  const recheck = screen.getByRole("button", "Re-check", { exact: true });
  const lastCheck = screen.getByText(/Last checked/);
  const neverChecked = screen.getByText(/It hasn't been checked with Gmail/);
  await expect(lastCheck).toContainText(
    await dateShownInBrowser(browser, previousCheck),
  );
  await recheck.click();
  await expect(lastCheck).toContainText(
    await dateShownInBrowser(browser, checked.verifiedAt),
  );
  await screen.getByRole("button", "Disconnect", { exact: true }).click();
  await expect(
    screen.getByText(
      "Disconnected. Your key still works at Gmail. Change it there to stop all access.",
      { exact: true },
    ),
  ).toBeVisible();
  await expect(lastCheck).toHaveCount(0);
  await expect(recheck).toHaveCount(0);
  await screen.getByRole("button", "Connect", { exact: true }).click();
  const dialog = screen.getByRole("dialog", "Connect your account");
  await dialog
    .getByLabel("API Key", { exact: true })
    .fill("fixture-replacement");
  await dialog.getByRole("button", "Connect", { exact: true }).click();
  await expect(dialog).toHaveCount(0);
  await expect(neverChecked).toBeVisible();
  await expect(lastCheck).toHaveCount(0);
  expect(accountActions).toEqual([
    "POST /connection/recheck",
    "DELETE /connection",
  ]);
  expect(writes).toEqual([
    {
      method: "POST",
      body: { values: { generic_api_key: "fixture-replacement" } },
    },
  ]);
});

for (const path of new Set([account, root])) {
  test(`${path} reports a failed account read and restores the recorded verdict after reload`, async ({
    app,
    browser,
    screen,
  }) => {
    let unavailable = true;
    const { accountActions, writes } = await serveKeyApp(browser, {
      initialVerdict: failed,
      recheck: checked,
      connectionsUnavailable: () => unavailable,
    });
    await app.open(path);
    const connect = screen.getByRole("button", "Connect", { exact: true });
    const recheck = screen.getByRole("button", "Re-check", { exact: true });
    const disconnect = screen.getByRole("button", "Disconnect", {
      exact: true,
    });
    const refusal = screen.getByText(/Your key didn't pass a check with Gmail/);
    const uncheckedCopy = screen.getByText(/hasn't been checked with Gmail/);
    const error = screen.getByRole("alert").filter({
      hasText: /[Cc]ould(n't| not) (load|be loaded)/,
    });
    await expect(error).toBeVisible();
    await expect(connect).toHaveCount(0);
    await expect(recheck).toHaveCount(0);
    await expect(disconnect).toHaveCount(0);
    await expect(refusal).toHaveCount(0);
    await expect(uncheckedCopy).toHaveCount(0);
    if (path !== account) {
      await expect(
        screen.getByRole("switch", "Enable Gmail for this deployment"),
      ).toBeVisible();
      await expect(
        screen.getByRole("button", "Refresh tools", { exact: true }),
      ).toBeVisible();
    }
    unavailable = false;
    await browser.reload();
    await expect(refusal).toContainText("Your account is still connected.");
    await expect(recheck).toBeVisible();
    await expect(disconnect).toBeVisible();
    await expect(connect).toHaveCount(0);
    await expect(uncheckedCopy).toHaveCount(0);
    await expect(error).toHaveCount(0);
    expect(accountActions).toEqual([]);
    expect(writes).toEqual([]);
  });
}

test("a rejected key that still created an account offers Disconnect and reports the failed check", async ({
  app,
  browser,
  screen,
}) => {
  const { accountActions, writes } = await serveKeyApp(browser, {
    keepRejectedConnection: true,
    recheck: checked,
  });
  await app.open(account);
  const open = screen.getByRole("button", "Connect", { exact: true });
  const dialog = screen.getByRole("dialog", "Connect your account");
  const main = screen.getByRole("main");
  await open.click();
  await dialog.getByLabel("API Key", { exact: true }).fill("fixture-rejected");
  await dialog.getByRole("button", "Connect", { exact: true }).click();
  await expect(dialog).toHaveCount(0);
  await expect(main.getByRole("alert")).toHaveText(stranded);
  await expect(
    main.getByText(/Your key didn't pass a check with Gmail/),
  ).toContainText("Your account is still connected.");
  await expect(
    main.getByRole("button", "Disconnect", { exact: true }),
  ).toBeVisible();
  await expect(open).toHaveCount(0);
  expect(accountActions).toEqual([]);
  expect(writes).toEqual([
    {
      method: "POST",
      body: { values: { generic_api_key: "fixture-rejected" } },
    },
  ]);
});

for (const authScheme of ["API_KEY", "OAUTH2"] as const) {
  test(`${authScheme} connections without an applicable check keep Disconnect and omit Re-check`, async ({
    app,
    browser,
    screen,
  }) => {
    const consent = authScheme === "OAUTH2";
    const { accountActions, writes } = await serveKeyApp(browser, {
      authScheme,
      initialVerdict: consent ? { ...checked, probe: null } : unchecked,
      recheck: consent ? checked : undefined,
    });
    await app.open(account);
    await expect(
      screen.getByRole("button", "Disconnect", { exact: true }),
    ).toBeVisible();
    await expect(
      screen.getByRole("button", "Re-check", { exact: true }),
    ).toHaveCount(0);
    if (consent) {
      await expect(screen.getByText(/Signed in with Gmail\./)).toBeVisible();
    } else {
      await expect(
        screen.getByText(/It hasn't been checked with Gmail/),
      ).toContainText("At the time, Gmail had no safe way to check a key.");
    }
    expect(accountActions).toEqual([]);
    expect(writes).toEqual([]);
  });
}

test("disconnect resets the key verdict for other readers of the mounted account", async ({
  app,
  browser,
  screen,
}) => {
  const { accountActions } = await serveKeyApp(browser, {
    initialVerdict: unchecked,
    recheck: checked,
  });
  await app.open("/tests/browser/brokered-account.html");
  const verified = screen.getByTestId("verified");
  const date = screen.getByTestId("verified-at");
  const probe = screen.getByTestId("probe");
  await expect(verified).toHaveText("false");
  await expect(date).toHaveText("null");
  await expect(probe).toHaveText("null");
  await screen.getByRole("button", "Re-check", { exact: true }).click();
  await expect(verified).toHaveText("true");
  await expect(date).toHaveText(checked.verifiedAt);
  await expect(probe).toHaveText(checked.probe);
  await screen.getByRole("button", "Disconnect", { exact: true }).click();
  await expect(verified).toHaveText("false");
  await expect(date).toHaveText("null");
  await expect(probe).toHaveText("null");
  expect(accountActions).toEqual([
    "POST /connection/recheck",
    "DELETE /connection",
  ]);
});

for (const { outcome, verdict, description } of brokeredProbeCases) {
  test(`the recorded key probe outcome ${outcome} has its expected description`, async ({
    app,
    browser,
    screen,
  }) => {
    const { accountActions } = await serveKeyApp(browser, {
      initialVerdict: verdict,
    });
    await app.open(account);
    await expect(screen.getByText("Connected", { exact: true })).toBeVisible();
    const copy = verdict.verifiedAt
      ? `${description} ${await dateShownInBrowser(browser, verdict.verifiedAt)}.`
      : description;
    await expect(screen.getByText(copy, { exact: true })).toBeVisible();
    for (const other of new Set(
      brokeredProbeCases.map((entry) => entry.description),
    )) {
      if (other !== description)
        await expect(screen.getByText(other)).toHaveCount(0);
    }
    if (outcome === "complained")
      await expect(
        screen.getByText(
          /rejected|your key is wrong|did not work|could not withdraw it/i,
        ),
      ).toHaveCount(0);
    expect(accountActions).toEqual([]);
  });
}

for (const path of new Set([account, root])) {
  test(`${path} offers a check for a previously unchecked key when the App provides a safe action`, async ({
    app,
    browser,
    screen,
  }) => {
    const { accountActions } = await serveKeyApp(browser, {
      initialVerdict: unchecked,
      recheck: checked,
    });
    await app.open(path);
    await expect(
      screen.getByText(brokeredProbeCases[0].description, { exact: true }),
    ).toBeVisible();
    await expect(
      screen.getByRole("button", "Re-check", { exact: true }),
    ).toBeVisible();
    await expect(
      screen.getByText(/Your key didn't pass a check with/),
    ).toHaveCount(0);
    expect(accountActions).toEqual([]);
  });
}

test("a held connection with no probe field names Gmail without assigning a verdict", async ({
  app,
  browser,
  screen,
}) => {
  await serveKeyApp(browser, {
    initialVerdict: { verified: false, verifiedAt: null },
  });
  await app.open(root);
  await expect(
    screen.getByText(
      "Connected with your key. It hasn't been checked with Gmail.",
      { exact: true },
    ),
  ).toBeVisible();
  await expect(
    screen.getByText(/hasn't been checked with the app/),
  ).toHaveCount(0);
});

test("an App that needs no account omits all connection actions", async ({
  app,
  browser,
  screen,
}) => {
  const { writes, accountActions } = await serveKeyApp(browser, {
    authScheme: "NO_AUTH",
  });
  await app.open(account);
  await expect(
    screen.getByText(
      "Gmail doesn't need an account. Bots that have it can use it as it is.",
      { exact: true },
    ),
  ).toBeVisible();
  for (const action of ["Connect", "Disconnect", "Re-check"]) {
    await expect(
      screen.getByRole("button", action, { exact: true }),
    ).toHaveCount(0);
  }
  expect(accountActions).toEqual([]);
  expect(writes).toEqual([]);
});

const rendering = {
  name: "toString",
  label: "Rendering",
  help: "How this account names itself.",
  required: false,
  secret: false,
  default: "plain",
};
const proxy = {
  name: "__proto__",
  label: "Proxy",
  help: "The gateway this account is reached through.",
  required: false,
  secret: false,
};
const gateway = "gateway.example.test";
const changedGateway = "edge.example.test";

for (const changed of [
  {
    name: "adds a field with a default",
    before: [key],
    after: [key, rendering],
    field: rendering,
  },
  {
    name: "updates the default of an untouched field",
    before: [key, { ...proxy, default: gateway }],
    after: [key, { ...proxy, default: changedGateway }],
    field: { ...proxy, default: changedGateway },
  },
]) {
  test(`a published key form ${changed.name} while preserving the typed key`, async ({
    app,
    browser,
    screen,
  }) => {
    const refreshed = Promise.withResolvers<void>();
    const { writes } = await serveKeyApp(browser, {
      fields: async (read) => {
        if (read === 1) return fieldResponse(changed.before);
        await refreshed.promise;
        return fieldResponse(changed.after);
      },
    });
    await app.open(account);
    const open = screen.getByRole("button", "Connect", { exact: true });
    const dialog = screen.getByRole("dialog", "Connect your account");
    const editor = dialog.getByLabel("API Key", { exact: true });
    const field = dialog.getByLabel(changed.field.label, { exact: true });
    try {
      await open.click();
      await expect(editor).toBeVisible();
      await dialog.getByRole("button", "Close", { exact: true }).click();
      await expect(dialog).toHaveCount(0);
      await open.click();
      await editor.fill("fixture-key-while-refreshing");
      if (changed.before.length === 1) await expect(field).toHaveCount(0);
      else await expect(field).toHaveValue(gateway);
    } finally {
      refreshed.resolve();
    }
    await expect(field).toHaveValue(changed.field.default);
    await dialog.getByRole("button", "Connect", { exact: true }).click();
    await expect(dialog).toHaveCount(0);
    expect(writes).toEqual([
      {
        method: "POST",
        body: {
          values: {
            [key.name]: "fixture-key-while-refreshing",
            [changed.field.name]: changed.field.default,
          },
        },
      },
    ]);
  });
}

test("typing into the vendor's Proxy field sends it unchanged", async ({
  app,
  browser,
  screen,
}) => {
  const { writes } = await serveKeyApp(browser, {
    fields: () => fieldResponse([key, proxy]),
  });
  await app.open(account);
  await screen.getByRole("button", "Connect", { exact: true }).click();
  const dialog = screen.getByRole("dialog", "Connect your account");
  const gatewayField = dialog.getByLabel("Proxy", { exact: true });
  await dialog.getByLabel("API Key", { exact: true }).fill("fixture-typed-key");
  await gatewayField.fill(gateway);
  await expect(gatewayField).toHaveValue(gateway);
  await dialog.getByRole("button", "Connect", { exact: true }).click();
  await expect(dialog).toHaveCount(0);
  expect(writes).toEqual([
    {
      method: "POST",
      body: {
        values: { [key.name]: "fixture-typed-key", [proxy.name]: gateway },
      },
    },
  ]);
});

test("a connection form uses every field property published by the vendor", async ({
  app,
  browser,
  screen,
}) => {
  const { writes } = await serveKeyApp(browser, {
    fields: () => fieldResponse([requiredKey, optionalUrl]),
  });
  await app.open(account);
  await screen.getByRole("button", "Connect", { exact: true }).click();
  const dialog = screen.getByRole("dialog", "Connect your account");
  const token = dialog.getByLabel(requiredKey.label, { exact: true });
  const url = dialog.getByLabel(optionalUrl.label, { exact: true });
  const form = '[role="dialog"] form';
  const required = `${form} input[id$="-${requiredKey.name}"]`;
  const optional = `${form} input[id$="-${optionalUrl.name}"]`;
  const reads = {
    name: async () => {
      await expect(browser.locator(required)).toHaveCount(1);
      await expect(browser.locator(optional)).toHaveCount(1);
    },
    label: async () => {
      await expect(token).toBeVisible();
      await expect(url).toBeVisible();
    },
    help: async () => {
      await expect(
        dialog.getByText(requiredKey.help, { exact: true }),
      ).toBeVisible();
      await expect(
        browser.locator(`${form} [data-slot="item-description"]`),
      ).toHaveCount(1);
    },
    required: async () => {
      await expect(browser.locator(`${required}[required]`)).toHaveCount(1);
      await expect(browser.locator(`${optional}:not([required])`)).toHaveCount(
        1,
      );
    },
    secret: async () => {
      await expect(browser.locator(`${required}[type="password"]`)).toHaveCount(
        1,
      );
      await expect(browser.locator(`${optional}[type="text"]`)).toHaveCount(1);
    },
    default: async () => {
      await expect(url).toHaveValue("");
      await expect(browser.locator(`${required}:valid`)).toHaveCount(1);
    },
  } satisfies Record<keyof typeof requiredKey, () => Promise<void>>;
  for (const inspect of Object.values(reads)) await inspect();
  await dialog.getByRole("button", "Connect", { exact: true }).click();
  await expect(dialog).toHaveCount(0);
  expect(writes).toEqual([
    {
      method: "POST",
      body: {
        values: {
          [requiredKey.name]: requiredKey.default,
          [optionalUrl.name]: "",
        },
      },
    },
  ]);
});
