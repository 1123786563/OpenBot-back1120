import { type Browser, test } from "@e2e-dev/web";
import { expect } from "e2e";
import {
  createSetupRoutes,
  createSetupSources,
  type SetupChecklist,
  type SetupRow,
} from "../../server/src/setup/checklist";

const path = "/settings/setup";
const personal = process.env.OPENBOT_E2E_SUITE === "personal";
const guide = "https://github.com/CopilotKit/openbot#quick-start";
const credentials = personal
  ? { label: "Keys", path: "/settings/credentials" }
  : { label: "Credentials", path: "/admin/credentials" };
const computer = personal
  ? { label: "Computer", path: "/settings/computer" }
  : { label: "Computers", path: "/admin/computers" };

function row(id: SetupRow["id"], options: Partial<SetupRow> = {}): SetupRow {
  return {
    id,
    scope: "deployment",
    title: id,
    required: false,
    status: "ready",
    ready: true,
    detail: "Works.",
    fix: null,
    ...options,
  };
}

const checklist: SetupChecklist = {
  audience: "admin",
  rows: [
    row("intelligence", { title: "Backend", required: true }),
    row("model", {
      title: "AI model",
      required: true,
      status: "needs_setup",
      ready: false,
      detail: "Without a model key, OpenBot can't answer.",
      fix: {
        kind: "env",
        names: ["OPENAI_API_KEY"],
        docsUrl: guide,
        page: credentials,
      },
    }),
    row("computer", {
      title: "Bot computer",
      status: "needs_setup",
      ready: false,
      detail: "Without it, Bots can't browse the web or work with files.",
    }),
    row("apps", { title: "More apps" }),
    row("chat", {
      title: "Slack and Teams",
      status: "needs_setup",
      ready: false,
      fix: {
        kind: "env",
        names: ["OPENTAG_SHARED_SECRET", "OPENTAG_URL"],
        docsUrl: guide,
      },
    }),
  ],
};

async function serveSetup(
  browser: Browser,
  answer: (method: string, pathname: string) => Response | Promise<Response>,
  viewer: { role?: "admin" | "user"; localEvaluation?: boolean } = {},
) {
  const requests: { method: string; pathname: string }[] = [];
  await browser.route(/\/api\/me$/, async (route) => {
    const data = await (await route.fetch()).json<{ user: { role: string } }>();
    return route.fulfill({
      json: { ...data, user: { ...data.user, role: viewer.role ?? "admin" } },
    });
  });
  await browser.route(/\/api\/capabilities$/, async (route) => {
    const data = await (await route.fetch()).json<Record<string, unknown>>();
    return route.fulfill({
      json: { ...data, localEvaluation: viewer.localEvaluation ?? false },
    });
  });
  await browser.route(/\/api\/setup(?:\/check)?$/, async (route) => {
    const method = route.request.method;
    const pathname = new URL(route.request.url).pathname;
    requests.push({ method, pathname });
    const response = await answer(method, pathname);
    return route.fulfill({
      status: response.status,
      body: await response.text(),
      contentType: "application/json",
    });
  });
  return requests;
}

const response = (value: SetupChecklist = checklist) =>
  Response.json({ checklist: value });
const ready = (value: SetupRow): SetupRow => ({
  ...value,
  status: "ready",
  ready: true,
  fix: null,
});
const item = (browser: Browser, id: SetupRow["id"]) =>
  browser.locator(`[data-setup-row="${id}"]`);

