import { test } from "@e2e-dev/web";
import { expect } from "e2e";
import {
  chatEventStream,
  chatRunPath,
  configureChatStream,
  readChatRun,
} from "./chat-stream";
import { createConversation } from "./conversations";
import { createBot } from "./signed-in";

const id = "request-mfa";
const site = "https://portal.example";
const tool = "computer_request_sign_in";
const toolCallId = "call-private-sign-in";
const collection = "/api/sign-in-requests";
const requestPath = `${collection}/${id}`;
const fixtureRequest = {
  id,
  botId: "default",
  origin: site,
  reason: null,
  status: "pending",
  method: null,
  outcome: null,
  threadId: null,
  toolCallId,
  controlRequestId: null,
  createdAt: "2026-10-12T10:00:00Z",
  expiresAt: "2035-10-12T10:15:00Z",
  resolvedAt: null,
  fillingUntil: null,
  passwordManager: true,
  savedLogins: [],
};

test("private sign-in asks for a verification code only after sending the password", async ({
  app,
  browser,
  screen,
}) => {
  const requests: { method: string; path: string; body: unknown }[] = [];
  const username = "alice@portal.example";
  const password = "fixture-password";
  const code = "731904";
  const invalidCode =
    "The site did not accept that code. Check it, or ask the site for a new one, and try again.";
  let request: Omit<typeof fixtureRequest, "method" | "outcome"> & {
    method: string | null;
    outcome: string | null;
  } = fixtureRequest;
  await browser.route(
    /\/api\/sign-in-requests\/request-mfa(?:\/(?:submit|code))?$/,
    (route) => {
      const path = new URL(route.request.url).pathname;
      if (route.request.method === "GET")
        return route.fulfill({ json: request });
      const body = JSON.parse(route.request.postData ?? "null");
      requests.push({ method: route.request.method, path, body });
      if (path.endsWith("/submit")) {
        request = { ...request, status: "code_required", method: "typed" };
      } else if (body?.code === code) {
        request = {
          ...request,
          status: "signed_in",
          outcome: `Signed in to ${site}.`,
        };
      } else {
        return route.fulfill({ status: 409, json: { error: invalidCode } });
      }
      return route.fulfill({ json: request });
    },
  );

  await app.open(`/sign-in/${id}`);
  await expect(screen.getByRole("heading", `Sign in to ${site}`)).toBeVisible();
  const login = screen.getByLabel("Username or email", { exact: true });
  const secret = screen.getByLabel("Password", { exact: true });
  const verification = screen.getByLabel("Verification code", { exact: true });
  await expect(secret).toBeVisible();
  await expect(verification).toHaveCount(0);
  await expect(screen.getByText(/verification code/i)).toHaveCount(0);
  await login.fill(username);
  await secret.fill(password);
  await screen.getByRole("button", "Sign in", { exact: true }).click();

  await expect(
    screen.getByText(
      "The site sent a verification code. Enter it to finish signing in.",
    ),
  ).toBeVisible();
  await expect(secret).toHaveCount(0);
  await expect(login).toHaveCount(0);
  expect(requests).toEqual([
    {
      method: "POST",
      path: `${requestPath}/submit`,
      body: { username, password, save: false },
    },
  ]);

  const finish = screen.getByRole("button", "Finish signing in", {
    exact: true,
  });
  await verification.fill("000000");
  await finish.click();
  await expect(screen.getByRole("alert")).toContainText(invalidCode);
  await expect(verification).toBeVisible();

  await verification.fill(code);
  await finish.click();
  await expect(
    screen.getByRole("heading", "Signed in", { exact: true }),
  ).toBeVisible();
  await expect(verification).toHaveCount(0);
  await expect(
    screen.getByText(`Signed in to ${site}.`, { exact: true }),
  ).toBeVisible();
  expect(requests.slice(1)).toEqual([
    { method: "POST", path: `${requestPath}/code`, body: { code: "000000" } },
    { method: "POST", path: `${requestPath}/code`, body: { code } },
  ]);
});

