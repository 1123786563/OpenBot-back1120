import { type Browser, test } from "@e2e-dev/web";
import { expect, type TestFixtures } from "e2e";
import {
  type BotBrowserApiState,
  type BotBrowserState,
  botBrowserApiPaths,
} from "../../shared/bot-browser";
import type {
  ComputerControlState,
  HandoffRequest,
} from "../../shared/computer-control";
import {
  browserNarrationRequestSchema,
  browserNavigateRequestSchema,
  browserRecordingRequestSchema,
  browserTabsRequestSchema,
  type LauncherState,
} from "../../shared/openbot-browser";
import { observeLiveScreen } from "./browser-screen-stream";
import { configureChatStream } from "./chat-stream";
import { createConversation } from "./conversations";
import { createBot } from "./signed-in";
import {
  serveNarrationPreference,
  simulateBrowserSpeech,
} from "./teach-browser-speech";

const expenses = {
  id: "tab-1",
  url: "https://expenses.example/report",
  title: "Expense report",
  active: true,
};
const policy = {
  id: "tab-2",
  url: "https://docs.example/policy",
  title: "Travel policy",
  active: false,
};
const empty = {
  id: "tab-new",
  url: "about:blank",
  title: "about:blank",
  active: true,
};
const screenshot =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aB1sAAAAASUVORK5CYII=";
const recordingRestricted =
  "This OpenBot can't record in a Bot's browser, because its Bots share one computer.";
const needControl = "Take control of the Bot's browser first.";
const manualReason = "I want to take control of the browser.";
const title = "Submit the taxi receipt";

function handoff(source: "manual" | "model", reason: string): HandoffRequest {
  const now = new Date();
  return {
    id: `request-${source}`,
    reason,
    source,
    status: "waiting",
    createdAt: now.toISOString(),
    updatedAt: now.toISOString(),
    expiresAt: new Date(now.getTime() + 60_000).toISOString(),
  };
}

function heldBy(
  user: string | null,
  request?: HandoffRequest,
): ComputerControlState {
  return {
    holder: user ? "human" : "bot",
    since: new Date().toISOString(),
    requested: request?.status === "waiting",
    transitioning: false,
    resumeSnapshotRequired: false,
    recoveryRequired: false,
    ...(user ? { heldBy: user } : {}),
    ...(request ? { reason: request.reason, request } : {}),
  };
}

function write(path: string, body: unknown = null) {
  return { path, method: "POST", body };
}

type FixtureOptions = {
  owner?: "viewer" | "other";
  recordRefused?: string;
  tabs?: BotBrowserState["tabs"];
  actions?: number;
};

function idleRecorder(): LauncherState {
  return { connected: false, phase: "idle", actions: 0, narration: "external" };
}