test("Setup waits for its initial read, then rechecks and refreshes the sidebar badge", async ({
  app,
  browser,
  screen,
}) => {
  const initial = Promise.withResolvers<void>();
  const recheck = Promise.withResolvers<void>();
  let result = checklist;
  const requests = await serveSetup(browser, async (method) => {
    if (method === "POST") {
      await recheck.promise;
      result = { ...checklist, rows: checklist.rows.map(ready) };
    } else {
      await initial.promise;
    }
    return response(result);
  });
  const link = screen.getByRole("link", /^Setup(?:\s*,|$)/);
  const list = screen.getByRole("list", "Setup", { exact: true });
  const status = browser.locator("[data-setup-checklist]").getByRole("status");
  const badge = browser.locator('[data-sidebar="menu-badge"]');
  try {
    await app.open("/settings");
    await expect(link).toHaveAttribute("href", path);
    await link.click();
    await expect(browser).toHaveURL(path);
    await expect(
      screen.getByRole("heading", "Setup", { exact: true }),
    ).toBeVisible();
    await expect
      .poll(() =>
        requests.some(
          ({ method, pathname }) =>
            method === "GET" && pathname === "/api/setup",
        ),
      )
      .toBe(true);
    await expect(list).toHaveCount(0);
    await expect(status).toHaveCount(0);
  } finally {
    initial.resolve();
  }
  try {
    await expect(list).toBeVisible();
    await expect(status).toHaveText(
      "3 things need setup, and 1 is required. Set up the required one first.",
    );
    await expect(
      screen.getByRole("link", /^Setup\s*, 2 need setup$/),
    ).toBeVisible();
    await expect(badge).toHaveText("2");
    await expect(badge).toHaveAttribute("aria-hidden", "true");
    await expect(
      item(browser, "model").getByText("Required", { exact: true }),
    ).toBeVisible();
    await expect(
      item(browser, "model").getByText(
        "Without a model key, OpenBot can't answer.",
      ),
    ).toBeVisible();
    await expect(
      item(browser, "chat").getByText("OPENTAG_SHARED_SECRET", { exact: true }),
    ).toBeVisible();
    expect(
      await browser.evaluate(() =>
        Array.from(document.querySelectorAll("[data-setup-row]"), (element) =>
          element.getAttribute("data-setup-row"),
        ),
      ),
    ).toEqual(["intelligence", "model", "computer", "apps", "chat"]);
    const tones = await browser.evaluate(() => {
      const selectors = ["model", "chat", "apps"];
      const tokens = ["text-destructive", "text-amber-600", "text-emerald-600"];
      return selectors.map((id, index) => {
        const label = id === "apps" ? "Ready" : "Needs setup";
        const pill = Array.from(
          document.querySelectorAll(`[data-setup-row="${id}"] span`),
        ).find((node) => node.textContent === label);
        if (!pill) throw new Error(`Missing ${id} pill`);
        const reference = document.createElement("span");
        reference.className = tokens[index] ?? "";
        document.body.append(reference);
        const color = getComputedStyle(reference).color;
        reference.remove();
        return { color: getComputedStyle(pill).color, expected: color };
      });
    });
    expect(tones.every(({ color, expected }) => color === expected)).toBe(true);
    expect(new Set(tones.map(({ color }) => color)).size).toBe(3);
    await screen.getByRole("button", "Check again", { exact: true }).click();
    await expect(
      screen.getByRole("button", "Checking…", { exact: true }),
    ).toBeDisabled();
    await expect
      .poll(() => requests.filter(({ method }) => method === "POST"))
      .toEqual([{ method: "POST", pathname: "/api/setup/check" }]);
  } finally {
    recheck.resolve();
  }
  await expect(status).toHaveText("Everything is set up.");
  await expect(
    item(browser, "intelligence").getByText("Ready", { exact: true }),
  ).toBeVisible();
  await expect(
    item(browser, "model").getByText("Ready", { exact: true }),
  ).toBeVisible();
  await expect(link).toHaveText("Setup");
  await expect(badge).toHaveCount(0);
});

test("the fix links show a keyboard focus ring and the credential link opens its real page", async ({
  app,
  browser,
  screen,
}) => {
  await serveSetup(browser, () => response());
  await browser.emulateMedia({ colorScheme: "light" });
  await app.open(path);
  const model = item(browser, "model");
  await expect(
    model.getByText("OPENAI_API_KEY", { exact: true }),
  ).toBeVisible();
  const docs = model.getByRole("link", "Setup guide", { exact: true });
  const keys = model.getByRole("link", credentials.label, { exact: true });
  await expect(docs).toHaveAttribute("href", guide);
  await expect(docs).toHaveAttribute("target", "_blank");
  await expect(keys).toHaveAttribute("href", credentials.path);
  await browser.evaluate(() => {
    const anchor = document.querySelector<HTMLElement>(
      '[data-setup-row="model"] a',
    );
    if (!anchor) throw new Error("Missing first fix link");
    anchor.focus();
    return null;
  });
  await keys.press("Tab");
  await expect(docs).toBeFocused();
  for (const target of [docs, keys]) {
    await expect(target).toBeFocused();
    const color = await browser.evaluate(() => {
      const active = document.activeElement;
      if (!active) throw new Error("Missing keyboard focus");
      const style = getComputedStyle(active);
      return {
        focus: active.matches(":focus-visible"),
        actual: style.getPropertyValue("--tw-ring-color").trim(),
        expected: style.getPropertyValue("--ring").trim(),
        shadow: style.boxShadow,
      };
    });
    expect(color.focus).toBe(true);
    expect(color.expected).not.toBe("");
    expect(color.actual).toBe(color.expected);
    expect(color.shadow).not.toBe("none");
    if (target === docs) await docs.press("Shift+Tab");
  }
  await keys.click();
  await expect(browser).toHaveURL(credentials.path);
  await expect(
    screen.getByRole("heading", credentials.label, { exact: true }),
  ).toBeVisible();
});

