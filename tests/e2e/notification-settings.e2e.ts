import { type Browser, test } from "@e2e-dev/web";
import { expect } from "e2e";
import { createBot } from "./signed-in";

const path = "/settings/notifications";
const personal = process.env.OPENBOT_E2E_SUITE === "personal";
const allChannels = { slack: true, teams: true, sms: true, push: true };
const noChannels = { slack: false, teams: false, sms: false, push: false };
const defaultRouting: Record<
  "progress" | "decision" | "question" | "attention",
  "all" | string[]
> = {
  progress: ["push"],
  decision: "all",
  question: "all",
  attention: ["push", "slack"],
};
const guidance = /Choose where to receive each type of update/;
const setupUrl =
  "https://github.com/CopilotKit/openbot/blob/main/docs/configuration.md#slack-and-microsoft-teams-opentag-pairing";

for (const allowed of [true, false]) {
  test(`check-ins respect ${allowed ? "the person's saved preference" : "the administrator's restriction"} on both settings pages`, async (fixtures) => {
    const { app, browser, screen } = fixtures;
    const bot = await createBot(fixtures);
    const writes: { method: string; body: unknown }[] = [];
    let proactive = "on";
    await browser.route(/\/api\/settings\/preferences$/, async (route) => {
      const method = route.request.method;
      if (method === "PATCH") {
        const body = JSON.parse(route.request.postData ?? "null");
        writes.push({ method, body });
        proactive = body.proactive;
      }
      return route.fulfill({
        json: {
          preferences: {
            messageListEmphasis: "thread",
            selfHostBannerDismissed: true,
            narration: null,
            skin: "openbot",
            proactive,
          },
        },
      });
    });
    await browser.route(/\/api\/proactive\/settings$/, (route) =>
      route.fulfill({
        json: {
          allowed,
          settings: [
            {
              id: "check-in-fixture",
              agentId: bot.id,
              channelId: "fixture-channel",
              focus: "Check the expenses",
              enabled: true,
              intervalMinutes: 60,
              nextRunAt: "2035-10-30T12:00:00Z",
              lastRunAt: null,
              lastStatus: "idle",
              lastError: null,
            },
          ],
        },
      }),
    );
    await serveNotifications(browser);
    await app.open(path);
    const toggle = screen.getByRole("switch", "Check-ins for all your Bots");
    if (allowed) {
      await expect(
        screen.getByText(
          `On. Each Bot's own check-ins are on its ${personal ? "What it can do" : "Memory"} page.`,
          { exact: true },
        ),
      ).toBeVisible();
      if (personal)
        await expect(screen.getByText(/Memory page/)).toHaveCount(0);
      await expect(toggle).toHaveAttribute("aria-checked", "true");
      await toggle.click();
      await expect(
        screen.getByText("Off. None of your Bots check in for you.", {
          exact: true,
        }),
      ).toBeVisible();
      expect(writes).toEqual([{ method: "PATCH", body: { proactive: "off" } }]);
    } else {
      await expect(
        screen.getByText("Turned off by your admin.", { exact: true }),
      ).toBeVisible();
      await expect(toggle).toBeDisabled();
      expect(writes).toEqual([]);
    }
    await expect(toggle).toHaveAttribute("aria-checked", "false");
    await browser.reload();
    await expect(toggle).toHaveAttribute("aria-checked", "false");
    await app.open(`/bots/${bot.id}/${personal ? "access" : "memory"}`);
    if (allowed) {
      await expect(
        screen.getByText(/You turned off check-ins for all your Bots in/),
      ).toBeVisible();
      await expect(
        screen.getByRole("link", "Notifications", { exact: true }),
      ).toHaveAttribute("href", path);
      await expect(
        screen.getByText("Every hour · Off for all your Bots", { exact: true }),
      ).toBeVisible();
    } else {
      await expect(
        screen.getByText("Your admin turned off check-ins for you.", {
          exact: true,
        }),
      ).toBeVisible();
      await expect(
        screen.getByText("Every hour · Turned off by your admin", {
          exact: true,
        }),
      ).toBeVisible();
    }
  });
}

function delivery(
  id: string,
  transport: string,
  kind: string,
  state: string,
  error: string | null = null,
) {
  return {
    id,
    transport,
    kind,
    state,
    error,
    createdAt: "2026-10-30T22:24:30Z",
  };
}

