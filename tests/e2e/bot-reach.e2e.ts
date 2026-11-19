import { type Browser, test } from "@e2e-dev/web";
import { expect } from "e2e";
import { createConversation } from "./conversations";
import { createBot } from "./signed-in";

type DeliveryTarget = { agentId: string; channelId: string };

async function serveDelivery(
  browser: Browser,
  targets: DeliveryTarget[],
  sms: boolean,
) {
  const writes: { method: string; path: string; body: unknown }[] = [];
  let verified = false;
  await browser.route(/\/api\/delivery$/, (route) =>
    route.fulfill({
      json: {
        bindings: [
          ...targets.map((target) => ({
            ...target,
            id: `slack-${target.agentId}`,
            transport: "slack",
            address: `slack-dm-${target.agentId}`,
            enabled: true,
          })),
          ...(verified
            ? [
                {
                  ...targets[0],
                  id: "confirmed-sms",
                  transport: "sms",
                  address: "+15551234567",
                  enabled: true,
                },
              ]
            : []),
        ],
        devices: [],
        deliveries: [],
        available: { slack: true, teams: false, sms, push: false },
      },
    }),
  );
  await browser.route(
    /\/api\/delivery\/(?:opentag\/start|sms\/(?:start|confirm))$/,
    (route) => {
      const path = new URL(route.request.url).pathname;
      writes.push({
        method: route.request.method,
        path,
        body: JSON.parse(route.request.postData ?? "null"),
      });
      switch (path) {
        case "/api/delivery/opentag/start":
          return route.fulfill({
            json: {
              platform: "slack",
              code: "abc",
              command: "link abc",
              expiresInMinutes: 10,
            },
          });
        case "/api/delivery/sms/start":
          return route.fulfill({ json: { challengeId: "challenge-1" } });
        case "/api/delivery/sms/confirm":
          verified = true;
          return route.fulfill({ json: { ok: true } });
        default:
          throw new Error(`Unexpected delivery request: ${path}`);
      }
    },
  );
  return writes;
}

test("Slack links the selected Bot conversation and keeps its link code after closing the dialog", async (fixtures) => {
  const { app, browser, screen } = fixtures;
  const own = await createBot(fixtures);
  const other = await createBot(fixtures);
  const channelId = await createConversation(browser, own.id, "Finance desk");
  const otherChannel = await createConversation(browser, other.id, "Docs desk");
  const writes = await serveDelivery(
    browser,
    [
      { agentId: own.id, channelId },
      { agentId: other.id, channelId: otherChannel },
    ],
    false,
  );

  await app.open(`/bots/${own.id}/reach`);
  await expect(
    screen.getByRole("heading", "Reaching you", { exact: true }),
  ).toBeVisible();
  await expect(
    screen.getByRole("button", "Disconnect", { exact: true }),
  ).toHaveCount(1);
  await expect(
    screen.getByText(
      "Not set up yet. An admin has to turn on Slack and Teams first.",
      { exact: true },
    ),
  ).toBeVisible();
  await expect(screen.getByRole("button", /^Link Microsoft Teams/)).toHaveCount(
    0,
  );
  const trigger = screen.getByRole("button", /^Link Slack/);
  await trigger.tap();
  const dialog = screen.getByRole("dialog", "Link Slack", { exact: true });
  await expect(dialog.getByText(/Linking it here moves it/)).toBeVisible();
  await expect(dialog.getByRole("combobox", /^Bot/)).toHaveCount(0);
  const link = dialog.getByRole("button", "Link Slack", { exact: true });
  await expect(link).toBeDisabled();
  const conversation = dialog.getByRole("combobox", "Conversation", {
    exact: true,
  });
  await conversation.tap();
  const finance = screen.getByRole("option", /^.+: Finance desk$/);
  await expect(finance).toBeVisible();
  await expect(screen.getByRole("option", /^.+: Docs desk$/)).toHaveCount(0);
  await finance.tap();
  await expect(link).toBeEnabled();
  await link.tap();
  const command = dialog.getByText("link abc", { exact: true });
  await expect(command).toBeVisible();
  await conversation.press("Escape");
  await expect(dialog).toHaveCount(0);
  await expect(
    screen.getByText(/Your link code is ready to send/),
  ).toBeVisible();
  await trigger.tap();
  await expect(command).toBeVisible();
  await expect(conversation).toContainText("Finance desk");
  expect(writes).toEqual([
    {
      method: "POST",
      path: "/api/delivery/opentag/start",
      body: { channelId, agentId: own.id, platform: "slack" },
    },
  ]);
});

test("a phone is verified for the chosen conversation and shows as connected", async (fixtures) => {
  const { app, browser, screen } = fixtures;
  const bot = await createBot(fixtures);
  const channelId = await createConversation(browser, bot.id, "Finance desk");
  const writes = await serveDelivery(
    browser,
    [{ channelId, agentId: bot.id }],
    true,
  );

  await app.open(`/bots/${bot.id}/reach`);
  await screen.getByRole("button", /^Connect a phone/).tap();
  const dialog = screen.getByRole("dialog", "Connect a phone", { exact: true });
  const submit = dialog.getByRole("button", "Send verification code", {
    exact: true,
  });
  await expect(submit).toBeDisabled();
  await dialog.getByRole("combobox", "Conversation", { exact: true }).tap();
  await screen.getByRole("option", /^.+: Finance desk$/).tap();
  await dialog.getByLabel("Phone number", { exact: true }).fill("+15551234567");
  await submit.tap();
  await dialog.getByLabel("Verification code", { exact: true }).fill("123456");
  await dialog.getByRole("button", "Confirm phone", { exact: true }).tap();
  await expect(dialog).toHaveCount(0);
  await expect(screen.getByText("+15551234567", { exact: true })).toBeVisible();
  expect(writes).toEqual([
    {
      method: "POST",
      path: "/api/delivery/sms/start",
      body: { channelId, agentId: bot.id, phone: "+15551234567" },
    },
    {
      method: "POST",
      path: "/api/delivery/sms/confirm",
      body: { challengeId: "challenge-1", code: "123456" },
    },
  ]);
});
