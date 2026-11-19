import { spawn } from "node:child_process";
import { once } from "node:events";
import { readFile } from "node:fs/promises";
import { createInterface } from "node:readline";
import { type Browser, test } from "@e2e-dev/web";
import { expect } from "e2e";
import {
  connectAppRefusal,
  SHOW_APP_ACCESS_TOOL,
} from "../../shared/connect-prompt";
import { configureChatStream } from "./chat-stream";
import { createConversation } from "./conversations";
import { createBot } from "./signed-in";

const fixtureScript = "tests/e2e/fixtures/personal-notion-server.ts";
const desktopScript = "desktop/src-tauri/src/outside-links.js";
const provider = "https://mcp.notion.com";
const routePattern =
  /\/api\/plugins\/(?:for\/[^/]+\/apps\/notion(?:\/approve)?|servers\/notion\/connect)(?:\?|$)/;

type DesktopWindow = Window & {
  fixtureExternalLinks?: string[];
  __openbotNavigate?: (href: string) => void;
};

async function installDesktopOutsideLinks(browser: Browser) {
  await browser.addInitScript(() => {
    const page: DesktopWindow = window;
    page.fixtureExternalLinks = [];
    page.__openbotNavigate = (href) => page.fixtureExternalLinks?.push(href);
  });
  await browser.addInitScript(await readFile(desktopScript, "utf8"));
}

function desktopLinks(browser: Browser) {
  return browser.evaluate(
    () => (window as DesktopWindow).fixtureExternalLinks ?? [],
  );
}

async function openAppAccessCard(
  { app, browser }: Pick<Parameters<typeof createBot>[0], "app" | "browser">,
  { botId, key, title }: { botId: string; key: string; title: string },
) {
  const channel = await createConversation(
    browser,
    botId,
    `${title} before sign-in`,
  );
  const conversation = `/channel/${channel}`;
  const toolCallId = `app-access-${channel}`;
  await configureChatStream(browser, [
    {
      id: "question",
      role: "user",
      content: `Read my latest notes in ${title}.`,
    },
    {
      id: "assistant",
      role: "assistant",
      content: "",
      toolCalls: [
        {
          id: toolCallId,
          type: "function",
          function: {
            name: SHOW_APP_ACCESS_TOOL,
            arguments: JSON.stringify({ app: key }),
          },
        },
      ],
    },
    {
      id: "tool",
      role: "tool",
      toolCallId,
      content: connectAppRefusal({
        serverId: key,
        title,
        message: `${title} isn't connected yet.`,
        agentId: botId,
        reason: "access",
        blocked: true,
      }),
    },
  ]);
  await app.open(conversation);
  return conversation;
}

async function startNotion(turnedOn: boolean) {
  const database = process.env.DATABASE_URL;
  if (!database)
    throw new Error("The Chromium suite requires its disposable database.");
  const args = ["--no-env-file", fixtureScript];
  if (turnedOn) args.push("--previously-enabled");
  const child = spawn("bun", args, {
    env: { ...process.env, TEST_DATABASE_URL: database },
    stdio: ["ignore", "pipe", "inherit"],
  });
  const closed = new Promise<void>((resolve, reject) => {
    child.once("error", reject);
    child.once("close", (code, signal) => {
      if (code === 0) resolve();
      else
        reject(
          new Error(`The Notion route fixture exited with ${code ?? signal}.`),
        );
    });
  });
  const stop = async () => {
    if (child.exitCode === null && child.signalCode === null)
      child.kill("SIGTERM");
    await closed;
  };
  const output = createInterface({ input: child.stdout });
  try {
    const [line] = await Promise.race([
      once(output, "line", { signal: AbortSignal.timeout(15_000) }),
      closed.then(() => {
        throw new Error(
          "The Notion route fixture exited before publishing its address.",
        );
      }),
    ]);
    const value: unknown = JSON.parse(line);
    if (
      typeof value !== "object" ||
      value === null ||
      !("address" in value) ||
      typeof value.address !== "string" ||
      !("botId" in value) ||
      typeof value.botId !== "string" ||
      !("clientId" in value) ||
      typeof value.clientId !== "string"
    )
      throw new Error(
        "The Notion route fixture published an invalid address or identity.",
      );
    return {
      address: value.address,
      botId: value.botId,
      clientId: value.clientId,
      stop,
    };
  } catch (error) {
    await stop();
    throw error;
  } finally {
    output.close();
  }
}