async function serveNotifications(
  browser: Browser,
  options: {
    available?: typeof allChannels;
    devices?: { id: string; platform: string; enabled: boolean }[];
    deliveries?: ReturnType<typeof delivery>[];
    routing?: typeof defaultRouting;
    role?: "admin" | "user";
    localEvaluation?: boolean;
  } = {},
) {
  let devices = options.devices ?? [];
  const routing = { ...(options.routing ?? defaultRouting) };
  const writes: { request: string; body: unknown }[] = [];
  await browser.route(/\/api\/delivery$/, (route) =>
    route.fulfill({
      json: {
        bindings: [],
        devices,
        deliveries: options.deliveries ?? [],
        available: options.available ?? allChannels,
      },
    }),
  );
  await browser.route(/\/api\/delivery\/devices\/[^/]+$/, (route) => {
    const url = new URL(route.request.url);
    writes.push({
      request: `${route.request.method} ${url.pathname}`,
      body: null,
    });
    devices = devices.filter(({ id }) => !url.pathname.endsWith(`/${id}`));
    return route.fulfill({ json: { ok: true } });
  });
  await browser.route(/\/api\/bots\/routing(?:\/[^/]+)?$/, (route) => {
    if (route.request.method === "GET")
      return route.fulfill({ json: { routing } });
    const url = new URL(route.request.url);
    const kind = url.pathname.split("/").at(-1);
    const body = JSON.parse(route.request.postData ?? "null");
    writes.push({ request: `${route.request.method} ${url.pathname}`, body });
    if (kind === "progress" || kind === "attention")
      routing[kind] = body.transports;
    return route.fulfill({ json: { ok: true } });
  });
  await browser.route(/\/api\/me$/, async (route) => {
    const data = await (await route.fetch()).json<{ user: { role: string } }>();
    return route.fulfill({
      json: { ...data, user: { ...data.user, role: options.role ?? "admin" } },
    });
  });
  await browser.route(/\/api\/capabilities$/, async (route) => {
    const data = await (await route.fetch()).json<Record<string, unknown>>();
    return route.fulfill({
      json: { ...data, localEvaluation: options.localEvaluation ?? false },
    });
  });
  return writes;
}

test("Progress and Something needs you save separate transport preferences", async ({
  app,
  browser,
  screen,
}) => {
  const writes = await serveNotifications(browser);
  await app.open(path);
  await expect(screen.getByText(guidance)).toBeVisible();
  await expect(
    screen.getByText("Something needs you", { exact: true }),
  ).toBeVisible();
  const progress = screen.getByRole("switch", "Progress by SMS", {
    exact: true,
  });
  const attention = screen.getByRole("switch", "Something needs you by SMS", {
    exact: true,
  });
  await expect(progress).toHaveAttribute("aria-checked", "false");
  await expect(attention).toHaveAttribute("aria-checked", "false");
  await progress.click();
  await expect(progress).toHaveAttribute("aria-checked", "true");
  await expect(attention).toHaveAttribute("aria-checked", "false");
  await attention.click();
  await expect(attention).toHaveAttribute("aria-checked", "true");
  expect(writes).toEqual([
    {
      request: "PUT /api/bots/routing/progress",
      body: { transports: ["push", "sms"] },
    },
    {
      request: "PUT /api/bots/routing/attention",
      body: { transports: ["push", "slack", "sms"] },
    },
  ]);
  await browser.reload();
  await expect(progress).toHaveAttribute("aria-checked", "true");
  await expect(attention).toHaveAttribute("aria-checked", "true");
});

test("changing a configured channel preserves the saved choice for an unavailable channel", async ({
  app,
  browser,
  screen,
}) => {
  const writes = await serveNotifications(browser, {
    available: { ...noChannels, slack: true, push: true },
    routing: { ...defaultRouting, progress: ["push", "sms"] },
  });
  await app.open(path);
  const slack = screen.getByRole("switch", "Progress by Slack", {
    exact: true,
  });
  await expect(slack).toBeVisible();
  await expect(
    screen.getByRole("switch", "Progress by SMS", { exact: true }),
  ).toHaveCount(0);
  await expect(
    screen.getByText("Microsoft Teams", { exact: true }),
  ).toHaveCount(0);
  await expect(screen.getByText("Not set up", { exact: true })).toHaveCount(0);
  await slack.click();
  await expect(slack).toHaveAttribute("aria-checked", "true");
  expect(writes).toEqual([
    {
      request: "PUT /api/bots/routing/progress",
      body: { transports: ["push", "slack", "sms"] },
    },
  ]);
});

