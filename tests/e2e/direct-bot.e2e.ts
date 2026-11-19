import { test } from "@e2e-dev/web";
import { expect } from "e2e";
import { configureChatStream } from "./chat-stream";

const general = { id: "general-assistant", name: "General Assistant" };
const picked = { id: "picked-harness", name: "LangGraph" };
const hidden = { id: "hidden-bot", name: "Hidden Bot" };
function profile(agent: { id: string; name: string }) {
  return {
    ...agent,
    avatarSeed: agent.id,
    title: agent.name,
    roleDescription: "Summarize conversation notes.",
    builtIn: true,
    canManage: true,
    endpoint: null,
    hasAuth: false,
    hasCallbackToken: false,
    isolated: false,
    isolationActive: false,
    isolationOffReason: null,
    hidden: agent.id === hidden.id,
    pinned: false,
    mine: true,
    systemOwned: false,
    visibility: "private",
  };
}

for (const { path, expected, agents } of [
  { path: "/bot", expected: picked, agents: [general, picked] },
  { path: "/bot?agent=", expected: picked, agents: [general, picked] },
  {
    path: "/bot?agent=general-assistant",
    expected: general,
    agents: [general, picked],
  },
  { path: "/bot", expected: general, agents: [general] },
  { path: "/bot?agent=hidden-bot", expected: hidden, agents: [general] },
]) {
  test(`${path} opens ${expected.name} with ${agents.length} Bots in the roster`, async ({
    app,
    browser,
    screen,
  }) => {
    await browser.route(/\/api\/agents(?:\?|$)/, (route) =>
      route.fulfill({ json: { agents: agents.map(profile) } }),
    );
    const detail: string[] = [];
    await browser.route(/\/api\/agents\/hidden-bot$/, (route) => {
      detail.push(route.request.method);
      return route.fulfill({ json: { agent: profile(hidden) } });
    });
    await configureChatStream(browser, "Welcome to the direct conversation.");
    await browser.route(/\/api\/copilotkit\/info$/, async (route) => {
      const response = await route.fetch();
      const info = await response.json<Record<string, unknown>>();
      const runtimeAgents = Object.fromEntries(
        [...agents, ...(expected === hidden ? [hidden] : [])].map(
          ({ id, name }) => [id, { description: name, capabilities: {} }],
        ),
      );
      return route.fulfill({
        json: { ...info, agents: runtimeAgents, mode: "sse" },
      });
    });
    await app.open(path);
    await expect(
      screen.getByRole("heading", expected.name, { exact: true }),
    ).toBeVisible();
    await expect(
      screen.getByText(/There's no Bot called|There are no Bots yet/),
    ).toHaveCount(0);
    await expect(
      browser.locator('[data-testid="copilot-chat-textarea"]'),
    ).toBeVisible();
    if (expected === hidden) expect(detail).toContain("GET");
  });
}

for (const failure of ["roster", "missing", "detail"]) {
  test(`/bot presents a ${failure} failure without creating a chat`, async ({
    app,
    browser,
    screen,
  }) => {
    const explicit = failure !== "roster";
    await browser.route(/\/api\/agents(?:\?|$)/, (route) =>
      explicit
        ? route.fulfill({ json: { agents: [profile(general)] } })
        : route.fulfill({ status: 500 }),
    );
    await browser.route(/\/api\/agents\/unavailable-bot$/, (route) =>
      route.fulfill({ status: failure === "missing" ? 404 : 500 }),
    );
    await app.open(explicit ? "/bot?agent=unavailable-bot" : "/bot");
    const message =
      failure === "roster"
        ? "Couldn't load your Bots. Reload the page."
        : failure === "missing"
          ? 'There\'s no Bot called "unavailable-bot".'
          : "Couldn't load this Bot. Reload the page.";
    await expect(screen.getByText(message, { exact: true })).toBeVisible();
    await expect(
      screen.getByText("There are no Bots yet.", { exact: true }),
    ).toHaveCount(0);
    await expect(
      browser.locator('[data-testid="copilot-chat-textarea"]'),
    ).toHaveCount(0);
  });
}
