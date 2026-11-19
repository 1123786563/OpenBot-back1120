import { type Browser, test } from "@e2e-dev/web";
import { expect, type TestFixtures } from "e2e";
import type { ListedRecorderConnection } from "../../shared/recorder-api";
import {
  RECORDER_COLLECTS,
  recorderDisclosureFor,
} from "../../shared/recorder-disclosure";

const path = "/settings/browsers";
const extensionId = "a".repeat(32);
const thisCopy = "c".repeat(32);
const otherCopy = "d".repeat(32);
const connectPath = "/api/recorder/connect-codes";
const connectionsPath = "/api/recorder/connections";
const code = "obc_fixture";
const chrome = "Chrome on Mac";
const edge = "Edge on Windows";
const own = "OpenBot browser";
const waiting = "Confirm in the OpenBot Recorder tab that opened.";
type Bridge = {
  ping: Record<string, boolean | string | number>;
  connect?: Record<string, boolean | string | number>;
  wait?: "waiting" | "closed" | "cancelled";
};
type BridgeMessage = { id: string; message: { type: string; code?: string } };
const found: Bridge = {
  ping: { ok: true },
  connect: { ok: true, awaitingConfirmation: true },
};

function connection(
  overrides: Partial<ListedRecorderConnection> = {},
): ListedRecorderConnection {
  return {
    id: "conn-1",
    label: chrome,
    via: "web",
    extensionId,
    installId: thisCopy,
    createdAt: "2026-11-05T09:02:00.000Z",
    lastUsedAt: null,
    recording: false,
    ...overrides,
  };
}

async function openRecorders(
  {
    app,
    browser,
    screen,
  }: Pick<TestFixtures, "app" | "screen"> & { browser: Browser },
  {
    page = path,
    connections = [],
    bridge,
    connectCreates,
    failRead = false,
    refuseDelete,
    holdDelete,
  }: {
    page?: string;
    connections?: ListedRecorderConnection[];
    bridge?: Bridge;
    connectCreates?: ListedRecorderConnection;
    failRead?: boolean;
    refuseDelete?: string;
    holdDelete?: Promise<void>;
  } = {},
) {
  const writes: { path: string; method: string; body: unknown }[] = [];
  let reads = 0;
  await browser.addInitScript(
    ({ id, initial }) => {
      if (window.top !== window) return;
      const state = { bridge: initial, messages: [] as BridgeMessage[] };
      Object.assign(window, { recorderBrowserTest: state });
      const runtime: {
        lastError?: { message: string };
        sendMessage?: unknown;
      } = {};
      runtime.sendMessage = (
        extension: string,
        message: BridgeMessage["message"],
        reply: (value?: unknown) => void,
      ) => {
        state.messages.push({ id: extension, message });
        const bridge = state.bridge;
        if (extension !== id || !bridge) {
          runtime.lastError = { message: "Could not establish connection." };
          reply();
          delete runtime.lastError;
          return;
        }
        reply(
          message.type === "openbot.ping"
            ? bridge.ping
            : message.type === "openbot.connect.status"
              ? { ok: true, connect: bridge.wait ?? "waiting" }
              : bridge.connect,
        );
      };
      Object.assign(window, { chrome: { runtime } });
    },
    { id: extensionId, initial: bridge ?? null },
  );
  await browser.route(/\/api\/recorder\/connections$/, (route) => {
    reads++;
    return failRead
      ? route.fulfill({ status: 500, body: "" })
      : route.fulfill({ json: { connections, extensionIds: [extensionId] } });
  });
  await browser.route(/\/api\/recorder\/connect-codes$/, (route) => {
    writes.push({
      method: route.request.method,
      path: connectPath,
      body: JSON.parse(route.request.postData ?? "null"),
    });
    if (connectCreates) connections = [...connections, connectCreates];
    return route.fulfill({
      status: 201,
      json: { code, expiresAt: "2026-11-30T10:00:00.000Z" },
    });
  });
  await browser.route(
    /\/api\/recorder\/connections\/[^/?]+$/,
    async (route) => {
      const requestPath = new URL(route.request.url).pathname;
      const id = requestPath.slice(connectionsPath.length + 1);
      writes.push({
        method: route.request.method,
        path: requestPath,
        body: route.request.postData,
      });
      await holdDelete;
      if (refuseDelete)
        return route.fulfill({ status: 409, json: { error: refuseDelete } });
      connections = connections.filter((connection) => connection.id !== id);
      return route.fulfill({ status: 204 });
    },
  );
  await app.open(page);
  const section = (title: string) =>
    browser.locator("main section").filter({
      has: screen.getByRole("heading", title, { exact: true }),
    });
  const local = section("This browser");
  return {
    local,
    list: section("Connected browsers"),
    disclosure: section("What the Recorder collects"),
    connect: local.getByRole("button", "Connect this browser", { exact: true }),
    writes,
    reads: () => reads,
    setConnections(next: ListedRecorderConnection[]) {
      connections = next;
    },
    async setBridge(next: Bridge) {
      await browser.evaluate((value) => {
        const state = (
          window as Window & { recorderBrowserTest?: { bridge: Bridge } }
        ).recorderBrowserTest;
        if (!state) throw new Error("The Recorder fixture was not installed");
        state.bridge = value;
        return null;
      }, next);
    },
    messages: () =>
      browser.evaluate(
        () =>
          (
            window as Window & {
              recorderBrowserTest?: { messages: BridgeMessage[] };
            }
          ).recorderBrowserTest?.messages ?? [],
      ),
  };
}