for (const scenario of [
  {
    name: "an admin",
    role: "admin",
    localEvaluation: false,
    setup: true,
    desktop: false,
  },
  {
    name: "a self-hosted user",
    role: "user",
    localEvaluation: true,
    setup: true,
    desktop: false,
  },
  {
    name: "a member",
    role: "user",
    localEvaluation: false,
    setup: false,
    desktop: false,
  },
  {
    name: "a Desktop user",
    role: "user",
    localEvaluation: true,
    setup: false,
    desktop: true,
  },
] as const) {
  test(`no configured transports show the appropriate setup advice to ${scenario.name}`, async ({
    app,
    browser,
    screen,
  }) => {
    if (scenario.desktop) {
      await browser.addInitScript(() => {
        Object.assign(window, {
          __TAURI_INTERNALS__: {
            transformCallback: () => 0,
            invoke: async () => null,
          },
        });
      });
    }
    await serveNotifications(browser, { ...scenario, available: noChannels });
    await app.open(path);
    await expect(
      screen.getByText("Updates stay in OpenBot", { exact: true }),
    ).toBeVisible();
    await expect(screen.getByText(guidance)).toHaveCount(0);
    await expect(
      screen.getByRole("switch", / by (Push|Slack|SMS|Microsoft Teams)$/),
    ).toHaveCount(0);
    const advice = scenario.desktop
      ? "Push, Slack, Microsoft Teams and text messages need OpenBot running on a server."
      : scenario.setup
        ? "Push, Slack, Microsoft Teams and text messages show up here once they're set up where OpenBot runs."
        : "Push, Slack, Microsoft Teams and text messages show up here once your admin sets them up.";
    await expect(screen.getByText(advice, { exact: true })).toBeVisible();
    const setup = screen.getByRole("link", "How to set them up", {
      exact: true,
    });
    if (scenario.setup) {
      await expect(setup).toHaveAttribute("href", setupUrl);
      await expect(setup).toHaveAttribute("target", "_blank");
    } else {
      await expect(setup).toHaveCount(0);
    }
  });
}

test("removing an iOS device updates the device list and leaves recent deliveries visible", async ({
  app,
  browser,
  screen,
}) => {
  const writes = await serveNotifications(browser, {
    devices: [{ id: "d1", platform: "ios", enabled: true }],
    available: { ...noChannels, push: true },
    deliveries: [delivery("x", "push", "question", "sent")],
  });
  await app.open(path);
  const ios = screen.getByText("iOS", { exact: true });
  await expect(ios).toBeVisible();
  await screen.getByRole("button", "Remove", { exact: true }).click();
  await expect(
    screen.getByText("No devices yet", { exact: true }),
  ).toBeVisible();
  await expect(ios).toHaveCount(0);
  expect(writes).toEqual([
    { request: "DELETE /api/delivery/devices/d1", body: null },
  ]);
  await expect(screen.getByText(/^Push · Sent · /)).toBeVisible();
  await browser.reload();
  await expect(
    screen.getByText("No devices yet", { exact: true }),
  ).toBeVisible();
  await expect(screen.getByText(/^Push · Sent · /)).toBeVisible();
});