test("the streamed sign-in card opens a private dialog when its request is ready in a hidden tab", async (fixtures) => {
  const { app, browser, screen } = fixtures;
  const bot = await createBot(fixtures);
  const conversation = await createConversation(
    browser,
    bot.id,
    "Private sign-in",
  );
  const releaseRequest = Promise.withResolvers<void>();
  const request = {
    ...fixtureRequest,
    botId: bot.id,
    savedLogins: [{ id: "saved-1", username: "alice" }],
  };
  let created = false;
  let emptyReads = 0;
  const creates: unknown[] = [];
  await browser.addInitScript(() => {
    Object.defineProperty(document, "visibilityState", { get: () => "hidden" });
  });
  await browser.route(/\/api\/sign-in-requests$/, async (route) => {
    if (route.request.method === "POST") {
      creates.push(JSON.parse(route.request.postData ?? "null"));
      await releaseRequest.promise;
      created = true;
      await route.fulfill({ status: 201, json: request });
      return;
    }
    if (!created) emptyReads++;
    await route.fulfill({ json: { requests: created ? [request] : [] } });
  });
  await browser.route(/\/api\/sign-in-requests\/request-mfa$/, (route) =>
    route.fulfill({ json: request }),
  );
  await configureChatStream(browser, []);
  await browser.route(chatRunPath, (route) => {
    const { threadId, runId } = readChatRun(route.request.postData);
    return route.fulfill(
      chatEventStream([
        { type: "RUN_STARTED", threadId, runId },
        {
          type: "TOOL_CALL_START",
          toolCallId,
          toolCallName: tool,
          parentMessageId: "sign-in-request",
        },
        { type: "TOOL_CALL_ARGS", toolCallId, delta: JSON.stringify({ site }) },
        { type: "TOOL_CALL_END", toolCallId },
        { type: "RUN_FINISHED", threadId, runId },
      ]),
    );
  });

  const open = screen.getByRole("button", "Open private sign-in", {
    exact: true,
  });
  try {
    await app.open(`/channel/${conversation}`);
    await screen
      .getByRole("textbox", "Message", { exact: true })
      .fill("Open the private sign-in form.");
    await screen.getByRole("button", "Send message", { exact: true }).tap();
    await expect(
      screen.getByText("Waiting for you to sign in", { exact: true }),
    ).toBeVisible();
    await expect.poll(() => emptyReads).toBeGreaterThan(0);
    await expect(open).toHaveCount(0);
    await expect
      .poll(() => creates)
      .toEqual([{ botId: bot.id, site, toolCallId }]);
  } finally {
    releaseRequest.resolve();
  }

  await open.click();
  const dialog = screen.getByRole("dialog", `Sign in to ${site}`);
  await expect(dialog).toBeVisible();
  await expect(dialog.getByText(/Goes to your Bot's browser/)).toBeVisible();
  await expect(dialog.getByRole("heading", "Use a saved login")).toBeVisible();
  await expect(dialog.getByRole("heading", "Enter your login")).toBeVisible();
  const spacing = await browser.evaluate(() => {
    const body = document.querySelector('[data-slot="dialog-body"]');
    if (!body) throw new Error("Expected the private sign-in dialog body");
    const sections = Array.from(body.querySelectorAll(":scope > section"));
    const [saved, login] = sections.map((section) =>
      section.getBoundingClientRect(),
    );
    const form = sections[1]?.querySelector("form");
    if (!saved || !login || !form)
      throw new Error("Expected a saved-login section and login form");
    return {
      titles: sections.map(
        (section) => section.querySelector("h2")?.textContent ?? null,
      ),
      topMargins: sections.map(
        (section) => getComputedStyle(section).marginTop,
      ),
      gap: login.top - saved.bottom,
      rowGap: getComputedStyle(body).rowGap,
      formMargin: getComputedStyle(form).marginTop,
    };
  });
  expect(spacing.titles).toEqual(["Use a saved login", "Enter your login"]);
  expect(spacing.topMargins).toEqual(["0px", "0px"]);
  expect(spacing.rowGap).toBe("16px");
  expect(Math.abs(spacing.gap - 16)).toBeLessThan(1);
  expect(spacing.formMargin).toBe("16px");
});
