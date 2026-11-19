import { type Browser, test } from "@e2e-dev/web";
import { expect, type TestFixtures } from "e2e";
import { createBot } from "./signed-in";

const personal = process.env.OPENBOT_E2E_SUITE === "personal";
const builtInEndpoint = "http://localhost:4201/ag-ui";
const externalEndpoint = "https://agents.example.test/ag-ui";
const harnessEndpoint = "http://agent-harness:4212";
type Profile = Record<string, unknown>;

async function observeSetup(
  browser: Browser,
  id: string,
  profile: (agent: Profile) => Profile = (agent) => agent,
  save?: (patch: Profile) => void,
) {
  const writes: Profile[] = [];
  await browser.route(
    new RegExp(`/api/agents/${RegExp.escape(id)}$`),
    async (route) => {
      if (route.request.method === "PATCH") {
        const patch = JSON.parse(route.request.postData ?? "null") as Profile;
        writes.push(patch);
        if (save) {
          save(patch);
          return route.fulfill({
            contentType: "application/json",
            body: JSON.stringify({ agent: profile({}) }),
          });
        }
      }
      const response = await route.fetch();
      if (response.status >= 300)
        return route.fulfill({
          status: response.status,
          body: await response.text(),
        });
      const result = await response.json<{ agent: Profile }>();
      return route.fulfill({
        contentType: "application/json",
        body: JSON.stringify({ ...result, agent: profile(result.agent) }),
      });
    },
  );
  return writes;
}

async function editField(
  screen: TestFixtures["screen"],
  field: string,
  value?: string,
) {
  await screen
    .getByRole("button", new RegExp(`^${RegExp.escape(field)}\\b`))
    .tap();
  const dialog = screen.getByRole("dialog", field, { exact: true });
  const input = dialog.getByRole("textbox", field, { exact: true });
  if (value !== undefined) await input.fill(value);
  await dialog.getByRole("button", "Save", { exact: true }).tap();
  await expect(dialog).toHaveCount(0);
}

test("a built-in Bot can be renamed without writing back its managed localhost address", async (fixtures) => {
  const { app, browser, screen } = fixtures;
  const bot = await createBot(fixtures);
  const writes = await observeSetup(browser, bot.id, (agent) => ({
    ...agent,
    builtIn: true,
    endpoint: builtInEndpoint,
  }));
  const path = `/bots/${bot.id}/setup`;
  await app.open(path);
  await expect(screen.getByText("Built in", { exact: true })).toBeVisible();
  await expect(screen.getByText(builtInEndpoint, { exact: true })).toHaveCount(
    0,
  );
  await expect(screen.getByRole("button", /^What it does/)).toBeVisible();
  await expect(screen.getByRole("button", /^Instructions/)).toHaveCount(0);
  if (personal) {
    await expect(
      screen.getByRole(
        "link",
        "Give each Bot its own computer with OpenBot for Business.",
        { exact: true },
      ),
    ).toHaveAttribute("href", "https://open.bot/business");
    await expect(screen.getByText("Visibility", { exact: true })).toHaveCount(
      0,
    );
    await expect(screen.getByText("Isolated", { exact: true })).toHaveCount(0);
  }
  await editField(screen, "Name", "Receipts");
  await browser.reload();
  await expect(screen.getByRole("button", /^Name/)).toContainText("Receipts");
  expect(writes).toHaveLength(1);
  expect(writes[0]).toMatchObject({ name: "Receipts", endpoint: "" });
  expect(writes[0]).not.toHaveProperty("instructions");
});

test("renaming an externally hosted Bot preserves its real endpoint and offers a callback key", async (fixtures) => {
  const { app, browser, screen } = fixtures;
  const bot = await createBot(fixtures);
  await browser.evaluate(
    async ({ bot, endpoint }) => {
      const response = await fetch(
        `/api/agents/${encodeURIComponent(bot.id)}`,
        {
          method: "PATCH",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            name: bot.name,
            title: "Finance Operations",
            roleDescription: "Review receipts.",
            visibility: "private",
            endpoint,
          }),
        },
      );
      if (!response.ok)
        throw new Error(
          `Cannot seed the Bot endpoint: HTTP ${response.status}`,
        );
      return null;
    },
    { bot, endpoint: externalEndpoint },
  );
  const writes = await observeSetup(browser, bot.id);
  await app.open(`/bots/${bot.id}/setup`);
  const endpoint = screen.getByText(externalEndpoint, { exact: true });
  await expect(endpoint).toBeVisible();
  await expect(
    screen.getByText(
      "This Bot has no key yet. It can talk but can't use tools. Generate a key and add it to your agent's configuration.",
      { exact: true },
    ),
  ).toBeVisible();
  await expect(
    screen.getByRole("button", "Generate key", { exact: true }),
  ).toBeVisible();
  await editField(screen, "Name", "Receipts");
  await browser.reload();
  await expect(screen.getByRole("button", /^Name/)).toContainText("Receipts");
  await expect(endpoint).toBeVisible();
  expect(writes).toHaveLength(1);
  expect(writes[0]).toMatchObject({
    name: "Receipts",
    endpoint: externalEndpoint,
  });
});