async function serveBotComputer(
  browser: Browser,
  botId: string,
  {
    owner,
    recordRefused,
    tabs = [expenses, policy],
    actions = 7,
  }: FixtureOptions = {},
) {
  const me = await browser.evaluate(async () => {
    const response = await fetch("/api/me");
    if (!response.ok)
      throw new Error(`Could not read current user: ${response.status}`);
    const result: { user: { id: string } } = await response.json();
    return result.user.id;
  });
  const other = "other-person";
  const computer = `/api/computers/${encodeURIComponent(botId)}`;
  const paths = {
    state: botBrowserApiPaths.state(botId),
    tabs: botBrowserApiPaths.tabs(botId),
    navigate: botBrowserApiPaths.navigate(botId),
    clear: botBrowserApiPaths.clear(botId),
    recording: botBrowserApiPaths.recording(botId),
    narration: botBrowserApiPaths.narration(botId),
    request: `${computer}/control/request`,
    take: `${computer}/control/take`,
    release: `${computer}/control/release`,
  };
  const writes: ReturnType<typeof write>[] = [];
  let controlReads = 0;
  let browserReads = 0;
  let clearRefused = false;
  let phrases = 0;
  const refusedNarration: unknown[] = [];
  const manual = handoff("manual", manualReason);
  let control = owner
    ? heldBy(owner === "viewer" ? me : other, { ...manual, status: "taken" })
    : heldBy(null);
  let state: BotBrowserState = { open: true, tabs, recorder: idleRecorder() };

  function runRecording(user: string, title: string) {
    phrases = 0;
    state = {
      ...state,
      recordingBy: user,
      recorder: {
        ...idleRecorder(),
        connected: true,
        phase: "recording",
        recordingId: "fixture-recording",
        title,
        startedAt: Date.now() - 42_000,
        actions,
      },
    };
  }
  function endRecording() {
    const { recordingBy, recorder, ...rest } = state;
    if (!recordingBy || !recorder?.recordingId || !recorder.title) return;
    state = {
      ...rest,
      lastStoppedBy: recordingBy,
      recorder: {
        ...idleRecorder(),
        lastStopped: {
          title: recorder.title,
          recordingId: recorder.recordingId,
          stoppedAt: Date.now(),
          actions: recorder.actions,
          phrases,
        },
      },
    };
  }

  await browser.route(
    new RegExp(`${RegExp.escape(computer)}(?:/[^?#]*)?(?:\\?[^#]*)?$`),
    async (route) => {
      const request = route.request;
      const { pathname } = new URL(request.url);
      const mine = control.holder === "human" && control.heldBy === me;
      const answer = (): BotBrowserApiState => ({
        ...state,
        mine,
        recordingIsMine: state.recordingBy === me,
        ...(recordRefused ? { recordRefused } : {}),
      });
      if (request.method === "GET") {
        if (pathname === paths.state) {
          browserReads++;
          return route.fulfill({ json: answer() });
        }
        if (pathname === `${computer}/control`) {
          controlReads++;
          return route.fulfill({ json: control });
        }
        if (pathname === `${computer}/screenshot`) {
          return route.fulfill({
            json: {
              base64: screenshot,
              width: 1280,
              height: 800,
              capturedAt: new Date().toISOString(),
              url: expenses.url,
            },
          });
        }
        if (pathname === `${computer}/status`)
          return route.fulfill({ json: { botId, state: "ready" } });
        if (pathname === `${computer}/activity`)
          return route.fulfill({ json: { entries: [] } });
        return route.continue();
      }

      const invalid = () =>
        route.fulfill({ status: 400, json: { error: "Invalid request" } });
      const conflict = () =>
        route.fulfill({ status: 409, json: { error: needControl } });
      const body: unknown = request.postData
        ? JSON.parse(request.postData)
        : null;
      writes.push({ path: pathname, method: request.method, body });
      if (request.method !== "POST") return invalid();
      if (pathname === paths.request) {
        if (
          !body ||
          typeof body !== "object" ||
          !("source" in body) ||
          body.source !== "manual" ||
          !("reason" in body) ||
          typeof body.reason !== "string"
        )
          return invalid();
        control = heldBy(null, handoff("manual", body.reason));
        return route.fulfill({ json: control });
      }
      if (pathname === paths.take || pathname === paths.release) {
        const raised = control.request;
        if (
          !raised ||
          !body ||
          typeof body !== "object" ||
          !("requestId" in body) ||
          body.requestId !== raised.id
        )
          return invalid();
        if (pathname === paths.release && state.recordingBy === control.heldBy)
          endRecording();
        control =
          pathname === paths.take
            ? heldBy(me, { ...raised, status: "taken" })
            : heldBy(null, { ...raised, status: "completed" });
        return route.fulfill({ json: control });
      }
      if (pathname === paths.narration) {
        const parsed = browserNarrationRequestSchema.safeParse(body);
        if (!parsed.success) return invalid();
        if (!mine || state.recordingBy !== me) {
          refusedNarration.push(parsed.data);
          return route.fulfill({
            status: 409,
            json: { error: "No recording of yours is running." },
          });
        }
        if ("text" in parsed.data) phrases++;
        return route.fulfill({ json: { ok: true } });
      }
      if (!mine || (pathname === paths.clear && clearRefused))
        return conflict();
      if (pathname === paths.tabs) {
        const parsed = browserTabsRequestSchema.safeParse(body);
        if (!parsed.success) return invalid();
        const change = parsed.data;
        switch (change.action) {
          case "new":
            state = {
              ...state,
              tabs: [
                ...state.tabs.map((tab) => ({ ...tab, active: false })),
                empty,
              ],
            };
            break;
          case "activate":
            state = {
              ...state,
              tabs: state.tabs.map((tab) => ({
                ...tab,
                active: tab.id === change.tabId,
              })),
            };
            break;
          case "close": {
            const remaining = state.tabs.filter(
              ({ id }) => id !== change.tabId,
            );
            const active =
              remaining.find((tab) => tab.active)?.id ?? remaining.at(-1)?.id;
            state = {
              ...state,
              tabs: remaining.map((tab) => ({
                ...tab,
                active: tab.id === active,
              })),
            };
            break;
          }
        }
        return route.fulfill({ json: answer() });
      }
      if (pathname === paths.navigate) {
        if (!browserNavigateRequestSchema.safeParse(body).success)
          return invalid();
        return route.fulfill({ json: answer() });
      }
      if (pathname === paths.recording) {
        const parsed = browserRecordingRequestSchema.safeParse(body);
        if (!parsed.success) return invalid();
        if (parsed.data.action === "start") runRecording(me, parsed.data.title);
        else {
          if (state.recordingBy !== me) return conflict();
          endRecording();
        }
        return route.fulfill({ json: answer() });
      }
      if (pathname === paths.clear && body === null) {
        state = { open: true, tabs: [empty] };
        return route.fulfill({ json: answer() });
      }
      return invalid();
    },
  );

  return {
    paths,
    writes,
    reads: () => ({ control: controlReads, browser: browserReads }),
    setTabs(tabs: BotBrowserState["tabs"]) {
      state = { ...state, tabs };
    },
    setOwner(owner: "viewer" | "other") {
      control = heldBy(owner === "viewer" ? me : other, {
        ...manual,
        status: "taken",
      });
    },
    askForHelp(reason: string) {
      control = heldBy(null, handoff("model", reason));
    },
    refuseClear() {
      clearRefused = true;
    },
    runRecording(owner: "viewer" | "other", name: string) {
      runRecording(owner === "viewer" ? me : other, name);
    },
    endRecording,
    refusedNarration,
  };
}

type Fixtures = Parameters<typeof createBot>[0];

async function setupBotConversation(
  fixtures: Fixtures,
  options?: FixtureOptions,
  watch = true,
) {
  const bot = await createBot(fixtures);
  const channel = await createConversation(fixtures.browser, bot.id);
  await configureChatStream(fixtures.browser, []);
  const computer = await serveBotComputer(fixtures.browser, bot.id, options);
  const observation = await observeLiveScreen(fixtures.browser, bot.id);
  await fixtures.app.open(`/channel/${channel}${watch ? "?watch=true" : ""}`);
  return { ...computer, observation };
}

async function fullScreen(screen: TestFixtures["screen"]) {
  await screen
    .getByRole("button", "Open the Bot's screen full size", { exact: true })
    .click();
  const dialog = screen.getByRole("dialog", "The Bot's screen", {
    exact: true,
  });
  await expect(
    dialog.getByRole("tablist", "Tabs", { exact: true }),
  ).toBeVisible();
  return dialog;
}