function disconnectWrite(id: string) {
  return {
    method: "DELETE",
    path: `${connectionsPath}/${id}`,
    body: undefined,
  };
}

test("Recorder disclosure describes what is collected before Connect", async (fixtures) => {
  const { browser } = fixtures;
  const personal = process.env.OPENBOT_E2E_SUITE === "personal";
  const expected = recorderDisclosureFor(personal ? "personal" : "team");
  const { disclosure, connect, writes } = await openRecorders(fixtures, {
    bridge: found,
  });
  await expect(connect).toBeVisible();
  await expect(disclosure.getByText(expected, { exact: true })).toBeVisible();
  for (const { title, description } of RECORDER_COLLECTS) {
    await expect(disclosure.getByText(title, { exact: true })).toBeVisible();
    await expect(
      disclosure.getByText(description, { exact: true }),
    ).toBeVisible();
  }
  if (personal) await expect(disclosure).not.toContainText(/organi[sz]ation/i);
  const before = await browser.evaluate(
    (texts) => {
      const connect = Array.from(document.querySelectorAll("button")).find(
        (button) => button.textContent === "Connect this browser",
      );
      if (!connect) return false;
      const elements = Array.from(document.querySelectorAll("main p"));
      return texts.every((text) => {
        const paragraph = elements.find((node) => node.textContent === text);
        return Boolean(
          paragraph &&
            paragraph.compareDocumentPosition(connect) &
              Node.DOCUMENT_POSITION_FOLLOWING,
        );
      });
    },
    [expected, ...RECORDER_COLLECTS.map(({ description }) => description)],
  );
  expect(before).toBe(true);
  expect(writes).toEqual([]);
});

test("a connections read failure shows an error on both sections", async (fixtures) => {
  const { local, list, writes } = await openRecorders(fixtures, {
    failRead: true,
  });
  await expect(local.getByRole("alert")).toHaveText(
    "Couldn't check whether this browser is connected. Reload the page.",
  );
  await expect(list.getByRole("alert")).toHaveText(
    "Couldn't load your connected browsers. Reload the page.",
  );
  await expect(local.getByRole("button")).toHaveCount(0);
  await expect(
    list.getByText("No browsers connected yet.", { exact: true }),
  ).toHaveCount(0);
  expect(writes).toEqual([]);
});