for (const localEvaluation of [false, true]) {
  test(`a non-admin ${localEvaluation ? "local user can open Setup" : "member returns to General without reading Setup"}`, async ({
    app,
    browser,
    screen,
  }) => {
    const requests = await serveSetup(browser, () => response(), {
      role: "user",
      localEvaluation,
    });
    await app.open(path);
    if (localEvaluation) {
      await expect(
        screen.getByRole("heading", "Setup", { exact: true }),
      ).toBeVisible();
      await expect(
        screen.getByRole("list", "Setup", { exact: true }),
      ).toBeVisible();
      await expect(
        screen.getByRole("link", /^Setup(?:\s*,|$)/),
      ).toHaveAttribute("href", path);
    } else {
      await expect(browser).toHaveURL("/settings");
      await expect(
        screen.getByRole("heading", "General", { exact: true }),
      ).toBeVisible();
      await expect(screen.getByRole("link", /^Setup(?:\s*,|$)/)).toHaveCount(0);
      await expect(
        screen.getByRole("heading", "Setup", { exact: true }),
      ).toHaveCount(0);
      expect(requests).toEqual([]);
    }
  });
}

for (const kind of ["unchecked", "optional", "one fix"] as const) {
  test(`Setup distinguishes ${kind} from a required gap`, async ({
    app,
    browser,
    screen,
  }) => {
    const rows = checklist.rows.map((value): SetupRow => {
      if (kind === "unchecked" && value.id === "model")
        return { ...value, status: "not_checked", ready: false, fix: null };
      if (kind === "optional" && !value.required) return value;
      if (kind === "one fix" && value.id === "model") return value;
      return ready(value);
    });
    await serveSetup(browser, () => response({ ...checklist, rows }));
    await app.open(path);
    const status = browser
      .locator("[data-setup-checklist]")
      .getByRole("status");
    const link = screen.getByRole("link", /^Setup(?:\s*,|$)/);
    if (kind === "unchecked") {
      await expect(status).toHaveText("1 thing isn't checked yet.");
      await expect(
        item(browser, "model").getByText("Not checked", { exact: true }),
      ).toBeVisible();
      await expect(
        item(browser, "model").getByText("Ready", { exact: true }),
      ).toHaveCount(0);
      await expect(link).toHaveText("Setup");
    } else if (kind === "optional") {
      await expect(status).toHaveText(
        "OpenBot is ready to use. 2 optional features aren't set up yet. Each says how to add it.",
      );
    } else {
      await expect(status).toHaveText(
        "1 thing needs setup, and 1 is required. Set up the required one first.",
      );
      await expect(
        screen.getByRole("link", /^Setup\s*, 1 needs setup$/),
      ).toBeVisible();
    }
  });
}

test("a failed Setup read offers a retry and displays the recovered checklist", async ({
  app,
  browser,
  screen,
}) => {
  let available = false;
  const requests = await serveSetup(browser, () =>
    available
      ? response()
      : Response.json({ error: "Unavailable" }, { status: 503 }),
  );
  await app.open(path);
  const alert = browser.locator("[data-setup-checklist]").getByRole("alert");
  await expect(alert).toHaveText("Couldn't check your setup. Check again.");
  available = true;
  await screen.getByRole("button", "Check again", { exact: true }).click();
  await expect(
    screen.getByRole("list", "Setup", { exact: true }),
  ).toBeVisible();
  await expect(alert).toHaveCount(0);
  expect(requests.at(-1)).toEqual({ method: "GET", pathname: "/api/setup" });
  expect(requests.every(({ method }) => method === "GET")).toBe(true);
});