test("the Bot's browser shows the active page as read-only and follows the Bot's next tab", async (fixtures) => {
  const { browser, screen } = fixtures;
  const { setTabs, writes } = await setupBotConversation(fixtures);
  const dialog = await fullScreen(screen);
  const address = dialog.getByRole("textbox", "Address", { exact: true });
  const travel = dialog.getByRole("tab", policy.title, { exact: true });
  await expect(
    dialog.getByRole("tab", expenses.title, { exact: true }),
  ).toHaveAttribute("aria-selected", "true");
  await expect(address).toHaveValue(expenses.url);
  await expect(address).toHaveAttribute("readonly", "");
  await expect(address).toBeEnabled();
  for (const button of ["Back", "Forward", "Reload", "New tab"])
    await expect(
      dialog.getByRole("button", button, { exact: true }),
    ).toBeDisabled();
  await expect(
    browser.locator('[title="Close Expense report"]'),
  ).toBeDisabled();
  await expect(travel).toBeDisabled();
  await dialog.getByRole("textbox", "Task name", { exact: true }).fill(title);
  await expect(
    dialog.getByRole("button", "Record", { exact: true }),
  ).toBeDisabled();
  await expect(
    dialog.getByText("Take control to record.", { exact: true }),
  ).toBeVisible();
  await expect(
    dialog.getByRole("switch", "Narration", { exact: true }),
  ).toHaveCount(0);
  await address.focus();
  await browser.keyboard.press("ArrowRight");
  await browser.keyboard.press("Enter");
  await browser.keyboard.press("Delete");
  await expect(travel).toBeVisible();
  expect(writes).toEqual([]);
  setTabs([
    {
      ...expenses,
      url: "https://expenses.example/receipts",
      title: "Receipts",
    },
  ]);
  await expect(address).toHaveValue("https://expenses.example/receipts");
  await expect(
    dialog.getByRole("tab", "Receipts", { exact: true }),
  ).toHaveAttribute("aria-selected", "true");
  expect(writes).toEqual([]);
});

test("a shared Bot computer disables recording while the owner can still navigate", async (fixtures) => {
  const { screen } = fixtures;
  const { paths, writes } = await setupBotConversation(fixtures, {
    owner: "viewer",
    recordRefused: recordingRestricted,
  });
  const dialog = await fullScreen(screen);
  const panel = dialog.getByRole("region", "Record a task", { exact: true });
  await expect(
    panel.getByText("Recording isn't available here", { exact: true }),
  ).toBeVisible();
  await expect(
    panel.getByText(recordingRestricted, { exact: true }),
  ).toBeVisible();
  await expect(
    panel.getByRole("button", "Record", { exact: true }),
  ).toHaveCount(0);
  await expect(
    panel.getByRole("textbox", "Task name", { exact: true }),
  ).toHaveCount(0);
  await expect(
    panel.getByRole("switch", "Narration", { exact: true }),
  ).toHaveCount(0);
  const address = dialog.getByRole("textbox", "Address", { exact: true });
  await expect.poll(() => address.getAttribute("readonly")).toBeNull();
  await dialog.getByRole("button", "Reload", { exact: true }).click();
  await expect
    .poll(() => writes)
    .toEqual([write(paths.navigate, { action: "reload" })]);
});

test("taking control enables the Bot browser and all actions target that Bot", async (fixtures) => {
  const { browser, screen } = fixtures;
  const { paths, writes } = await setupBotConversation(fixtures);
  const dialog = await fullScreen(screen);
  const address = dialog.getByRole("textbox", "Address", { exact: true });
  await expect(address).toHaveAttribute("readonly", "");
  await dialog.getByRole("button", "Take control", { exact: true }).click();
  await expect
    .poll(() => address.getAttribute("readonly"), { timeout: 900 })
    .toBeNull();
  await dialog.getByRole("tab", policy.title, { exact: true }).click();
  await expect(address).toHaveValue(policy.url);
  await dialog.getByRole("button", "New tab", { exact: true }).click();
  await expect(address).toHaveValue("");
  await expect(address).toBeFocused();
  await browser.locator('[title="Close Expense report"]').click();
  await expect(
    dialog.getByRole("tab", expenses.title, { exact: true }),
  ).toHaveCount(0);
  for (const action of ["back", "forward", "reload"] as const) {
    const name = action[0].toUpperCase() + action.slice(1);
    await dialog.getByRole("button", name, { exact: true }).click();
    await expect
      .poll(() => writes.at(-1))
      .toEqual(write(paths.navigate, { action }));
  }
  await address.fill("openbot.ai");
  await address.press("Enter");
  await expect
    .poll(() => writes)
    .toEqual([
      write(paths.request, { reason: manualReason, source: "manual" }),
      write(paths.take, { requestId: "request-manual" }),
      write(paths.tabs, { action: "activate", tabId: policy.id }),
      write(paths.tabs, { action: "new" }),
      write(paths.tabs, { action: "close", tabId: expenses.id }),
      write(paths.navigate, { action: "back" }),
      write(paths.navigate, { action: "forward" }),
      write(paths.navigate, { action: "reload" }),
      write(paths.navigate, { url: "https://openbot.ai" }),
    ]);
  await expect(dialog.getByRole("alert")).toHaveCount(0);
});