test("connected copies with the same label have separate timestamps and mark this browser", async (fixtures) => {
  const label = "Google Chrome on macOS";
  const { local, list } = await openRecorders(fixtures, {
    bridge: { ping: { ok: true, installId: thisCopy } },
    connections: [
      connection({
        label,
        installId: otherCopy,
        lastUsedAt: "2026-11-05T10:00:00.000Z",
      }),
      connection({
        label,
        id: "conn-2",
        installId: "e".repeat(32),
        createdAt: "2026-11-05T09:03:00.000Z",
        lastUsedAt: "2026-11-05T10:00:00.000Z",
      }),
      connection({
        label,
        id: "conn-3",
        createdAt: "2026-11-05T09:04:00.000Z",
        lastUsedAt: "2026-11-05T10:00:00.000Z",
      }),
    ],
  });
  await expect(local.getByText("Connected", { exact: true })).toBeVisible();
  await expect(
    list.getByText(`${label} · This browser`, { exact: true }),
  ).toBeVisible();
  await expect(list.getByText(label, { exact: true })).toHaveCount(2);
  await expect(
    list.getByRole("button", `Disconnect ${label} · This browser`, {
      exact: true,
    }),
  ).toBeEnabled();
  const descriptions = await fixtures.browser.evaluate(() =>
    Array.from(
      document.querySelectorAll('[data-slot="item-description"]'),
      (node) => node.textContent,
    ).filter((text) =>
      /^Connected .* from OpenBot, last used /.test(text ?? ""),
    ),
  );
  expect(descriptions).toHaveLength(3);
  expect(new Set(descriptions).size).toBe(3);
});

test("a listed connection refreshes from last-use time to recording now", async (fixtures) => {
  const entry = connection({
    lastUsedAt: new Date(Date.now() - 49_000).toISOString(),
  });
  const { list, reads, setConnections } = await openRecorders(fixtures, {
    connections: [entry],
  });
  await expect(
    list.getByText(/^Connected .* from OpenBot, last used [\w ]+ ago$/),
  ).toBeVisible();
  const initialReads = reads();
  setConnections([{ ...entry, recording: true }]);
  await expect(
    list.getByText(/^Connected .* from OpenBot, recording now$/),
  ).toBeVisible();
  expect(reads()).toBeGreaterThan(initialReads);
  await expect(list.getByText(/last used/)).toHaveCount(0);
});

test("Disconnect names this browser, another browser and the OpenBot browser accurately", async (fixtures) => {
  const { screen } = fixtures;
  const { list, writes } = await openRecorders(fixtures, {
    bridge: { ping: { ok: true, installId: thisCopy } },
    connections: [
      connection(),
      connection({ id: "conn-2", label: edge, installId: otherCopy }),
      connection({
        id: "conn-3",
        label: own,
        via: "openbot-browser",
        installId: "e".repeat(32),
      }),
    ],
  });
  await expect(
    list.getByText(/^Your OpenBot browser, connected .* never used$/),
  ).toBeVisible();
  for (const [label, who, title] of [
    [`${chrome} · This browser`, "this browser", chrome],
    [edge, edge, edge],
    [own, "your OpenBot browser", own],
  ]) {
    await list
      .getByRole("button", `Disconnect ${label}`, { exact: true })
      .click();
    const dialog = screen.getByRole("dialog", `Disconnect ${title}?`, {
      exact: true,
    });
    await expect(dialog).toContainText(
      `OpenBot signs the Recorder in ${who} out.`,
    );
    await dialog.getByRole("button", "Cancel", { exact: true }).click();
    await expect(dialog).toHaveCount(0);
  }
  expect(writes).toEqual([]);
});

test("confirming Disconnect revokes the named browser and survives reload", async (fixtures) => {
  const { browser, screen } = fixtures;
  const { list, writes } = await openRecorders(fixtures, {
    connections: [connection()],
  });
  const disconnect = list.getByRole("button", `Disconnect ${chrome}`, {
    exact: true,
  });
  await expect(
    list.getByText(/^Connected .* from OpenBot, never used$/),
  ).toBeVisible();
  await disconnect.click();
  const dialog = screen.getByRole("dialog", `Disconnect ${chrome}?`, {
    exact: true,
  });
  await expect(dialog).toContainText(
    "OpenBot signs the Recorder in Chrome on Mac out. It records nothing for you until you connect it again, and a recording running there stops.",
  );
  expect(writes).toEqual([]);
  await dialog.getByRole("button", "Disconnect", { exact: true }).click();
  await expect(dialog).toHaveCount(0);
  await expect(
    list.getByText("No browsers connected yet.", { exact: true }),
  ).toBeVisible();
  await expect(disconnect).toHaveCount(0);
  expect(writes).toEqual([disconnectWrite("conn-1")]);
  await browser.reload();
  await expect(
    list.getByText("No browsers connected yet.", { exact: true }),
  ).toBeVisible();
});