test("delivery rows use readable labels and show the associated failure", async ({
  app,
  browser,
  screen,
}) => {
  const invalidDevice = "Expo delivery failed (DeviceNotRegistered).";
  const unknown = "OpenTag delivery failed (invalid_auth).";
  const optedOut =
    "Twilio reports this number opted out (21610). Nothing was sent.";
  await serveNotifications(browser, {
    deliveries: [
      delivery("ping", "push", "attention", "failed", invalidDevice),
      delivery("reply", "slack", "reply", "delivered"),
      delivery("approval", "teams", "approval", "sent"),
      delivery("question", "sms", "question", "queued"),
      delivery("unsure", "slack", "attention", "unknown", unknown),
      delivery("stopped", "sms", "attention", "opted_out", optedOut),
      delivery("handed", "push", "reply", "accepted"),
      delivery("going", "slack", "question", "running"),
    ],
  });
  await app.open(path);
  const log = browser.locator("section").filter({
    has: screen.getByRole("heading", "Recent deliveries", { exact: true }),
  });
  for (const [kind, label, error] of [
    ["Something needs you", "Push · Failed", invalidDevice],
    ["Progress", "Slack · Delivered"],
    ["Decision", "Microsoft Teams · Sent"],
    ["Question", "SMS · Waiting to send"],
    ["Something needs you", "Slack · Not confirmed", unknown],
    ["Something needs you", "SMS · Not sent", optedOut],
    ["Progress", "Push · Sending"],
    ["Question", "Slack · Sending"],
  ]) {
    const row = browser
      .locator('[data-slot="item"]')
      .filter({ hasText: label });
    await expect(row.getByText(kind, { exact: true })).toBeVisible();
    if (error)
      await expect(row.getByText(error, { exact: true })).toBeVisible();
  }
  await expect(log).not.toContainText(
    /\b(attention|unknown|opted_out|accepted|running)\b|(?:push|slack|sms) ·|teams/,
  );
});

test("a deployment with only Push offers one enabled switch per update kind", async ({
  app,
  browser,
  screen,
}) => {
  await serveNotifications(browser, {
    available: { ...noChannels, push: true },
    routing: { ...defaultRouting, progress: "all" },
  });
  await app.open(path);
  const push = screen.getByRole("switch", "Progress by Push", { exact: true });
  await expect(push).toHaveAttribute("aria-checked", "true");
  await expect(push).toBeEnabled();
  await expect(screen.getByRole("switch", / by Push$/)).toHaveCount(4);
  await expect(
    screen.getByRole("switch", / by (Slack|SMS|Microsoft Teams)$/),
  ).toHaveCount(0);
  await expect(screen.getByText("Not set up", { exact: true })).toHaveCount(0);
});

test("legacy all-channel preferences include configured Slack", async ({
  app,
  browser,
  screen,
}) => {
  await serveNotifications(browser, {
    routing: { ...defaultRouting, progress: "all" },
  });
  await app.open(path);
  const slack = screen.getByRole("switch", "Progress by Slack", {
    exact: true,
  });
  await expect(slack).toHaveAttribute("aria-checked", "true");
  await expect(slack).toBeEnabled();
  await expect(screen.getByText("Not set up", { exact: true })).toHaveCount(0);
});

test("an empty device list shows its explanation and decorative pattern", async ({
  app,
  browser,
  screen,
}) => {
  await serveNotifications(browser);
  await app.open(path);
  const description = "Phones and computers you sign in on show up here.";
  const empty = browser
    .locator('[data-slot="empty"]')
    .filter({ hasText: description });
  await expect(
    empty.getByText("No devices yet", { exact: true }),
  ).toBeVisible();
  await expect(screen.getByText(description, { exact: true })).toBeVisible();
  const style = await browser.evaluate((text) => {
    const box = Array.from(
      document.querySelectorAll<HTMLElement>('[data-slot="empty"]'),
    ).find((element) => element.textContent?.includes(text));
    if (!box) throw new Error("The device empty state is missing");
    const sample = document.createElement("span");
    sample.style.color = "var(--border)";
    box.append(sample);
    const expectedBorder = getComputedStyle(sample).color;
    sample.remove();
    const { borderTopColor, borderTopStyle, backgroundColor } =
      getComputedStyle(box);
    const pattern = box.querySelector(".empty-pattern");
    return {
      borderTopColor,
      expectedBorder,
      borderTopStyle,
      backgroundColor,
      patternHidden: pattern?.getAttribute("aria-hidden") ?? null,
      patternMask: pattern ? getComputedStyle(pattern).maskImage : "none",
    };
  }, description);
  expect(style.borderTopColor).toBe(style.expectedBorder);
  expect(style.borderTopStyle).toBe("dashed");
  expect(style.backgroundColor).toBe("rgba(0, 0, 0, 0)");
  expect(style.patternHidden).toBe("true");
  expect(style.patternMask).not.toBe("none");
});