test("a member checklist payload uses neutral copy and hides setup details", async ({
  app,
  browser,
  screen,
}) => {
  await serveSetup(browser, () =>
    response({
      audience: "member",
      rows: checklist.rows.map((value) =>
        value.ready
          ? value
          : { ...value, detail: "Your admin sets this up.", fix: null },
      ),
    }),
  );
  await app.open(path);
  const list = screen.getByRole("list", "Setup", { exact: true });
  await expect(list).toBeVisible();
  await expect(
    list.getByText("Your admin sets this up.", { exact: true }),
  ).toHaveCount(3);
  await expect(list.getByText("Needs setup", { exact: true })).toHaveCount(0);
  await expect(list.getByText("Required", { exact: true })).toHaveCount(0);
  await expect(list.getByRole("link")).toHaveCount(0);
  await expect(list).not.toContainText(/OPENAI_API_KEY|OPENTAG/);
  const detailColors = await browser.evaluate(() =>
    Array.from(
      document.querySelectorAll(
        "[data-setup-row] [data-slot='item-description']",
      ),
      (detail) => getComputedStyle(detail).color,
    ),
  );
  expect(detailColors).toHaveLength(5);
  expect(new Set(detailColors).size).toBe(1);
  await expect(
    item(browser, "intelligence").getByText("Ready", { exact: true }),
  ).toBeVisible();
  await expect(
    browser.locator("[data-setup-checklist]").getByRole("status"),
  ).toHaveText("Your admin sets up anything that isn't ready yet.");
});

for (const active of [true, false]) {
  test(`Setup renders the server's edition wording when the licence is ${active ? "active" : "inactive"}`, async ({
    app,
    browser,
    screen,
  }) => {
    const sources = createSetupSources({
      productName: "OpenBot",
      config: { singleUser: personal, edition: personal ? "personal" : "team" },
      environment: {},
      model: {
        provider: "openai",
        keyId: "default",
        defaultModel: "gpt-5.6-terra",
        plan: false,
      },
      credentials: { list: async () => [] },
      entitlements: async () => ({
        status: "ready",
        entitlement: {
          active,
          source: "selfHostedDeploymentLicense",
          features: {},
          limits: {},
        },
      }),
      computer: true,
      apps: { configured: active, provider: "composio" },
      chat: false,
    });
    const setup = createSetupRoutes(sources, async (context, next) => {
      context.set("actor", {
        id: "fixture-user",
        email: "fixture@example.test",
        role: "admin",
      });
      await next();
    });
    await serveSetup(browser, () => setup.request("/"));
    await app.open(path);
    const list = screen.getByRole("list", "Setup", { exact: true });
    await expect(list).toBeVisible();
    const backend = active
      ? personal
        ? "Keeps your conversations and skills."
        : "Keeps your conversations and what OpenBot remembers."
      : personal
        ? "The backend says this deployment's licence isn't active."
        : "The backend says this deployment's licence isn't active. Memory stays off until it is.";
    const apps = active
      ? personal
        ? "You can connect more apps than the ones OpenBot comes with."
        : "People can connect more apps than the ones an admin adds."
      : personal
        ? "Without it, you can connect only the apps OpenBot comes with."
        : "Without it, people can connect only the apps an admin adds.";
    await expect(
      item(browser, "intelligence").getByText(backend, { exact: true }),
    ).toBeVisible();
    await expect(
      item(browser, "apps").getByText(apps, { exact: true }),
    ).toBeVisible();
    await expect(
      item(browser, "model").getByRole("link", credentials.label, {
        exact: true,
      }),
    ).toHaveAttribute("href", credentials.path);
    await expect(
      item(browser, "computer").getByRole("link", computer.label, {
        exact: true,
      }),
    ).toHaveAttribute("href", computer.path);
    if (personal) {
      await expect(list).not.toContainText(/remember|memory|admin/i);
      await expect(
        browser.locator('[data-setup-checklist] a[href^="/admin/"]'),
      ).toHaveCount(0);
    }
  });
}