test("a refused Disconnect shows the server reason without removing the row", async (fixtures) => {
  const { screen } = fixtures;
  const refused = "That browser is already disconnected.";
  const { list, writes } = await openRecorders(fixtures, {
    connections: [connection()],
    refuseDelete: refused,
  });
  const disconnect = list.getByRole("button", `Disconnect ${chrome}`, {
    exact: true,
  });
  await disconnect.click();
  const dialog = screen.getByRole("dialog", `Disconnect ${chrome}?`, {
    exact: true,
  });
  await dialog.getByRole("button", "Cancel", { exact: true }).click();
  await expect(dialog).toHaveCount(0);
  expect(writes).toEqual([]);
  await disconnect.click();
  const confirm = dialog.getByRole("button", "Disconnect", { exact: true });
  await confirm.click();
  const alert = dialog.getByRole("alert");
  await alert.getByRole("button", "Details", { exact: true }).click();
  await expect(alert).toContainText(refused);
  await expect(confirm).toBeEnabled();
  await dialog.getByRole("button", "Cancel", { exact: true }).click();
  await expect(disconnect).toBeEnabled();
  expect(writes).toEqual([disconnectWrite("conn-1")]);
});

test("a pending Disconnect disables only the selected browser action", async (fixtures) => {
  const { browser, screen } = fixtures;
  const { promise, resolve } = Promise.withResolvers<void>();
  const { list, writes } = await openRecorders(fixtures, {
    connections: [
      connection(),
      connection({ id: "conn-2", label: edge, installId: otherCopy }),
    ],
    holdDelete: promise,
  });
  const first = browser.locator(`button[aria-label="Disconnect ${chrome}"]`);
  const other = browser.locator(`button[aria-label="Disconnect ${edge}"]`);
  try {
    await first.click();
    const dialog = screen.getByRole("dialog", `Disconnect ${chrome}?`, {
      exact: true,
    });
    await dialog.getByRole("button", "Disconnect", { exact: true }).click();
    await expect(
      dialog.getByRole("button", "Disconnecting…", { exact: true }),
    ).toBeDisabled();
    await expect(first).toBeDisabled();
    await expect(other).toBeEnabled();
    await expect.poll(() => writes.length).toBe(1);
    expect(writes).toEqual([disconnectWrite("conn-1")]);
  } finally {
    resolve();
  }
  await expect(screen.getByRole("dialog")).toHaveCount(0);
  await expect(first).toHaveCount(0);
  await expect(
    list.getByRole("button", `Disconnect ${edge}`, { exact: true }),
  ).toBeEnabled();
});

const connectWrite = {
  method: "POST",
  path: connectPath,
  body: { via: "web" },
};
const connectMessage = {
  id: extensionId,
  message: { type: "openbot.connect", code },
};

test("Connect sends a code to this Recorder and waits for the matching copy", async (fixtures) => {
  const {
    local,
    list,
    connect,
    writes,
    reads,
    setConnections,
    setBridge,
    messages,
  } = await openRecorders(fixtures, {
    bridge: found,
    connections: [
      connection({ id: "other", label: edge, installId: otherCopy }),
    ],
  });
  await connect.click();
  await expect(local.getByText(waiting, { exact: true })).toBeVisible();
  expect(writes).toEqual([connectWrite]);
  expect(
    (await messages()).filter(
      ({ message }) => message.type === "openbot.connect",
    ),
  ).toEqual([connectMessage]);

  const before = reads();
  await expect.poll(reads).toBeGreaterThan(before);
  await expect(local.getByText(waiting, { exact: true })).toBeVisible();
  await expect(local.getByText("Connected", { exact: true })).toHaveCount(0);
  await expect(list.getByText(edge, { exact: true })).toBeVisible();

  setConnections([
    connection(),
    connection({ id: "other", label: edge, installId: otherCopy }),
  ]);
  await setBridge({
    ...found,
    ping: { ok: true, version: "1", installId: thisCopy },
  });
  await expect(local.getByText("Connected", { exact: true })).toBeVisible();
  await expect(
    list.getByText(`${chrome} · This browser`, { exact: true }),
  ).toBeVisible();
  await expect(connect).toHaveCount(0);
  expect(writes).toEqual([connectWrite]);
});