for (const { turnedOn, transport } of [
  { turnedOn: false, transport: "browser" },
  { turnedOn: true, transport: "browser" },
  { turnedOn: false, transport: "desktop" },
  { turnedOn: true, transport: "desktop" },
] as const) {
  test(`one click opens Notion sign-in on ${transport} when the App is ${turnedOn ? "enabled without tools" : "off"}`, async ({
    app,
    browser,
    screen,
  }) => {
    const fixture = await startNotion(turnedOn);
    try {
      const requests: string[] = [];
      await browser.route(routePattern, async (route) => {
        const original = new URL(route.request.url);
        const path = original.pathname + original.search;
        const method = route.request.method;
        if (method !== "GET") requests.push(`${method} ${path}`);
        const response = await fetch(new URL(path, fixture.address), {
          method,
          body: route.request.postData ?? undefined,
          headers: route.request.postData
            ? { "Content-Type": "application/json" }
            : undefined,
          signal: AbortSignal.timeout(15_000),
        });
        return route.fulfill({
          status: response.status,
          contentType: "application/json",
          body: await response.text(),
        });
      });

      if (transport === "desktop") {
        await installDesktopOutsideLinks(browser);
      } else {
        await browser.route("https://mcp.notion.com/authorize**", (route) =>
          route.fulfill({
            contentType: "text/html",
            body: "<!doctype html><title>Notion sign-in</title><h1>Notion sign-in</h1>",
          }),
        );
      }

      await app.open("/connections");
      const conversation = await openAppAccessCard(
        { app, browser },
        {
          botId: fixture.botId,
          key: "notion",
          title: "Notion",
        },
      );
      const card = browser.locator('[data-app-access="notion"]');
      const connect = card.getByRole("button", "Connect Notion", {
        exact: true,
      });
      await expect(connect).toBeVisible();
      await expect(card).toHaveAttribute(
        "data-state",
        turnedOn ? "not_granted" : "disabled",
      );
      const [original] = browser.tabs();
      if (!original) throw new Error("Expected the original conversation tab");
      let address: string;
      let popup: Awaited<ReturnType<typeof browser.waitForPopup>> | undefined;
      if (transport === "desktop") {
        await connect.click();
        await expect.poll(() => desktopLinks(browser)).toHaveLength(1);
        address = (await desktopLinks(browser))[0] ?? "";
        expect(browser.tabs()).toHaveLength(1);
      } else {
        popup = await browser.waitForPopup(() => connect.click());
        await expect(
          screen.getByRole("heading", "Notion sign-in", { exact: true }),
        ).toBeVisible();
        address = await browser.url();
        await original.activate();
      }
      const signIn = new URL(address);
      expect(signIn.origin + signIn.pathname).toBe(`${provider}/authorize`);
      expect(signIn.searchParams.get("client_id")).toBe(fixture.clientId);
      expect(signIn.searchParams.get("response_type")).toBe("code");
      await expect(browser).toHaveURL(conversation);
      await expect(card.getByRole("alert")).toHaveCount(0);
      await expect(
        card.getByText("Finish in the tab that opened.", { exact: true }),
      ).toBeVisible();
      expect(requests).toEqual([
        `POST /api/plugins/for/${fixture.botId}/apps/notion/approve`,
        "POST /api/plugins/servers/notion/connect?returnTo=settings",
      ]);
      const grants = await fetch(new URL("/bot-tools", fixture.address));
      expect(grants.ok).toBe(true);
      expect(await grants.json()).toEqual([]);
      await popup?.close();
    } finally {
      await fixture.stop();
    }
  });
}