if (personal) {
  test("the starter edits instructions independently and keeps the stored subtitle when saved unchanged", async (fixtures) => {
    const { app, browser, screen } = fixtures;
    const bot = await createBot(fixtures);
    const stored = "Everyday life. Powered by LangChain (LangGraph).";
    const shown =
      "Everyday life agent. (powered by a LangChain agent; you can bring your own agent from any stack.)";
    const instructions =
      "You are a personal assistant for one person. Be clear and brief.";
    const description = "Review receipts.";
    let starter: Profile = {
      ...bot,
      title: stored,
      roleDescription: description,
      instructions,
      builtIn: false,
      endpoint: harnessEndpoint,
      keyFromOpenBot: true,
      visibility: "private",
      canManage: true,
    };
    const writes = await observeSetup(
      browser,
      bot.id,
      (agent) => ({ ...agent, ...starter }),
      (patch) => {
        starter = { ...starter, ...patch };
      },
    );

    await app.open(`/bots/${bot.id}/setup`);
    await expect(screen.getByRole("button", /^What it does/)).toContainText(
      description,
    );
    await expect(screen.getByRole("button", /^What it does/)).not.toContainText(
      instructions,
    );
    await expect(screen.getByRole("button", /^Instructions/)).toContainText(
      instructions,
    );
    await expect(screen.getByRole("button", /^Title/)).toContainText(shown);
    await expect(
      screen.getByText(
        "OpenBot runs this Bot, so it can use its tools without a key.",
        { exact: true },
      ),
    ).toBeVisible();
    await expect(screen.getByText(/can't use tools/)).toHaveCount(0);
    await expect(
      screen.getByRole("button", "Generate key", { exact: true }),
    ).toHaveCount(0);

    const changed = `${instructions} I live in Berlin.`;
    await editField(screen, "Instructions", changed);
    await editField(screen, "Name", "Assistant");
    await screen.getByRole("button", /^Title/).tap();
    const title = screen.getByRole("dialog", "Title", { exact: true });
    await expect(
      title.getByRole("textbox", "Title", { exact: true }),
    ).toHaveValue(shown);
    await title.getByRole("button", "Save", { exact: true }).tap();
    await expect(title).toHaveCount(0);
    await browser.reload();
    await expect(screen.getByRole("button", /^Instructions/)).toContainText(
      changed,
    );
    await expect(screen.getByRole("button", /^Title/)).toContainText(shown);
    expect(writes).toHaveLength(3);
    expect(writes[0]).toMatchObject({
      roleDescription: description,
      instructions: changed,
    });
    expect(writes[1]).toMatchObject({ name: "Assistant", title: stored });
    expect(writes[2]).toMatchObject({ title: stored });
  });
} else {
  test("someone without management rights can read Setup but cannot edit the Bot", async (fixtures) => {
    const { app, browser, screen } = fixtures;
    const bot = await createBot(fixtures);
    await observeSetup(browser, bot.id, (agent) => ({
      ...agent,
      canManage: false,
      mine: false,
    }));
    await app.open(`/bots/${bot.id}/setup`);
    const identity = browser.locator("section").filter({
      has: screen.getByRole("heading", "Identity", { exact: true }),
    });
    await expect(identity.getByText(bot.name, { exact: true })).toBeVisible();
    await expect(identity.getByRole("button", /^Name/)).toHaveCount(0);
    await expect(
      identity.getByRole("switch", "Isolated", { exact: true }),
    ).toHaveCount(0);
  });
}

async function serveIsolation(
  browser: Browser,
  read: () => { available: boolean; allowed: boolean },
) {
  await browser.route(/\/api\/agents\/capabilities$/, (route) =>
    route.fulfill({
      json: {
        capabilities: {
          builtInAvailable: true,
          isolationAvailable: read().available,
        },
      },
    }),
  );
  await browser.route(/\/api\/admin\/enterprise\/me$/, (route) =>
    route.fulfill({
      json: {
        capabilities: { isolatedComputers: read().allowed },
        enforced: true,
      },
    }),
  );
}

if (!personal) {
  test("turning on isolation shows the computer-sharing implications of making the Bot public", async (fixtures) => {
    const { app, browser, screen } = fixtures;
    const bot = await createBot(fixtures);
    let state: Profile = {
      ...bot,
      title: "Finance",
      roleDescription: "Review receipts.",
      visibility: "private",
      isolated: false,
      canManage: true,
      builtIn: true,
    };
    await serveIsolation(browser, () => ({ available: true, allowed: true }));
    const writes = await observeSetup(
      browser,
      bot.id,
      (agent) => ({ ...agent, ...state, isolationActive: state.isolated }),
      (patch) => {
        state = { ...state, ...patch };
      },
    );
    await app.open(`/bots/${bot.id}/setup`);
    const toggle = screen.getByRole("switch", "Isolated", { exact: true });
    await expect(toggle).toHaveAttribute("aria-checked", "false");
    await expect(
      screen.getByText("Runs on your computer, alongside your other Bots.", {
        exact: true,
      }),
    ).toBeVisible();
    await toggle.tap();
    await expect(toggle).toHaveAttribute("aria-checked", "true");
    await browser.reload();
    await expect(toggle).toHaveAttribute("aria-checked", "true");
    await expect(
      screen.getByText(
        "Runs in its own computer. Nothing it does can reach your other Bots' files or logins. Costs more to run.",
        { exact: true },
      ),
    ).toBeVisible();
    await expect(
      screen.getByText(
        /Only you can see it and start conversations with it\. Making it public shares its computer/,
      ),
    ).toBeVisible();

    const identity = browser.locator("section").filter({
      has: screen.getByRole("heading", "Identity", { exact: true }),
    });
    const visibility = identity.getByRole("combobox");
    await expect(visibility).toContainText("Private");
    await visibility.tap();
    await screen.getByRole("option", "Public", { exact: true }).tap();
    await expect(
      screen.getByText(
        "Everyone on OpenBot can find and use it. Everyone who uses it shares its computer, so anything signed in to there is theirs too.",
        { exact: true },
      ),
    ).toBeVisible();
    await editField(screen, "Name", "Receipts");
    await expect(toggle).toHaveAttribute("aria-checked", "true");
    await toggle.tap();
    await expect(toggle).toHaveAttribute("aria-checked", "false");
    await expect(
      screen.getByText("Everyone on OpenBot can find and use it.", {
        exact: true,
      }),
    ).toBeVisible();
    expect(writes).toHaveLength(4);
    expect(writes[0]).toMatchObject({ isolated: true });
    expect(writes[1]).toMatchObject({ visibility: "public" });
    expect(writes[2]).toMatchObject({ name: "Receipts" });
    expect(writes[2]).not.toHaveProperty("isolated");
    expect(writes[3]).toMatchObject({ isolated: false });
  });

  test("isolation displays deployment and permission restrictions and can be turned off after withdrawal", async (fixtures) => {
    const { app, browser, screen } = fixtures;
    const bot = await createBot(fixtures);
    let available = false;
    let allowed = true;
    let isolated = false;
    await serveIsolation(browser, () => ({ available, allowed }));
    const writes = await observeSetup(
      browser,
      bot.id,
      (agent) => ({
        ...agent,
        ...bot,
        title: "Finance",
        roleDescription: "Review receipts.",
        visibility: "private",
        canManage: true,
        isolated,
        isolationActive: false,
        isolationOffReason: isolated ? "admin" : null,
      }),
      (patch) => {
        isolated = patch.isolated === true;
      },
    );
    const path = `/bots/${bot.id}/setup`;
    const toggle = screen.getByRole("switch", "Isolated", { exact: true });
    await app.open(path);
    await expect(
      screen.getByText("This OpenBot can't give a Bot a computer of its own.", {
        exact: true,
      }),
    ).toBeVisible();
    await expect(toggle).toBeDisabled();

    available = true;
    allowed = false;
    await app.open(path);
    await expect(
      screen.getByText("Your admin turned off Isolated Bots for you.", {
        exact: true,
      }),
    ).toBeVisible();
    await expect(toggle).toBeDisabled();
    expect(writes).toEqual([]);

    isolated = true;
    await app.open(path);
    await expect(
      screen.getByText(
        "Your admin turned off Isolated Bots, so this Bot runs on your computer.",
        { exact: true },
      ),
    ).toBeVisible();
    await expect(toggle).toHaveAttribute("aria-checked", "true");
    await expect(toggle).toBeEnabled();
    await toggle.tap();
    await expect(toggle).toHaveAttribute("aria-checked", "false");
    await expect(toggle).toBeDisabled();
    expect(writes).toHaveLength(1);
    expect(writes[0]).toMatchObject({ isolated: false });
  });
}