for (const { state, sentence } of [
  {
    state: "cancelled",
    sentence:
      "You cancelled in the OpenBot Recorder tab. Nothing was connected.",
  },
  {
    state: "closed",
    sentence:
      "The OpenBot Recorder tab closed before you confirmed. Nothing was connected.",
  },
] as const) {
  test(`the original page stops waiting when the Recorder reports ${state}`, async (fixtures) => {
    const { local, connect, writes, setBridge, messages } = await openRecorders(
      fixtures,
      { bridge: found },
    );
    await connect.click();
    const confirm = local.getByText(waiting, { exact: true });
    await expect(confirm).toBeVisible();
    await setBridge({ ...found, wait: state });
    await expect(local.getByText(sentence, { exact: true })).toBeVisible({
      timeout: 2000,
    });
    await expect(connect).toBeEnabled();

    await setBridge(found);
    const asked = async () =>
      (await messages()).filter(
        ({ message }) => message.type === "openbot.connect.status",
      ).length;
    const before = await asked();
    await connect.click();
    await expect(confirm).toBeVisible();
    await expect.poll(asked).toBeGreaterThan(before);
    await expect(confirm).toBeVisible();
    expect(writes).toEqual([connectWrite, connectWrite]);
  });
}

test("a trusted Recorder connects directly without showing a confirmation tab prompt", async (fixtures) => {
  const { browser } = fixtures;
  const { local, connect, messages, writes } = await openRecorders(fixtures, {
    bridge: {
      ...found,
      connect: { ok: true, connected: true, version: "1", installId: thisCopy },
    },
    connectCreates: connection(),
  });
  await browser.evaluate(() => {
    const observe = () => {
      if (
        document.body.textContent?.includes(
          "Confirm in the OpenBot Recorder tab that opened.",
        )
      ) {
        document.documentElement.setAttribute("data-recorder-asked", "true");
      }
    };
    new MutationObserver(observe).observe(document.body, {
      childList: true,
      subtree: true,
      characterData: true,
    });
    return null;
  });
  await connect.click();
  await expect(local.getByText("Connected", { exact: true })).toBeVisible();
  await expect(connect).toHaveCount(0);
  await expect(browser.locator("html[data-recorder-asked]")).toHaveCount(0);
  expect(
    (await messages()).filter(
      ({ message }) => message.type === "openbot.connect.status",
    ),
  ).toEqual([]);
  expect(writes).toEqual([connectWrite]);
});

for (const { error, sentence } of [
  {
    error: "pinned-elsewhere",
    sentence: "Your organization set the Recorder to another OpenBot.",
  },
  {
    error: "busy",
    sentence:
      "The Recorder is finishing another connect request. Try again in a moment.",
  },
  {
    error: "invalid",
    sentence: "The Recorder didn't accept the request. Try again.",
  },
] as const) {
  test(`the Recorder reports the ${error} connection refusal and offers another attempt`, async (fixtures) => {
    const { local, connect, writes } = await openRecorders(fixtures, {
      bridge: { ping: found.ping, connect: { ok: false, error } },
    });
    await connect.click();
    await expect(local.getByText(sentence, { exact: true })).toBeVisible();
    await expect(connect).toBeEnabled();
    expect(writes).toEqual([connectWrite]);
  });
}

test("connection throttling rounds the retry time up and never displays zero minutes", async (fixtures) => {
  const throttled = (retryAfterMs: number): Bridge => ({
    ping: found.ping,
    connect: { ok: false, error: "throttled", retryAfterMs },
  });
  const { local, connect, setBridge, writes } = await openRecorders(fixtures, {
    bridge: throttled(390_000),
  });
  await connect.click();
  await expect(
    local.getByText(
      "Too many connect requests in a short time. Try again in 7 minutes.",
      { exact: true },
    ),
  ).toBeVisible();
  await setBridge(throttled(20_000));
  await connect.click();
  await expect(
    local.getByText(
      "Too many connect requests in a short time. Try again in 1 minute.",
      { exact: true },
    ),
  ).toBeVisible();
  await expect(
    local.getByText(/finishing another connect request/),
  ).toHaveCount(0);
  expect(writes).toEqual([connectWrite, connectWrite]);
});