for (const { knownConsent, initialState } of [
  { knownConsent: true, initialState: "disabled" },
  { knownConsent: false, initialState: "disabled" },
  { knownConsent: true, initialState: "not_granted" },
] as const) {
  test(`one click hands off Gmail consent from ${initialState} with ${knownConsent ? "a known" : "an undiscovered"} sign-in scheme`, async (fixtures) => {
    const { browser } = fixtures;
    const bot = await createBot(fixtures);
    const key = "composio-gmail";
    const readPath = `/api/plugins/for/${bot.id}/apps/${key}`;
    const consentPath = `/api/plugins/servers/${key}/connect?returnTo=settings`;
    const vendorURL = "https://backend.composio.dev/api/v3/s/fixture-gmail";
    const writes: string[] = [];
    const vendorAnswer = Promise.withResolvers<void>();
    let enabled = false;
    await installDesktopOutsideLinks(browser);
    await browser.route(
      /\/api\/plugins\/for\/[^/]+\/apps\/composio-gmail$/,
      (route) =>
        route.fulfill({
          json: {
            app: {
              key,
              displayName: "Gmail",
              logo: null,
              provider: "composio",
              account: "personal",
              connect: enabled || knownConsent ? "consent" : null,
              authScheme: enabled ? "OAUTH2" : null,
              accountMode: enabled ? "personal" : null,
              state: enabled ? "not_connected" : initialState,
              unavailable:
                !enabled && initialState === "disabled" ? "absent" : null,
              accountHolder: "you",
              asksFirst: false,
              granted: enabled,
              ownerGrants: "any",
              givenByOwner: false,
              needsConnect: false,
              connectedAt: null,
              requestKind: enabled
                ? null
                : initialState === "disabled"
                  ? "enable"
                  : "grant",
              request: null,
            },
          },
        }),
    );
    await browser.route(
      /\/api\/plugins\/for\/[^/]+\/apps\/composio-gmail\/approve$/,
      (route) => {
        const { pathname } = new URL(route.request.url);
        writes.push(`${route.request.method} ${pathname}`);
        enabled = true;
        return route.fulfill({
          json: { enabled, granted: [`${key}/GMAIL_FETCH_EMAILS`] },
        });
      },
    );
    await browser.route(
      /\/api\/plugins\/servers\/composio-gmail\/connect\?/,
      async (route) => {
        const { pathname, search } = new URL(route.request.url);
        writes.push(`${route.request.method} ${pathname}${search}`);
        await vendorAnswer.promise;
        return route.fulfill({ json: { authorizationUrl: vendorURL } });
      },
    );

    const conversation = await openAppAccessCard(fixtures, {
      botId: bot.id,
      key,
      title: "Gmail",
    });
    const card = browser.locator(`[data-app-access="${key}"]`);
    const button = card.getByRole(
      "button",
      knownConsent ? "Connect Gmail" : "Turn on Gmail",
      { exact: true },
    );
    try {
      await expect(button).toBeVisible();
      await expect(card).toHaveAttribute("data-state", initialState);
      await expect(button).toHaveText(knownConsent ? "Connect" : "Turn on");
      await button.click();
      await expect(
        card.getByRole("button", "Opening sign-in…", { exact: true }),
      ).toBeVisible();
      await expect(card).toHaveAttribute("data-state", "not_connected");
      expect(await desktopLinks(browser)).toEqual([]);
      expect(writes).toEqual([
        `POST ${readPath}/approve`,
        `POST ${consentPath}`,
      ]);
    } finally {
      vendorAnswer.resolve();
    }
    await expect.poll(() => desktopLinks(browser)).toEqual([vendorURL]);
    await expect(
      card.getByText("Finish in the tab that opened.", { exact: true }),
    ).toBeVisible();
    await expect(
      card.getByRole("button", "Waiting for Gmail…", { exact: true }),
    ).toBeVisible();
    await expect(card.getByRole("alert")).toHaveCount(0);
    await expect(browser).toHaveURL(conversation);
    expect(browser.tabs()).toHaveLength(1);
  });
}

test("a personal Gmail card with no broker key opens the broker's setup directory", async (fixtures) => {
  const { browser } = fixtures;
  const bot = await createBot(fixtures);
  const key = "composio-gmail";
  await browser.route(
    /\/api\/plugins\/for\/[^/]+\/apps\/composio-gmail$/,
    (route) =>
      route.fulfill({
        json: {
          app: {
            key,
            displayName: "Gmail",
            provider: "composio",
            account: "personal",
            connect: "consent",
            state: "disabled",
            unavailable: "composio_unconfigured",
            granted: false,
            requestKind: "enable",
            request: null,
          },
        },
      }),
  );
  await openAppAccessCard(fixtures, { botId: bot.id, key, title: "Gmail" });
  const card = browser.locator(`[data-app-access="${key}"]`);
  await expect(
    card.getByText("Gmail isn't set up yet. Set it up to connect it.", {
      exact: true,
    }),
  ).toBeVisible();
  const setup = card.getByRole("button", "Set up Gmail", { exact: true });
  await expect(setup).toHaveAttribute("href", "/connections/browse/composio");
  await expect(setup).toHaveAttribute("target", "_blank");
});