test("another person's control does not open the Computer for the viewer or allow them to drive", async (fixtures) => {
  const { screen, browser } = fixtures;
  const { reads, setOwner, writes } = await setupBotConversation(
    fixtures,
    { owner: "other" },
    false,
  );
  await expect.poll(() => reads().control).toBeGreaterThan(0);
  const open = screen.getByRole("button", "Open Computer", { exact: true });
  await expect(open).toHaveAttribute("aria-expanded", "false");
  await expect(
    screen.getByRole("img", "Needs you", { exact: true }),
  ).toHaveCount(0);
  await expect(browser).not.toHaveURL(/watch=true/);
  await open.click();
  const dialog = await fullScreen(screen);
  await expect(
    dialog.getByText("Someone else has control.", { exact: true }),
  ).toHaveCount(2);
  await expect(dialog.getByText(/You have control/)).toHaveCount(0);
  await expect(
    dialog.getByRole("button", "Hand back", { exact: true }),
  ).toHaveCount(0);
  await expect(
    dialog.getByRole("button", "Take control", { exact: true }),
  ).toBeDisabled();
  await expect(
    dialog.getByRole("button", "Record", { exact: true }),
  ).toBeDisabled();
  await expect(
    dialog.getByText("Take control to record.", { exact: true }),
  ).toHaveCount(0);
  await expect(dialog.getByLabel(/Click and type here/)).toHaveCount(0);
  setOwner("viewer");
  await expect(
    dialog.getByRole("button", "Hand back", { exact: true }),
  ).toBeEnabled();
  await expect(
    dialog.getByText("Someone else has control.", { exact: true }),
  ).toHaveCount(0);
  expect(writes).toEqual([]);
});

test("the Bot's help reason survives take and hand back without echoing a manual reason", async (fixtures) => {
  const { screen } = fixtures;
  const { askForHelp, paths, writes } = await setupBotConversation(fixtures);
  const dialog = await fullScreen(screen);
  const take = dialog.getByRole("button", "Take control", { exact: true });
  const back = dialog.getByRole("button", "Hand back", { exact: true });
  const manual = "You have control. Click and type on the page.";
  await take.click();
  await expect(dialog.getByText(manual, { exact: true })).toBeVisible();
  await expect(dialog.getByText(manualReason, { exact: true })).toHaveCount(0);
  await back.click();
  await expect(take).toBeEnabled();
  const reason = "Open the receipts page, then hand back.";
  askForHelp(reason);
  await expect(
    dialog.getByText("The Bot needs you.", { exact: true }),
  ).toBeVisible();
  await take.click();
  await expect(
    dialog.getByText(`${manual} ${reason}`, { exact: true }),
  ).toBeVisible();
  expect(writes).toEqual([
    write(paths.request, { reason: manualReason, source: "manual" }),
    write(paths.take, { requestId: "request-manual" }),
    write(paths.release, { requestId: "request-manual" }),
    write(paths.take, { requestId: "request-model" }),
  ]);
});

for (const refused of [false, true]) {
  test(`the Bot browser ${refused ? "keeps its tabs when Clear is refused" : "clears only after the person holding control confirms"}`, async (fixtures) => {
    const { browser, screen } = fixtures;
    const { paths, writes, refuseClear } = await setupBotConversation(fixtures);
    const dialog = await fullScreen(screen);
    const clear = dialog.getByRole("button", "Clear browser data", {
      exact: true,
    });
    const confirm = screen.getByRole("dialog", "Clear this browser?", {
      exact: true,
    });
    const address = dialog.getByRole("textbox", "Address", { exact: true });
    await expect(clear).toBeDisabled();
    await dialog.getByRole("button", "Take control", { exact: true }).click();
    await expect(clear).toBeEnabled();
    const cancel = confirm.getByRole("button", "Cancel", { exact: true });
    const accept = confirm.getByRole("button", "Clear", { exact: true });
    await clear.click();
    await expect(
      confirm.getByText(
        "Cookies, saved passwords and history are wiped. You'll have to sign in everywhere again.",
        { exact: true },
      ),
    ).toBeVisible();
    await expect(
      confirm.getByRole("button", "Close", { exact: true }),
    ).toBeVisible();
    await cancel.click();
    await expect(confirm).toHaveCount(0);
    await expect(dialog.getByRole("tab")).toHaveCount(2);
    expect(writes.filter(({ path }) => path === paths.clear)).toEqual([]);
    await clear.click();
    if (refused) refuseClear();
    await accept.click();
    if (refused) {
      const alert = confirm.getByRole("alert");
      await expect(alert).toContainText(
        "This item changed. Refresh and try again.",
      );
      await alert.getByRole("button", "Details", { exact: true }).click();
      await expect(alert.getByText(needControl, { exact: true })).toBeVisible();
      await cancel.click();
      await expect(confirm).toHaveCount(0);
      await expect(dialog.getByRole("tab")).toHaveCount(2);
      await expect(address).toHaveValue(expenses.url);
    } else {
      await expect(confirm).toHaveCount(0);
      await expect(dialog.getByRole("tab")).toHaveCount(1);
      await expect(
        dialog.getByRole("tab", "New tab", { exact: true }),
      ).toHaveAttribute("aria-selected", "true");
      await expect(address).toHaveValue("");
      await expect.poll(() => address.getAttribute("readonly")).toBeNull();
      const toast = browser
        .locator('[data-slot="toast"]')
        .filter({ hasText: "Browser cleared" });
      await expect(toast).toBeVisible();
      const toastAboveDialog = await browser.evaluate(() => {
        const full = document.querySelector(
          '[role="dialog"][aria-label="The Bot\'s screen"]',
        );
        const viewport = document.querySelector('[data-slot="toast-viewport"]');
        if (!full || !viewport) return false;
        return (
          Number(getComputedStyle(viewport).zIndex) >
          Number(getComputedStyle(full).zIndex)
        );
      });
      expect(toastAboveDialog).toBe(true);
    }
    expect(writes.filter(({ path }) => path === paths.clear)).toEqual([
      write(paths.clear),
    ]);
  });
}

const mail = {
  id: "tab-3",
  url: "https://mail.example/",
  title: "Mail",
  active: false,
};
const drivingLabel = "The Bot's screen. You have control. Click and type here.";