test("an unanswered Connect expires after its five-minute window and stops checking the Recorder tab", async (fixtures) => {
  const { browser } = fixtures;
  const { local, connect, reads, writes, messages } = await openRecorders(
    fixtures,
    { bridge: found },
  );
  await browser.evaluate(() => {
    const callbacks: (() => void)[] = [];
    Object.assign(window, { recorderExpiryTimers: callbacks });
    const schedule = window.setTimeout.bind(window);
    Object.defineProperty(window, "setTimeout", {
      value: (handler: TimerHandler, timeout?: number, ...args: unknown[]) => {
        if (timeout === 300_000 && typeof handler === "function") {
          callbacks.push(() => handler(...args));
        }
        return schedule(handler, timeout, ...args);
      },
    });
    return null;
  });
  await connect.click();
  await expect(local.getByText(waiting, { exact: true })).toBeVisible();
  const readsBefore = reads();
  await expect.poll(reads).toBeGreaterThan(readsBefore);
  const triggered = await browser.evaluate(() => {
    const timers =
      (window as Window & { recorderExpiryTimers?: (() => void)[] })
        .recorderExpiryTimers ?? [];
    for (const fire of timers) fire();
    return timers.length;
  });
  expect(triggered).toBeGreaterThan(0);
  await expect(
    local.getByText("The request expired. Try again.", { exact: true }),
  ).toBeVisible();
  await expect(connect).toBeEnabled();
  const statusChecks = async () =>
    (await messages()).filter(
      ({ message }) => message.type === "openbot.connect.status",
    ).length;
  const checks = await statusChecks();
  const readsAtExpiry = reads();
  // The waiting state polls every two seconds and the regular list refreshes every ten seconds.
  await Bun.sleep(2500);
  expect(await statusChecks()).toBe(checks);
  expect(reads()).toBe(readsAtExpiry);
  expect(writes).toEqual([connectWrite]);
});

test("without the Recorder or a store page, This browser has no connect action", async (fixtures) => {
  const { browser } = fixtures;
  await browser.addInitScript(() => {
    Object.defineProperty(navigator, "userAgentData", {
      configurable: true,
      value: {
        brands: [{ brand: "Chromium", version: "156" }],
        mobile: false,
        platform: "macOS",
      },
    });
  });
  const { local, writes } = await openRecorders(fixtures);
  await expect(
    local.getByText("The OpenBot Recorder isn't installed in this browser.", {
      exact: true,
    }),
  ).toBeVisible();
  await expect(local.getByRole("button")).toHaveCount(0);
  await expect(local.getByRole("link")).toHaveCount(0);
  expect(writes).toEqual([]);
});

test("Chrome without Recorder opens its store page and shows where to add it", async (fixtures) => {
  const { browser, screen } = fixtures;
  const store = `https://chromewebstore.google.com/detail/${"s".repeat(32)}`;
  await browser.addInitScript(() => {
    Object.defineProperty(navigator, "userAgentData", {
      configurable: true,
      value: {
        brands: [
          { brand: "Chromium", version: "156" },
          { brand: "Google Chrome", version: "156" },
        ],
        mobile: false,
        platform: "macOS",
      },
    });
  });
  await browser.route(store, (route) =>
    route.fulfill({
      body: "<title>Recorder store fixture</title>",
      contentType: "text/html",
    }),
  );
  const { local, writes } = await openRecorders(fixtures, {
    page: "/tests/browser/recorder-store.html",
  });
  const [original] = browser.tabs();
  if (!original) throw new Error("Expected a Settings browser tab");
  await expect(
    local.getByText("The OpenBot Recorder isn't installed in this browser.", {
      exact: true,
    }),
  ).toBeVisible();
  const add = local.getByRole("link", "Add to Chrome", { exact: true });
  await expect(add).toHaveAttribute("href", store);
  await expect(add).toHaveAttribute("target", "_blank");
  await expect(add).toHaveAttribute("rel", "noopener noreferrer");
  await add.click();
  await expect
    .poll(async () => Promise.all(browser.tabs().map((tab) => tab.url())))
    .toContain(store);
  await original.activate();
  await expect(
    screen.getByText(
      "The OpenBot Recorder's page is open in a new tab. Add it to Google Chrome to record from OpenBot.",
      { exact: true },
    ),
  ).toBeVisible();
  expect(writes).toEqual([]);
});