for (const closeActive of [false, true]) {
  test(`the Bot's tabs ${closeActive ? "focus the next active tab after Delete" : "keep one Tab stop and switch only on Enter"}`, async (fixtures) => {
    const { browser, screen } = fixtures;
    const { paths, writes } = await setupBotConversation(fixtures, {
      owner: "viewer",
      tabs: [expenses, policy, mail],
    });
    const dialog = await fullScreen(screen);
    const tabs = dialog.getByRole("tablist", "Tabs", { exact: true });
    const first = tabs.getByRole("tab", expenses.title, { exact: true });
    const docs = tabs.getByRole("tab", policy.title, { exact: true });
    const newest = tabs.getByRole("tab", mail.title, { exact: true });
    await expect(first).toBeEnabled();
    const canvas = dialog.getByLabel(drivingLabel, { exact: true });
    await expect(canvas).toHaveAttribute("data-connected", "true");
    await expect(canvas).toBeFocused();
    await first.focus();
    if (closeActive) {
      await browser.keyboard.press("Delete");
      await expect(first).toHaveCount(0);
      await expect(newest).toBeFocused();
      await expect(newest).toHaveAttribute("aria-selected", "true");
      await expect(newest).toHaveAttribute("tabindex", "0");
      await docs.focus();
      await browser.keyboard.press("Delete");
      await expect(docs).toHaveCount(0);
      await expect(newest).toBeFocused();
      await expect(tabs.getByRole("tab")).toHaveCount(1);
      expect(writes).toEqual([
        write(paths.tabs, { action: "close", tabId: expenses.id }),
        write(paths.tabs, { action: "close", tabId: policy.id }),
      ]);
      return;
    }

    const panel = dialog.getByRole("tabpanel", expenses.title, { exact: true });
    const panelId = await panel.getAttribute("id");
    if (!panelId) throw new Error("The active Bot tab needs a panel ID");
    await expect(first).toHaveAttribute("aria-controls", panelId);
    await expect(
      panel.getByRole("textbox", "Address", { exact: true }),
    ).toHaveValue(expenses.url);
    await expect(panel.getByLabel(drivingLabel, { exact: true })).toBeVisible();
    await expect(first).toHaveAttribute("tabindex", "0");
    await expect(docs).toHaveAttribute("tabindex", "-1");
    await expect(newest).toHaveAttribute("tabindex", "-1");
    for (const [key, focused] of [
      ["ArrowRight", docs],
      ["End", newest],
      ["ArrowRight", first],
      ["Home", first],
      ["ArrowLeft", newest],
      ["Home", first],
      ["ArrowRight", docs],
    ] as const) {
      await browser.keyboard.press(key);
      await expect(focused).toBeFocused();
    }
    await expect(first).toHaveAttribute("aria-selected", "true");
    expect(writes).toEqual([]);
    await browser.keyboard.press("Enter");
    await expect(docs).toHaveAttribute("aria-selected", "true");
    await browser.keyboard.press("Delete");
    await expect(docs).toHaveCount(0);
    await expect(newest).toBeFocused();
    await expect(newest).toHaveAttribute("aria-selected", "true");
    expect(writes).toEqual([
      write(paths.tabs, { action: "activate", tabId: policy.id }),
      write(paths.tabs, { action: "close", tabId: policy.id }),
    ]);
  });
}

test("the Bot's connected canvas and form controls receive their own keyboard input", async (fixtures) => {
  const { browser, screen } = fixtures;
  const { paths, writes, observation } = await setupBotConversation(fixtures, {
    owner: "viewer",
  });
  const dialog = await fullScreen(screen);
  const canvas = dialog.getByLabel(drivingLabel, { exact: true });
  await expect(canvas).toHaveAttribute("data-connected", "true");
  await expect(canvas).toBeFocused();
  await browser.keyboard.press("a");
  const keysForwarded = [
    ["down", "a"],
    ["up", "a"],
  ];
  const stream = paths.state.replace(/\/browser$/, "/stream");
  const expected = {
    requests: expect.arrayContaining([stream]),
    keys: keysForwarded,
  };
  expect(await observation()).toEqual(expected);

  const first = dialog.getByRole("tab", expenses.title, { exact: true });
  const docs = dialog.getByRole("tab", policy.title, { exact: true });
  await first.focus();
  await browser.keyboard.press("ArrowRight");
  await expect(docs).toBeFocused();
  await browser.keyboard.press("Enter");
  await expect(docs).toHaveAttribute("aria-selected", "true");
  const address = dialog.getByRole("textbox", "Address", { exact: true });
  await address.fill("openbot.ai");
  await address.press("Enter");
  await expect(canvas).toBeFocused();
  const task = dialog.getByRole("textbox", "Task name", { exact: true });
  await task.click();
  await browser.keyboard.type("Pay");
  await expect(task).toHaveValue("Pay");
  expect(await observation()).toEqual(expected);
  const pasteAllowed = await browser.evaluate(() => {
    const field = document.activeElement;
    if (!(field instanceof HTMLInputElement))
      throw new Error("The task name does not have focus");
    const clipboardData = new DataTransfer();
    clipboardData.setData("text/plain", " invoice");
    return field.dispatchEvent(
      new ClipboardEvent("paste", {
        clipboardData,
        bubbles: true,
        cancelable: true,
      }),
    );
  });
  expect(pasteAllowed).toBe(true);
  await browser.evaluate(() => {
    if (document.activeElement instanceof HTMLElement)
      document.activeElement.blur();
    return null;
  });
  await browser.keyboard.press("b");
  const reload = dialog.getByRole("button", "Reload", { exact: true });
  await reload.focus();
  await expect(reload).toBeFocused();
  await browser.keyboard.press("Enter");
  expect(await observation()).toEqual(expected);
  await expect
    .poll(() => writes)
    .toEqual([
      write(paths.tabs, { action: "activate", tabId: policy.id }),
      write(paths.navigate, { url: "https://openbot.ai" }),
      write(paths.navigate, { action: "reload" }),
    ]);

  await task.focus();
  await canvas.click();
  await expect(canvas).toBeFocused();
  await browser.keyboard.press("c");
  const forwarded = await browser.evaluate(() =>
    JSON.stringify(Reflect.get(window, "screenKeyboardMessages")),
  );
  expect(JSON.parse(forwarded)).toEqual([
    expect.objectContaining({
      type: "key",
      event: "down",
      key: "a",
      code: "KeyA",
      text: "a",
      modifiers: 0,
    }),
    expect.objectContaining({
      type: "key",
      event: "up",
      key: "a",
      code: "KeyA",
      modifiers: 0,
    }),
    expect.objectContaining({
      type: "key",
      event: "down",
      key: "c",
      code: "KeyC",
      text: "c",
      modifiers: 0,
    }),
    expect.objectContaining({
      type: "key",
      event: "up",
      key: "c",
      code: "KeyC",
      modifiers: 0,
    }),
  ]);
});

for (const handBack of [false, true]) {
  test(`a Bot browser recording is saved when the owner ${handBack ? "hands control back" : "presses Stop"}`, async (fixtures) => {
    const { browser, screen } = fixtures;
    await simulateBrowserSpeech(browser, { speech: "unsupported" });
    await serveNarrationPreference(browser, "off");
    const { paths, writes, observation } = await setupBotConversation(
      fixtures,
      {
        owner: "viewer",
        actions: handBack ? 3 : 7,
      },
    );
    const dialog = await fullScreen(screen);
    const record = dialog.getByRole("button", "Record", { exact: true });
    const name = dialog.getByRole("textbox", "Task name", { exact: true });
    await expect(record).toBeDisabled();
    await name.click();
    await browser.keyboard.type(title);
    await expect(name).toHaveValue(title);
    await record.click();
    const timer = browser.locator('[role="timer"]');
    await expect(timer).toHaveText(
      handBack ? /^0:4\d · 3 actions$/ : /^0:4\d · 7 actions$/,
    );
    await expect(dialog.getByText(title, { exact: true })).toBeVisible();
    const language = await browser.evaluate(() => navigator.language);
    const started = write(paths.recording, {
      action: "start",
      title,
      language,
    });
    expect(writes).toEqual([started]);
    expect((await observation()).keys).toEqual([]);
    const stop = dialog.getByRole("button", "Stop", { exact: true });
    await (handBack
      ? dialog.getByRole("button", "Hand back", { exact: true })
      : stop
    ).click();
    const status = dialog.getByRole("status").filter({ hasText: title });
    await expect(status).toHaveText(
      handBack
        ? `${title} The recording ended when control went back to the Bot. Saved to your Learning space: 3 actions.`
        : `${title} Saved to your Learning space: 7 actions.`,
    );
    await expect(stop).toHaveCount(0);
    await expect(name).toBeVisible();
    await expect(dialog.getByRole("alert")).toHaveCount(0);
    if (handBack)
      await expect(
        dialog.getByText("Take control to record.", { exact: true }),
      ).toBeVisible();
    expect(writes).toEqual([
      started,
      handBack
        ? write(paths.release, { requestId: "request-manual" })
        : write(paths.recording, { action: "stop" }),
    ]);
  });
}

test("another person's Bot recording hides their title, timer and saved result", async (fixtures) => {
  const { browser, screen } = fixtures;
  const { endRecording, runRecording, writes } = await setupBotConversation(
    fixtures,
    { owner: "other" },
  );
  const privateTitle = "Pay the vendor";
  runRecording("other", privateTitle);
  const dialog = await fullScreen(screen);
  const running = dialog.getByText("Someone is recording", { exact: true });
  await expect(running).toBeVisible();
  await expect(
    dialog.getByText("You can record once they stop.", { exact: true }),
  ).toBeVisible();
  await expect(dialog.getByText(privateTitle, { exact: true })).toHaveCount(0);
  await expect(dialog.getByRole("button", "Stop", { exact: true })).toHaveCount(
    0,
  );
  await expect(browser.locator('[role="timer"]')).toHaveCount(0);
  endRecording();
  await expect(
    dialog.getByRole("textbox", "Task name", { exact: true }),
  ).toBeVisible();
  await expect(running).toHaveCount(0);
  await expect(dialog.getByText(privateTitle, { exact: true })).toHaveCount(0);
  await expect(dialog.getByText(/Saved to your Learning space/)).toHaveCount(0);
  expect(writes).toEqual([]);
});

for (const owner of ["viewer", "other"] as const) {
  test(`after reload the Bot browser shows the saved recording result only to its ${owner === "viewer" ? "owner" : "owner, never the viewer"}`, async (fixtures) => {
    const { browser, screen } = fixtures;
    const { reads, runRecording, endRecording, writes } =
      await setupBotConversation(fixtures, { actions: 4 });
    await fullScreen(screen);
    const before = reads().browser;
    runRecording(owner, title);
    endRecording();
    await browser.reload();
    const dialog = await fullScreen(screen);
    await expect.poll(() => reads().browser).toBeGreaterThan(before);
    await expect(
      dialog.getByRole("button", "Record", { exact: true }),
    ).toBeVisible();
    const status = dialog.getByRole("status").filter({ hasText: title });
    if (owner === "viewer") {
      await expect(status).toHaveText(
        `${title} Saved to your Learning space: 4 actions.`,
      );
    } else {
      const afterReload = reads().browser;
      await expect.poll(() => reads().browser).toBeGreaterThan(afterReload);
      await expect(status).toHaveCount(0);
      await expect(dialog.getByText(title, { exact: true })).toHaveCount(0);
      await expect(
        dialog.getByText(/Saved to your Learning space/),
      ).toHaveCount(0);
    }
    expect(writes).toEqual([]);
  });
}

test("the Bot's screen offers Record and makes no request for the retired demonstrations panel", async (fixtures) => {
  const { browser, screen } = fixtures;
  const demonstrationRequests: string[] = [];
  await browser.route(/\/api\/demonstrations(?:[/?]|$)/, (route) => {
    demonstrationRequests.push(route.request.url);
    return route.fulfill({ status: 404, json: { error: "Unavailable" } });
  });
  await setupBotConversation(fixtures, { owner: "viewer" });
  const dialog = await fullScreen(screen);
  await expect(
    dialog.getByRole("button", "Record", { exact: true }),
  ).toBeVisible();
  await expect(
    dialog.getByText(/Teach a browser workflow|Record your steps/),
  ).toHaveCount(0);
  expect(demonstrationRequests).toEqual([]);
});

const capturing = "Narration is on. We're capturing your voice.";
const phrase = {
  interim: "I am opening",
  final: "I am opening the expenses page",
};

for (const handBack of [false, true]) {
  test(`the Bot browser ${handBack ? "clears refused narration when control is taken again" : "receives the final narrated phrase before Stop"}`, async (fixtures) => {
    const { browser, screen } = fixtures;
    await simulateBrowserSpeech(browser, { phrase });
    await serveNarrationPreference(browser, "on");
    const ownBrowser: string[] = [];
    await browser.route(/\/api\/browser\/(?:narration|recording)$/, (route) => {
      ownBrowser.push(route.request.url);
      return route.fulfill({ status: 409, json: { error: "Wrong browser" } });
    });
    const { paths, writes, refusedNarration } = await setupBotConversation(
      fixtures,
      { owner: "viewer" },
    );
    const dialog = await fullScreen(screen);
    await expect(
      dialog.getByRole("switch", "Narration", { exact: true }),
    ).toHaveAttribute("aria-checked", "true");
    await dialog.getByRole("textbox", "Task name", { exact: true }).fill(title);
    await dialog.getByRole("button", "Record", { exact: true }).click();
    await expect(dialog.getByText(capturing, { exact: true })).toBeVisible();
    await expect
      .poll(() => writes.filter(({ path }) => path === paths.narration).length)
      .toBe(1);
    if (handBack) {
      await dialog.getByRole("button", "Hand back", { exact: true }).click();
      await expect(
        dialog.getByText(/The recording ended when control went back/),
      ).toBeVisible();
      await expect
        .poll(() => refusedNarration)
        .toEqual(
          expect.arrayContaining([
            expect.objectContaining({ text: phrase.final }),
          ]),
        );
      await dialog.getByRole("button", "Take control", { exact: true }).click();
      await expect(
        dialog.getByRole("switch", "Narration", { exact: true }),
      ).toBeVisible();
      await expect(dialog.getByText(/didn't reach the Recorder/)).toHaveCount(
        0,
      );
      await expect(dialog.getByRole("alert")).toHaveCount(0);
      expect(
        writes.filter(({ path }) => path === paths.recording),
      ).toHaveLength(1);
    } else {
      await dialog.getByRole("button", "Stop", { exact: true }).click();
      await expect(
        dialog.getByText(
          "Saved to your Learning space: 7 actions and 1 narrated phrase.",
          { exact: true },
        ),
      ).toBeVisible();
      const narration = writes
        .filter(({ path }) => path === paths.narration)
        .map(({ body }) => browserNarrationRequestSchema.parse(body));
      expect(narration).toEqual([
        {
          speaking: true,
          since: expect.any(Number),
          sentAt: expect.any(Number),
        },
        {
          text: phrase.final,
          startedAt: expect.any(Number),
          endedAt: expect.any(Number),
          sentAt: expect.any(Number),
        },
        { speaking: false, sentAt: expect.any(Number) },
      ]);
      expect(writes.map(({ path }) => path)).toEqual([
        paths.recording,
        paths.narration,
        paths.narration,
        paths.narration,
        paths.recording,
      ]);
      expect(writes.at(-1)).toEqual(write(paths.recording, { action: "stop" }));
      expect(refusedNarration).toEqual([]);
    }
    expect(ownBrowser).toEqual([]);
  });
}

test("the Bot browser remembers the account's narration choice after reopening and reloading", async (fixtures) => {
  const { browser, screen } = fixtures;
  const speech = await simulateBrowserSpeech(browser);
  const { changes, reads } = await serveNarrationPreference(browser, "on");
  const { paths, writes } = await setupBotConversation(fixtures, {
    owner: "viewer",
  });
  const dialog = await fullScreen(screen);
  const toggle = dialog.getByRole("switch", "Narration", { exact: true });
  await expect(toggle).toHaveAttribute("aria-checked", "true");
  await toggle.click();
  await expect(toggle).toHaveAttribute("aria-checked", "false");
  await expect.poll(() => changes).toEqual([{ narration: "off" }]);
  await dialog
    .getByRole("button", "Close the Bot's screen", { exact: true })
    .click();
  await expect(dialog).toHaveCount(0);
  await fullScreen(screen);
  await expect(toggle).toHaveAttribute("aria-checked", "false");
  const before = reads();
  await browser.reload();
  await fullScreen(screen);
  await expect.poll(reads).toBeGreaterThan(before);
  await expect(toggle).toHaveAttribute("aria-checked", "false");
  await dialog.getByRole("textbox", "Task name", { exact: true }).fill(title);
  await dialog.getByRole("button", "Record", { exact: true }).click();
  await expect(
    dialog.getByRole("button", "Stop", { exact: true }),
  ).toBeVisible();
  await expect(
    screen.getByRole("dialog", "Narrate while you record?", { exact: true }),
  ).toHaveCount(0);
  expect(await speech.recognitions()).toEqual([]);
  const language = await browser.evaluate(() => navigator.language);
  expect(writes).toEqual([
    write(paths.recording, { action: "start", title, language }),
  ]);
});

test("Escape closes only the Bot's first narration question and accepting starts local recognition", async (fixtures) => {
  const { browser, screen } = fixtures;
  const speech = await simulateBrowserSpeech(browser);
  const { changes } = await serveNarrationPreference(browser, null);
  const { paths, writes } = await setupBotConversation(fixtures, {
    owner: "viewer",
  });
  const dialog = await fullScreen(screen);
  const toggle = dialog.getByRole("switch", "Narration", { exact: true });
  await expect(
    dialog.getByText("Narration is off.", { exact: true }),
  ).toBeVisible();
  await expect(toggle).toHaveAttribute("aria-checked", "false");
  const record = dialog.getByRole("button", "Record", { exact: true });
  const question = screen.getByRole("dialog", "Narrate while you record?", {
    exact: true,
  });
  await dialog.getByRole("textbox", "Task name", { exact: true }).fill(title);
  await record.click();
  await expect(question).toBeVisible();
  await browser.keyboard.press("Escape");
  await expect(question).toHaveCount(0);
  await expect(dialog).toBeVisible();
  expect(changes).toEqual([]);
  expect(writes).toEqual([]);
  expect(await speech.recognitions()).toEqual([]);
  await record.click();
  await question
    .getByRole("button", "Record with narration", { exact: true })
    .click();
  await expect(question).toHaveCount(0);
  await expect(dialog.getByText(capturing, { exact: true })).toBeVisible();
  expect(changes).toEqual([{ narration: "on" }]);
  const language = await browser.evaluate(() => navigator.language);
  expect(await speech.recognitions()).toEqual([
    { language, local: true, error: "" },
  ]);
  expect(writes).toEqual([
    write(paths.recording, { action: "start", title, language }),
  ]);
});

for (const owner of [undefined, "viewer"] as const) {
  test(`closing the full-size Bot screen returns to the Computer panel ${owner ? "without giving up control" : "while watching"}`, async (fixtures) => {
    const { browser, screen } = fixtures;
    const { writes } = await setupBotConversation(fixtures, { owner });
    const dialog = await fullScreen(screen);
    const close = dialog.getByRole("button", "Close the Bot's screen", {
      exact: true,
    });
    await expect(
      browser.locator('button[aria-label="Close the Bot\'s screen"] svg'),
    ).toBeVisible();
    await close.click();
    await expect(dialog).toHaveCount(0);
    await expect(
      screen.getByRole("region", "Computer sidebar", { exact: true }),
    ).toBeVisible();
    await expect(
      screen.getByRole("button", "Open the Bot's screen full size", {
        exact: true,
      }),
    ).toBeVisible();
    if (owner) {
      await expect(
        screen.getByText(/The Bot waits until you hand it back\./),
      ).toBeVisible();
      await expect(
        screen.getByRole("button", "Hand back", { exact: true }),
      ).toBeEnabled();
    }
    expect(writes).toEqual([]);
  });
}

for (const watched of [false, true]) {
  test(`direct Bot chat ${watched ? "restores its Computer on reload" : "preserves its draft while toggling the Computer"}`, async (fixtures) => {
    const { app, browser, screen } = fixtures;
    const bot = await createBot(fixtures);
    await serveBotComputer(browser, bot.id);
    await observeLiveScreen(browser, bot.id);
    await configureChatStream(browser, "");
    await browser.setViewport({ width: 1400, height: 900 });
    await app.open(`/bot?agent=${bot.id}${watched ? "&watch=true" : ""}`);
    await expect(
      screen.getByRole("heading", bot.name, { exact: true }),
    ).toBeVisible();
    const panel = screen.getByRole("region", "Computer sidebar", {
      exact: true,
    });
    const take = screen.getByRole("button", "Take control", { exact: true });
    const show = screen.getByRole("button", "Open Computer", { exact: true });
    if (!watched) {
      await expect(take).toHaveCount(0);
      const draft = screen.getByRole("textbox", "Type a message...", {
        exact: true,
      });
      await draft.fill("Keep the direct conversation");
      await show.click();
    }
    await expect(panel).toBeVisible();
    await expect(
      panel.getByRole("button", "Take control", { exact: true }),
    ).toBeEnabled();
    await expect(
      panel.getByRole("button", "Open the Bot's screen full size", {
        exact: true,
      }),
    ).toBeVisible();
    await expect(
      panel.getByRole("heading", "Activity", { exact: true }),
    ).toBeVisible();
    if (watched) {
      await browser.reload();
      await expect(panel).toBeVisible();
      await expect(take).toBeEnabled();
      await expect(
        screen.getByRole("heading", bot.name, { exact: true }),
      ).toBeVisible();
    } else {
      await screen
        .getByRole("button", "Close Computer", { exact: true })
        .click();
      await expect(panel).toHaveCount(0);
      const draft = screen.getByRole("textbox", "Type a message...", {
        exact: true,
      });
      await expect(draft).toHaveValue("Keep the direct conversation");
      await expect(show).toBeEnabled();
      await screen.getByRole("button", "New chat", { exact: true }).click();
      await expect(draft).toHaveValue("");
      await expect(
        screen.getByRole("heading", bot.name, { exact: true }),
      ).toBeVisible();
    }
  });
}
