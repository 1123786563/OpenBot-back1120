import { type Browser, test } from "@e2e-dev/web";
import { expect } from "e2e";
import { chatEventStream, chatRunPath, readChatRun } from "./chat-stream";
import {
  computerConversation,
  computerStep,
  type Fixtures,
  readComputerViewer,
  screenshot,
  serveComputer,
  shotFailure,
  site,
  terminalOutput,
} from "./computer-fixtures";
import { stageChatRun } from "./staged-chat-stream";

const notShown = "Can't show the screen right now";
async function controlStartupGrace(browser: Browser) {
  await browser.addInitScript(() => {
    const schedule = window.setTimeout.bind(window);
    const cancel = window.clearTimeout.bind(window);
    const deadlines = new Map<number, () => void>();
    Object.assign(window, {
      setTimeout(handler: TimerHandler, delay?: number, ...args: unknown[]) {
        const timer = schedule(handler, delay, ...args);
        if (delay === 150_000 && typeof handler === "function")
          deadlines.set(timer, () => handler(...args));
        return timer;
      },
      clearTimeout(timer?: number) {
        if (timer !== undefined) deadlines.delete(timer);
        cancel(timer);
      },
    });
    Object.defineProperty(window, "startupGraceFixture", {
      value: {
        pending: () => deadlines.size,
        expire() {
          for (const [timer, handler] of deadlines) {
            cancel(timer);
            deadlines.delete(timer);
            handler();
          }
        },
      },
    });
  });
  return {
    pending: () =>
      browser.evaluate(() =>
        Number(Reflect.get(window, "startupGraceFixture").pending()),
      ),
    expire: () =>
      browser.evaluate(() => {
        Reflect.get(window, "startupGraceFixture").expire();
        return null;
      }),
  };
}

test("a starting Computer shows its startup message and replaces it with its first frame", async (fixtures) => {
  const { screen } = fixtures;
  const { bot, state } = await computerConversation(fixtures, {
    status: "starting",
    frame: "starting",
  });
  const panel = screen.getByRole("region", "Computer sidebar", { exact: true });
  const starting = panel.getByText(
    /^Starting .* computer\. The first start takes about a minute\.$/,
  );
  await expect(starting).toBeVisible();
  await expect(starting).toContainText(bot.name);
  await expect(panel.getByText(notShown, { exact: true })).toHaveCount(0);
  await expect(panel.getByRole("alert")).toHaveCount(0);
  state.set({ status: "ready", frame: "frame" });
  await expect(
    panel.getByRole("img", "What the Bot is looking at", { exact: true }),
  ).toBeVisible();
  await expect(starting).toHaveCount(0);
});

test("screenshot errors during startup become a problem only after the grace period", async (fixtures) => {
  const { browser, screen } = fixtures;
  const grace = await controlStartupGrace(browser);
  const { state } = await computerConversation(fixtures, {
    status: "starting",
    frame: "failure",
  });
  const panel = screen.getByRole("region", "Computer sidebar", { exact: true });
  await expect(panel.getByText(/^Starting .* computer/)).toBeVisible();
  await expect.poll(grace.pending).toBeGreaterThan(0);
  await expect.poll(state.screenshots).toBeGreaterThan(1);
  await expect(panel.getByText(notShown, { exact: true })).toHaveCount(0);
  await grace.expire();
  await expect(panel.getByText(notShown, { exact: true })).toBeVisible();
  await expect(panel.getByText(shotFailure, { exact: true })).toBeVisible();
});

test("an unreachable Computer shows the person-facing error without waiting for startup grace", async (fixtures) => {
  const { screen } = fixtures;
  const { bot } = await computerConversation(fixtures, {
    status: "unreachable",
    frame: "unreachable",
  });
  const panel = screen.getByRole("region", "Computer sidebar", { exact: true });
  await expect(
    panel.getByText(/^.* computer can't be reached right now\.$/),
  ).toContainText(bot.name);
  await expect(panel.getByText(/supervisor down/)).toHaveCount(0);
  await expect(panel.getByText(/^Starting .* computer/)).toHaveCount(0);
});

test("an off Computer stays calm until its screenshot fails after it starts", async (fixtures) => {
  const { browser, screen } = fixtures;
  const grace = await controlStartupGrace(browser);
  const { state } = await computerConversation(fixtures, {
    status: "absent",
    frame: "absent",
  });
  const panel = screen.getByRole("region", "Computer sidebar", { exact: true });
  const off = panel.getByText(
    /computer is off\. It starts when the Bot next uses it\./,
  );
  await expect(off).toBeVisible();
  const before = state.screenshots();
  await expect.poll(state.screenshots).toBeGreaterThan(before);
  expect(await grace.pending()).toBe(0);
  await expect(panel.getByText(notShown, { exact: true })).toHaveCount(0);
  state.set({ status: "ready", frame: "failure" });
  await expect(off).toHaveCount(0);
  await expect.poll(grace.pending).toBeGreaterThan(0);
  await grace.expire();
  await expect(panel.getByText(notShown, { exact: true })).toBeVisible();
  await expect(panel.getByText(shotFailure, { exact: true })).toBeVisible();
});

test("a Computer that goes to sleep clears its last screenshot", async (fixtures) => {
  const { screen } = fixtures;
  const { state } = await computerConversation(fixtures, {
    status: "ready",
    frame: "frame",
  });
  const panel = screen.getByRole("region", "Computer sidebar", { exact: true });
  const image = panel.getByRole("img", "What the Bot is looking at", {
    exact: true,
  });
  await expect(image).toBeVisible();
  state.set({ status: "absent", frame: "absent" });
  await expect(
    panel.getByText(/computer is off\. It starts when the Bot next uses it\./),
  ).toBeVisible();
  await expect(image).toHaveCount(0);
});

test("a dropped full-size Computer stream shows reconnecting and recovers without a retry panel", async (fixtures) => {
  const { browser, screen } = fixtures;
  const { bot, observe } = await computerConversation(
    fixtures,
    { status: "ready", frame: "frame" },
    { holdReconnect: true },
  );
  await screen
    .getByRole("button", "Open the Bot's screen full size", { exact: true })
    .click();
  const dialog = screen.getByRole("dialog", "The Bot's screen", {
    exact: true,
  });
  const stream = `/api/computers/${encodeURIComponent(bot.id)}/stream`;
  const canvas = browser.locator(
    '[role="dialog"][aria-label="The Bot\'s screen"] canvas',
  );
  await expect(canvas).toHaveAttribute("data-connected", "true");
  const before = await observe();
  expect(before.requests.length).toBeGreaterThan(0);
  expect(before.requests.every((path) => path === stream)).toBe(true);
  await browser.evaluate(() => {
    Reflect.get(window, "screenFixture").disconnect();
    return null;
  });
  const reconnecting = dialog.getByText("Reconnecting…", { exact: true });
  const retry = dialog.getByRole("button", "Retry", { exact: true });
  await expect(reconnecting).toBeVisible();
  await expect(retry).toHaveCount(0);
  await expect
    .poll(async () => (await observe()).requests.length)
    .toBe(before.requests.length + 1);
  await browser.evaluate(() => {
    Reflect.get(window, "screenFixture").resume();
    return null;
  });
  await expect(reconnecting).toHaveCount(0);
  await expect(retry).toHaveCount(0);
  await expect(canvas).toBeVisible();
});

test("a browser action that could not run during startup appears as not done yet", async (fixtures) => {
  const { browser, screen } = fixtures;
  await computerConversation(
    fixtures,
    { status: "starting", frame: "starting" },
    {
      search: "",
      history: [
        { id: "request", role: "user", content: "Select the report." },
        {
          id: "steps",
          role: "assistant",
          content: "",
          toolCalls: [
            {
              id: "click",
              type: "function",
              function: {
                name: "computer_click",
                arguments: JSON.stringify({ ref: "report", snapshotId: 1 }),
              },
            },
          ],
        },
        {
          id: "result",
          role: "tool",
          toolCallId: "click",
          content: JSON.stringify({
            ok: false,
            starting: true,
            notPerformed: true,
            reason: "The computer is still starting.",
          }),
        },
      ],
    },
  );
  const transcript = screen.getByRole("region", "Messages", { exact: true });
  await transcript.getByText("Used the browser", { exact: true }).click();
  const step = transcript.getByText("Clicked on page, not done yet", {
    exact: true,
  });
  await expect(step).toBeVisible();
  await expect(
    transcript.getByText("The computer is still starting.", { exact: true }),
  ).toBeVisible();
  await expect(transcript.getByText(/didn't work|1 issue/i)).toHaveCount(0);
  const coloredAsFailure = await browser.evaluate(() => {
    const step = [...document.querySelectorAll("span")].find(
      (node) => node.textContent === "Clicked on page, not done yet",
    );
    if (!step) throw new Error("Starting action not found in transcript");
    return Boolean(step.closest(".text-amber-600, .text-destructive"));
  });
  expect(coloredAsFailure).toBe(false);
});

async function requestComputerAction(
  browser: Browser,
  botId: string,
  action: "navigate" | "click",
) {
  await browser.evaluate(
    async ({ botId, action, url }) => {
      const modulePath = "/src/lib/computers/call.ts";
      const { callComputer } = await import(modulePath);
      const results: Record<string, unknown> =
        Reflect.get(window, "computerActionResults") ?? {};
      Reflect.set(window, "computerActionResults", results);
      const key = `${botId}:${action}`;
      delete results[key];
      void callComputer(botId, `/${action}`, {
        method: "POST",
        body:
          action === "navigate" ? { url } : { ref: "report", snapshotId: 1 },
      }).then((result: unknown) => {
        results[key] = result;
      });
      return null;
    },
    { botId, action, url: site },
  );
  return () =>
    browser.evaluate((key) => {
      const outcome = Reflect.get(window, "computerActionResults")?.[key];
      return JSON.stringify(outcome ?? null);
    }, `${botId}:${action}`);
}

async function serveBrowserAction(
  browser: Browser,
  botId: string,
  action: string,
  { refused = false, held }: { refused?: boolean; held?: Promise<void> } = {},
) {
  const calls: unknown[] = [];
  const path = `/api/computers/${encodeURIComponent(botId)}/${action}`;
  await browser.route(new RegExp(`${RegExp.escape(path)}$`), async (route) => {
    calls.push({
      url: new URL(route.request.url).pathname,
      method: route.request.method,
      body: JSON.parse(route.request.postData ?? "null"),
    });
    await held;
    return refused
      ? route.fulfill({ status: 403, json: { error: "Blocked for this Bot." } })
      : route.fulfill({ json: { url: site } });
  });
  return { calls, path };
}

for (const initial of ["closed", "settings", "manual"] as const) {
  test(`a refused browser action ${initial === "closed" ? "takes back only the panel it opened" : `preserves the ${initial} panel`}`, async (fixtures) => {
    const { browser, screen } = fixtures;
    const search = {
      closed: "",
      settings: "?settings=true",
      manual: "?watch=true",
    }[initial];
    const { bot, path } = await computerConversation(
      fixtures,
      { status: "ready", frame: "frame" },
      { search },
    );
    await expect(
      screen.getByRole("button", /^(Open|Close) Computer$/),
    ).toBeEnabled();
    const first = Promise.withResolvers<void>();
    const { calls, path: actionPath } = await serveBrowserAction(
      browser,
      bot.id,
      "navigate",
      { refused: true, held: first.promise },
    );
    const computer = screen.getByRole("region", "Computer sidebar", {
      exact: true,
    });
    try {
      const result = await requestComputerAction(browser, bot.id, "navigate");
      await expect
        .poll(() => calls)
        .toEqual([{ url: actionPath, method: "POST", body: { url: site } }]);
      if (initial === "settings") {
        await expect(browser).toHaveURL(`${path}${search}`);
        await expect(computer).toHaveCount(0);
      } else {
        await expect(browser).toHaveURL(`${path}?watch=true`);
        await expect(computer).toBeVisible();
      }
      first.resolve();
      await expect.poll(result).toContain('"refused":true');
      await expect(browser).toHaveURL(`${path}${search}`);
      if (initial === "manual") await expect(computer).toBeVisible();
      else await expect(computer).toHaveCount(0);
    } finally {
      first.resolve();
    }
  });
}

test("a later refusal does not close Computer, and a dismissed run stays closed until a new run", async (fixtures) => {
  const { browser, screen } = fixtures;
  const { bot, path } = await computerConversation(
    fixtures,
    { status: "ready", frame: "frame" },
    { search: "" },
  );
  await expect(
    screen.getByRole("button", "Open Computer", { exact: true }),
  ).toBeEnabled();
  const unrelated = "other-computer-fixture";
  await serveBrowserAction(browser, unrelated, "navigate");
  await serveBrowserAction(browser, bot.id, "navigate");
  await serveBrowserAction(browser, bot.id, "click", { refused: true });
  const computer = screen.getByRole("region", "Computer sidebar", {
    exact: true,
  });
  await expect(computer).toHaveCount(0);

  const remote = await requestComputerAction(browser, unrelated, "navigate");
  await expect.poll(remote).toContain('"ok":true');
  await expect(browser).toHaveURL(path);
  await expect(computer).toHaveCount(0);

  const opens = await requestComputerAction(browser, bot.id, "navigate");
  await expect.poll(opens).toContain('"ok":true');
  await expect(browser).toHaveURL(`${path}?watch=true`);
  await expect(computer).toBeVisible();

  const later = await requestComputerAction(browser, bot.id, "click");
  await expect.poll(later).toContain('"refused":true');
  await expect(browser).toHaveURL(`${path}?watch=true`);
  await expect(computer).toBeVisible();

  await screen.getByRole("button", "Close details", { exact: true }).click();
  await expect(browser).toHaveURL(path);
  const sameRun = await requestComputerAction(browser, bot.id, "navigate");
  await expect.poll(sameRun).toContain('"ok":true');
  await expect(browser).toHaveURL(path);
  await expect(computer).toHaveCount(0);

  await requestComputerAction(browser, unrelated, "navigate");
  const nextRun = await requestComputerAction(browser, bot.id, "navigate");
  await expect.poll(nextRun).toContain('"ok":true');
  await expect(browser).toHaveURL(`${path}?watch=true`);
  await expect(computer).toBeVisible();
});

test("the Terminal shows binary output and sends input only while the viewer holds control", async (fixtures) => {
  const { browser, screen } = fixtures;
  const { state, terminalState } = await computerConversation(
    fixtures,
    { status: "ready", frame: "frame" },
    { terminal: true },
  );
  if (!terminalState) throw new Error("The terminal socket fixture is missing");
  await screen.getByRole("tab", "Terminal", { exact: true }).click();
  const panel = screen.getByRole("tabpanel", "Terminal", { exact: true });
  const terminal = browser.locator(".xterm-helper-textarea");
  await expect(
    panel.getByRole("region", "The Bot's terminal", { exact: true }),
  ).toBeVisible();
  await expect
    .poll(async () => {
      const records = await terminalState.read();
      return records.findLast(({ closed }) => !closed)?.sent ?? [];
    })
    .toEqual(
      expect.arrayContaining([
        { type: "ack", bytes: new TextEncoder().encode(terminalOutput).length },
      ]),
    );
  const active = (await terminalState.read()).findLast(({ closed }) => !closed);
  expect(active?.path).toBe(terminalState.expectedPath);
  expect(active?.binaryType).toBe("arraybuffer");
  await expect(browser.locator(".xterm-rows")).toContainText(
    "hello from the Bot",
  );
  const sentInput = async () =>
    (await terminalState.read()).flatMap(({ sent }) =>
      sent.filter(({ type }) => type === "input"),
    );
  await terminal.focus();
  await expect(terminal).toBeFocused();
  await browser.keyboard.press("a");
  expect(await sentInput()).toEqual([]);

  await panel.getByRole("button", "Take control", { exact: true }).click();
  await expect(
    panel.getByText(
      /of the terminal and the screen\. Click the terminal and type\./,
    ),
  ).toBeVisible();
  await expect(terminal).toBeFocused();
  await expect(
    screen.getByRole("dialog", "The Bot's screen", { exact: true }),
  ).toHaveCount(0);
  await browser.keyboard.press("Enter");
  await expect.poll(sentInput).toEqual([{ type: "input", data: "\r" }]);
  await panel.getByRole("button", "Hand back", { exact: true }).click();
  await expect(
    panel.getByText("The Bot has control.", { exact: true }),
  ).toBeVisible();
  await terminal.focus();
  await browser.keyboard.press("b");
  expect(await sentInput()).toEqual([{ type: "input", data: "\r" }]);
  expect(state.handoffs).toEqual([
    {
      action: "request",
      body: {
        reason: "I want to take control of the browser.",
        source: "manual",
      },
    },
    { action: "take", body: { requestId: "terminal-handoff" } },
    { action: "release", body: { requestId: "terminal-handoff" } },
  ]);
});

const commandText = "echo report";

function commandStep(id: string) {
  return computerStep(
    id,
    "computer_run_command",
    { command: commandText },
    { ok: true, stdout: "report", exitCode: 0 },
  );
}

test("Computer follows conversation work until the person picks a view, then resumes on reopening", async (fixtures) => {
  const { browser, screen } = fixtures;
  const initial = [
    { id: "request", role: "user", content: "Prepare the report." },
    ...commandStep("first-command"),
  ];
  const { terminalState } = await computerConversation(
    fixtures,
    { status: "ready", frame: "frame" },
    { terminal: true, history: initial },
  );
  if (!terminalState) throw new Error("The terminal socket fixture is missing");
  const pane = screen.getByRole("region", "Computer sidebar", { exact: true });
  const terminal = pane.getByRole("tab", "Terminal", { exact: true });
  const screenTab = pane.getByRole("tab", "Screen", { exact: true });
  await expect(terminal).toHaveAttribute("aria-selected", "true");

  const latest = [
    computerStep(
      "page",
      "computer_navigate",
      { url: site },
      { ok: true, url: site, title: "Fixture report" },
    ),
    commandStep("second-command"),
    commandStep("third-command"),
    computerStep(
      "file",
      "computer_read_file",
      { path: "report.txt" },
      { ok: true, text: "Report" },
    ),
  ];
  let runs = 0;
  await browser.route(chatRunPath, (route) => {
    const { runId, threadId, messages } = readChatRun(
      route.request.postData ?? undefined,
    );
    const steps = latest[runs++];
    if (!steps) throw new Error("Unexpected Computer continuation");
    return route.fulfill(
      chatEventStream([
        { type: "RUN_STARTED", runId, threadId },
        { type: "MESSAGES_SNAPSHOT", messages: [...messages, ...steps] },
        { type: "RUN_FINISHED", runId, threadId },
      ]),
    );
  });
  async function ask(text: string, expected: number) {
    await screen.getByRole("textbox", "Message", { exact: true }).fill(text);
    await screen.getByRole("button", "Send message", { exact: true }).click();
    await expect.poll(() => runs).toBe(expected);
    await expect(
      screen
        .getByRole("region", "Messages", { exact: true })
        .getByText(text, { exact: true }),
    ).toBeVisible();
    await expect(browser.locator('[data-testid="composer-stop"]')).toHaveCount(
      0,
    );
  }

  await ask("Open the report.", 1);
  await expect(screenTab).toHaveAttribute("aria-selected", "true");
  await expect
    .poll(async () =>
      (await terminalState.read()).every(({ closed }) => closed),
    )
    .toBe(true);
  await ask("Run another command.", 2);
  await expect(terminal).toHaveAttribute("aria-selected", "true");
  await screenTab.click();
  await ask("Run once more.", 3);
  await expect(screenTab).toHaveAttribute("aria-selected", "true");
  await screen.getByRole("button", "Close details", { exact: true }).click();
  await expect(pane).toHaveCount(0);
  await screen.getByRole("button", "Open Computer", { exact: true }).click();
  await expect(terminal).toHaveAttribute("aria-selected", "true");
  await ask("Read the saved report.", 4);
  await expect(terminal).toHaveAttribute("aria-selected", "true");
});

test("clicking a command in the transcript opens Computer on the Terminal tab", async (fixtures) => {
  const { screen } = fixtures;
  const history = [
    { id: "request", role: "user", content: "Prepare the report." },
    ...commandStep("command"),
    ...computerStep(
      "page",
      "computer_navigate",
      { url: site },
      { ok: true, url: site, title: "Fixture report" },
    ),
  ];
  await computerConversation(
    fixtures,
    { status: "ready", frame: "frame" },
    { terminal: true, history },
  );
  const pane = screen.getByRole("region", "Computer sidebar", { exact: true });
  await expect(
    pane.getByRole("tab", "Screen", { exact: true }),
  ).toHaveAttribute("aria-selected", "true");
  await screen
    .getByRole("region", "Messages", { exact: true })
    .getByRole("button", "Open in the terminal", { exact: true })
    .click();
  await expect(
    pane.getByRole("tab", "Terminal", { exact: true }),
  ).toHaveAttribute("aria-selected", "true");
});

for (const blankName of [false, true]) {
  test(`the Computer preview shows ${blankName ? "the fallback Bot name" : "the address and the Bot's name"} while the Bot has control`, async (fixtures) => {
    const { browser, screen } = fixtures;
    const { bot, state } = await computerConversation(
      fixtures,
      { status: "ready", frame: "frame" },
      { blankName },
    );
    const status = browser.locator('[data-slot="control-strip"]');
    await expect(
      status.getByText(
        blankName ? "The Bot has control" : `${bot.name} has control`,
        { exact: true },
      ),
    ).toBeVisible();
    await expect(
      status.getByRole("button", "Take control", { exact: true }),
    ).toBeEnabled();
    if (blankName) return;
    const caption = browser.locator(
      '[aria-label="Computer sidebar"] figcaption',
    );
    state.setPage("https://shop.example.test/orders?id=7");
    await expect(caption).toHaveText("shop.example.test/orders?id=7");
    await expect(caption.getByText(bot.name, { exact: true })).toHaveCount(0);
    state.setPage("about:blank");
    await expect(caption).toHaveText(bot.name);
    await expect(
      screen.getByRole("img", "What the Bot is looking at", { exact: true }),
    ).toHaveCount(0);
    await expect(caption.getByText(/about:blank/)).toHaveCount(0);
  });
}

const screenCanvas = '[role="dialog"][aria-label="The Bot\'s screen"] canvas';

async function controlScreenVisibility(browser: Browser, hidden = false) {
  await browser.addInitScript((initial) => {
    let hidden = initial && location.pathname.startsWith("/channel/");
    Object.defineProperties(document, {
      hidden: { get: () => hidden },
      visibilityState: { get: () => (hidden ? "hidden" : "visible") },
    });
    Object.defineProperty(window, "setComputerFixtureHidden", {
      value(next: boolean) {
        hidden = next;
        document.dispatchEvent(new Event("visibilitychange"));
      },
    });
  }, hidden);
  return (hidden: boolean) =>
    browser.evaluate((value) => {
      Reflect.get(window, "setComputerFixtureHidden")(value);
      return null;
    }, hidden);
}

async function openLiveCanvas(fixtures: Fixtures) {
  const { browser, screen } = fixtures;
  const { observe } = await computerConversation(fixtures, {
    status: "ready",
    frame: "frame",
  });
  await screen
    .getByRole("button", "Open the Bot's screen full size", { exact: true })
    .click();
  const canvas = browser.locator(screenCanvas);
  await expect(canvas).toHaveAttribute("data-connected", "true");
  return {
    canvas,
    observe,
    send: (...colors: string[]) =>
      browser.evaluate((colors) => {
        for (const color of colors)
          Reflect.get(window, "screenFixture").frame(color);
        return null;
      }, colors),
    pixel: () =>
      browser.evaluate((selector) => {
        const context = document
          .querySelector<HTMLCanvasElement>(selector)
          ?.getContext("2d");
        return Array.from(context?.getImageData(0, 0, 1, 1).data ?? []);
      }, screenCanvas),
  };
}

test("a hidden live screen keeps its connection and paints the latest frame on return", async (fixtures) => {
  const { browser } = fixtures;
  const setHidden = await controlScreenVisibility(browser);
  await browser.addInitScript(() => {
    const frames = { decoded: 0 };
    window.createImageBitmap = new Proxy(window.createImageBitmap, {
      apply(target, receiver, args) {
        const [source] = args;
        if (source instanceof Blob && source.type === "image/jpeg")
          frames.decoded++;
        return Reflect.apply(target, receiver, args);
      },
    });
    Object.defineProperty(window, "computerLiveFrames", { value: frames });
  });
  const decoded = () =>
    browser.evaluate(() =>
      Number(Reflect.get(window, "computerLiveFrames").decoded),
    );
  const { canvas, observe, pixel, send } = await openLiveCanvas(fixtures);
  const before = await observe();
  await send("#ff0000");
  await expect.poll(pixel).toEqual([254, 0, 0, 255]);
  await setHidden(true);
  await send("#00ff00", "#0000ff");
  expect(await decoded()).toBe(1);
  expect(await pixel()).toEqual([254, 0, 0, 255]);
  await expect(canvas).toHaveAttribute("data-connected", "true");
  await setHidden(false);
  await expect.poll(pixel).toEqual([0, 0, 254, 255]);
  expect(await decoded()).toBe(2);
  expect(await observe()).toEqual(before);
});

test("a busy live screen decodes only the newest waiting frame and skips the obsolete paint", async (fixtures) => {
  const { browser } = fixtures;
  await browser.addInitScript(() => {
    const decode = window.createImageBitmap.bind(window);
    const pending: (() => void)[] = [];
    window.createImageBitmap = ((source: ImageBitmapSource) => {
      if (!(source instanceof Blob) || source.type !== "image/jpeg")
        return decode(source);
      return new Promise<ImageBitmap>((resolve, reject) => {
        pending.push(() => {
          void decode(source).then(resolve, reject);
        });
      });
    }) as typeof createImageBitmap;
    Object.defineProperty(window, "screenDecodes", { value: pending });
  });
  const { pixel, send } = await openLiveCanvas(fixtures);
  const pending = () =>
    browser.evaluate(() => Number(Reflect.get(window, "screenDecodes").length));
  const finish = (index: number) =>
    browser.evaluate((index) => {
      Reflect.get(window, "screenDecodes")[index]();
      return null;
    }, index);

  await send("#ff0000", "#00ff00", "#0000ff");
  expect(await pending()).toBe(1);
  await finish(0);
  await expect.poll(pending).toBe(2);
  expect(await pixel()).toEqual([0, 0, 0, 0]);
  await finish(1);
  await expect.poll(pixel).toEqual([0, 0, 254, 255]);
  expect(await pending()).toBe(2);
});

test("a hidden preview reads ownership on mount and starts screenshots only on return", async (fixtures) => {
  const setHidden = await controlScreenVisibility(fixtures.browser, true);
  const { state } = await computerConversation(fixtures, {
    status: "ready",
    frame: "frame",
  });
  const image = fixtures.screen.getByRole("img", "What the Bot is looking at", {
    exact: true,
  });
  await expect.poll(state.controlReads).toBeGreaterThan(0);
  await expect(
    fixtures.screen.getByRole("button", "Take control", { exact: true }),
  ).toBeEnabled();
  expect(state.screenshots()).toBe(0);
  await expect(image).toHaveCount(0);
  await setHidden(false);
  await expect(image).toBeVisible();
  expect(state.screenshots()).toBeGreaterThan(0);
});

test("an offscreen preview starts screenshot polling after entering the viewport", async (fixtures) => {
  const { browser, screen } = fixtures;
  await browser.addInitScript(() => {
    document.addEventListener("DOMContentLoaded", () => {
      const style = document.createElement("style");
      style.id = "computer-preview-position";
      style.textContent =
        '[aria-label="Computer sidebar"] figure { transform: translateY(200vh); }';
      document.head.append(style);
    });
  });
  const { state } = await computerConversation(fixtures, {
    status: "ready",
    frame: "frame",
  });
  const panel = screen.getByRole("region", "Computer sidebar", { exact: true });
  const image = panel.getByRole("img", "What the Bot is looking at", {
    exact: true,
  });
  await expect.poll(state.controlReads).toBeGreaterThan(1);
  expect(state.screenshots()).toBe(0);
  await expect(image).toHaveCount(0);

  await browser.evaluate(() => {
    document.getElementById("computer-preview-position")?.remove();
    return null;
  });
  await expect(image).toBeVisible();
  expect(state.screenshots()).toBeGreaterThan(0);
});

test("a screenshot that arrives while the preview is hidden is discarded before decoding", async (fixtures) => {
  const { browser, screen } = fixtures;
  const setHidden = await controlScreenVisibility(browser);
  await browser.addInitScript((data) => {
    const decode = HTMLImageElement.prototype.decode;
    const preloads: string[] = [];
    HTMLImageElement.prototype.decode = function () {
      if (this.src === `data:image/png;base64,${data}`) preloads.push(this.src);
      return decode.call(this);
    };
    Object.defineProperty(window, "computerPreviewPreloads", {
      value: preloads,
    });
  }, screenshot);
  const preloads = () =>
    browser.evaluate(() =>
      Number(Reflect.get(window, "computerPreviewPreloads").length),
    );
  const pending = Promise.withResolvers<void>();
  const { state } = await computerConversation(
    fixtures,
    { status: "ready", frame: "frame" },
    { prepare: (state) => state.delayScreenshots(pending.promise) },
  );
  const image = screen.getByRole("img", "What the Bot is looking at", {
    exact: true,
  });

  try {
    await expect.poll(state.screenshots).toBe(1);
    await setHidden(true);
    pending.resolve();
    await expect.poll(state.framesServed).toBe(1);
    await browser.evaluate(
      () =>
        new Promise<null>((resolve) => {
          requestAnimationFrame(() =>
            requestAnimationFrame(() => resolve(null)),
          );
        }),
    );
    expect(await preloads()).toBe(0);
    expect(state.screenshots()).toBe(1);
    await expect(image).toHaveCount(0);

    await setHidden(false);
    await expect(image).toBeVisible();
    expect(await preloads()).toBeGreaterThan(0);
    expect(state.screenshots()).toBeGreaterThan(1);
  } finally {
    pending.resolve();
  }
});

test("pending Computer takeover survives closing and reopening the full-size screen", async (fixtures) => {
  const { screen } = fixtures;
  const { state } = await computerConversation(
    fixtures,
    { status: "ready", frame: "frame" },
    { terminal: true },
  );
  const pane = screen.getByRole("region", "Computer sidebar", { exact: true });
  const dialog = screen.getByRole("dialog", "The Bot's screen", {
    exact: true,
  });
  const open = pane.getByRole("button", "Open the Bot's screen full size", {
    exact: true,
  });
  const close = dialog.getByRole("button", "Close the Bot's screen", {
    exact: true,
  });
  const sidebarTake = pane.getByRole("button", "Take control", { exact: true });
  const dialogTake = dialog.getByRole("button", "Take control", {
    exact: true,
  });
  const pending = Promise.withResolvers<200>();
  state.respondToTake(pending.promise);
  try {
    await open.click();
    await dialogTake.click();
    await expect
      .poll(() => state.handoffs.map(({ action }) => action))
      .toEqual(["request", "take"]);
    await expect(dialogTake).toBeDisabled();
    await expect(sidebarTake).toBeDisabled();
    await close.click();
    await expect(dialog).toHaveCount(0);
    await expect(sidebarTake).toBeDisabled();
    await open.click();
    await expect(dialogTake).toBeDisabled();

    pending.resolve(200);
    await expect(
      dialog.getByRole("button", "Hand back", { exact: true }),
    ).toBeEnabled();
    await expect(
      pane.getByRole("button", "Hand back", { exact: true }),
    ).toBeEnabled();
    await close.click();
    await pane.getByRole("button", "Hand back", { exact: true }).click();
    await expect(sidebarTake).toBeEnabled();
    await open.click();
    await expect(dialogTake).toBeEnabled();
    expect(state.handoffs).toEqual([
      {
        action: "request",
        body: {
          reason: "I want to take control of the browser.",
          source: "manual",
        },
      },
      { action: "take", body: { requestId: "terminal-handoff" } },
      { action: "release", body: { requestId: "terminal-handoff" } },
    ]);
  } finally {
    pending.resolve(200);
  }
});

test("Computer reports a failed takeover on both screens and clears the error on retry", async (fixtures) => {
  const { screen } = fixtures;
  const { state } = await computerConversation(
    fixtures,
    { status: "ready", frame: "frame" },
    { terminal: true },
  );
  const pane = screen.getByRole("region", "Computer sidebar", { exact: true });
  const dialog = screen.getByRole("dialog", "The Bot's screen", {
    exact: true,
  });
  const error =
    /Control could not be changed\. Check the connection and retry\./;
  await pane
    .getByRole("button", "Open the Bot's screen full size", { exact: true })
    .click();
  state.respondToTake(Promise.resolve(503));
  const take = dialog.getByRole("button", "Take control", { exact: true });
  await take.click();
  await expect(
    dialog.getByRole("alert").filter({ hasText: error }),
  ).toBeVisible();
  await dialog
    .getByRole("button", "Close the Bot's screen", { exact: true })
    .click();
  await expect(
    pane.getByRole("alert").filter({ hasText: error }),
  ).toBeVisible();
  state.respondToTake(Promise.resolve(200));
  await pane.getByRole("button", "Take control", { exact: true }).click();
  await expect(
    dialog.getByRole("button", "Hand back", { exact: true }),
  ).toBeEnabled();
  await expect(
    dialog.getByRole("alert").filter({ hasText: error }),
  ).toHaveCount(0);
  await expect(pane.getByRole("alert").filter({ hasText: error })).toHaveCount(
    0,
  );
  expect(state.handoffs.map(({ action }) => action)).toEqual([
    "request",
    "take",
    "request",
    "take",
  ]);
});

test("Computer disables takeover across both screens while the current action drains", async (fixtures) => {
  const { screen } = fixtures;
  const { state } = await computerConversation(
    fixtures,
    { status: "ready", frame: "frame" },
    {
      terminal: true,
      prepare: (state) => state.setTransitioning(true),
    },
  );
  const pane = screen.getByRole("region", "Computer sidebar", { exact: true });
  const dialog = screen.getByRole("dialog", "The Bot's screen", {
    exact: true,
  });
  await expect(
    pane
      .getByRole("status")
      .filter({ hasText: "Finishing the current action…" }),
  ).toBeVisible();
  await pane
    .getByRole("button", "Open the Bot's screen full size", { exact: true })
    .click();
  await expect(
    dialog
      .getByRole("status")
      .filter({ hasText: "Finishing the current action…" }),
  ).toBeVisible();
  for (const surface of [pane, dialog]) {
    const take = surface.getByRole("button", "Take control", { exact: true });
    await expect(take).toBeDisabled();
    await expect(take).toHaveAttribute("aria-busy", "true");
  }
  expect(state.handoffs).toEqual([]);
  state.setTransitioning(false);
  await expect(
    dialog.getByRole("button", "Take control", { exact: true }),
  ).toBeEnabled();
});

test("the header icon opens Computer once for existing ownership and respects closing it", async (fixtures) => {
  const { screen } = fixtures;
  const { state } = await computerConversation(
    fixtures,
    { status: "ready", frame: "frame" },
    {
      search: "",
      terminal: true,
      prepare: (state) => state.holdForViewer(),
    },
  );
  const pane = screen.getByRole("region", "Computer sidebar", { exact: true });
  const open = screen.getByRole("button", "Open Computer", { exact: true });
  const close = screen.getByRole("button", "Close Computer", { exact: true });
  await expect(
    pane.getByRole("button", "Hand back", { exact: true }),
  ).toBeEnabled();
  await expect(close).toHaveText("");
  await expect(close).toHaveAttribute("aria-expanded", "true");

  await close.click();
  await expect(pane).toHaveCount(0);
  await expect(open).toHaveText("");
  await expect(open).toHaveAttribute("aria-expanded", "false");
  await expect(
    open.getByRole("img", "Needs you", { exact: true }),
  ).toBeVisible();
  const reads = state.controlReads();
  await expect.poll(state.controlReads).toBeGreaterThan(reads);
  await expect(pane).toHaveCount(0);
  await expect(
    screen.getByRole("button", "Hand back", { exact: true }),
  ).toHaveCount(0);
  await expect(
    screen.getByRole("button", "Take control", { exact: true }),
  ).toHaveCount(0);

  await open.click();
  await expect(
    pane.getByRole("button", "Hand back", { exact: true }),
  ).toBeEnabled();
  expect(state.handoffs).toEqual([]);
});

test("the Terminal keeps input through one missed ownership read and pauses after repeated failures", async (fixtures) => {
  const { browser, screen } = fixtures;
  const { state, terminalState } = await computerConversation(
    fixtures,
    { status: "ready", frame: "frame" },
    {
      terminal: true,
      prepare: (state) => state.holdForViewer(),
    },
  );
  if (!terminalState) throw new Error("The terminal socket fixture is missing");
  await screen.getByRole("tab", "Terminal", { exact: true }).click();
  const panel = screen.getByRole("tabpanel", "Terminal", { exact: true });
  const handBack = panel.getByRole("button", "Hand back", { exact: true });
  const problem = panel
    .getByRole("alert")
    .filter({ hasText: "Input is paused." });
  const terminal = browser.locator(".xterm-helper-textarea");
  const sent = async () =>
    (await terminalState.read()).flatMap(({ sent }) =>
      sent.filter(({ type }) => type === "input"),
    );

  await expect(handBack).toBeEnabled();
  await expect(browser.locator(".xterm-rows")).toContainText(
    "hello from the Bot",
  );
  await terminal.focus();
  await browser.keyboard.press("a");
  await expect.poll(sent).toEqual([{ type: "input", data: "a" }]);
  const nextSuccess = Promise.withResolvers<void>();
  state.delaySuccessfulControlReads(nextSuccess.promise);
  state.failControlReads(1);
  await expect.poll(state.failedControlReads).toBe(1);
  const successfulReads = state.successfulControlReads();
  try {
    await expect(handBack).toBeEnabled();
    await expect(problem).toHaveCount(0);
    await browser.keyboard.press("b");
    await expect.poll(sent).toEqual([
      { type: "input", data: "a" },
      { type: "input", data: "b" },
    ]);
  } finally {
    nextSuccess.resolve();
  }
  await expect
    .poll(state.successfulControlReads)
    .toBeGreaterThan(successfulReads);
  const failedReads = state.failedControlReads();
  state.failControlReads(20);
  await expect(problem).toBeVisible();
  await expect
    .poll(state.failedControlReads)
    .toBeGreaterThanOrEqual(failedReads + 2);
  await expect(
    panel.getByRole("button", "Take control", { exact: true }),
  ).toBeDisabled();
  await terminal.focus();
  await browser.keyboard.press("c");
  expect(await sent()).toEqual([
    { type: "input", data: "a" },
    { type: "input", data: "b" },
  ]);

  state.failControlReads(0);
  await expect(handBack).toBeEnabled();
  await expect(problem).toHaveCount(0);
  await terminal.focus();
  await browser.keyboard.press("d");
  await expect.poll(sent).toEqual([
    { type: "input", data: "a" },
    { type: "input", data: "b" },
    { type: "input", data: "d" },
  ]);
  expect(state.handoffs).toEqual([]);
});

test("unchanged ownership polls do not commit either control again", async ({
  app,
  browser,
  screen,
}) => {
  const computerId = "steady-ownership-fixture";
  await app.open("/bots");
  const viewer = await readComputerViewer(browser);
  const state = await serveComputer(
    browser,
    computerId,
    { status: "ready", frame: "frame" },
    viewer,
  );
  state.holdForViewer();
  await app.open(`/tests/browser/computer-control.html?computer=${computerId}`);
  const controls = ["Preview controls", "Viewer controls"].map((label) =>
    screen.getByRole("region", label, { exact: true }),
  );
  for (const region of controls) {
    await expect(
      region.getByRole("button", "Hand back", { exact: true }),
    ).toBeEnabled();
  }
  const firstStableRead = state.successfulControlReads();
  await expect
    .poll(state.successfulControlReads)
    .toBeGreaterThan(firstStableRead);
  const commits = () =>
    Promise.all(controls.map((region) => region.getAttribute("data-commits")));
  const baseline = await commits();
  for (const count of baseline) expect(Number(count)).toBeGreaterThan(0);
  const reads = state.successfulControlReads();
  await expect
    .poll(state.successfulControlReads)
    .toBeGreaterThanOrEqual(reads + 3);
  expect(await commits()).toEqual(baseline);
});

test("command cards in the transcript and Activity show the same terminal output and exit status", async (fixtures) => {
  const { browser, screen } = fixtures;
  const command = "printf '%s\\n' {1..12}";
  const failed = "test -f missing-report.txt";
  const output = Array.from(
    { length: 12 },
    (_, line) => `Output line ${line + 1}`,
  ).join("\n");
  const history = [
    { id: "terminal-question", role: "user", content: "Check today's report." },
    ...computerStep(
      "long-output",
      "computer_run_command",
      { command },
      { ok: true, stdout: output, exitCode: 0 },
    ),
    ...computerStep(
      "missing-report",
      "computer_run_command",
      { command: failed },
      { ok: true, exitCode: 1 },
    ),
    {
      id: "terminal-reply",
      role: "assistant",
      content: "The report file is missing.",
    },
  ];
  await computerConversation(
    fixtures,
    { status: "ready", frame: "frame" },
    { history, terminal: true },
  );
  const messages = screen.getByRole("region", "Messages", { exact: true });
  const pane = screen.getByRole("region", "Computer sidebar", { exact: true });
  for (const surface of [messages, pane]) {
    await expect(surface.getByText(failed, { exact: true })).toBeVisible();
    await expect(surface.getByText("Exit 1", { exact: true })).toBeVisible();
    await expect(surface.getByText("Exit 0", { exact: true })).toBeVisible();
    await expect(surface.getByText(/8 earlier lines/)).toBeVisible();
    await expect(surface).toContainText("Output line 12");
    await expect(surface).not.toContainText(/Output line 1\b|didn't work/i);
    const expand = surface.getByRole("button", "Show all 12 lines", {
      exact: true,
    });
    await expect(expand).toHaveAttribute("aria-expanded", "false");
    await expand.click();
    await expect(
      surface.getByRole("button", "Show less", { exact: true }),
    ).toHaveAttribute("aria-expanded", "true");
    await expect(surface).toContainText(/Output line 1\s+Output line 2/);
  }
  const terminalBodies = await browser.evaluate((text) => {
    const records = [...document.querySelectorAll("section button")].filter(
      (button) =>
        button.querySelector("pre") && button.textContent?.includes(text),
    );
    return records.map((button) => ({
      background: button.parentElement
        ? getComputedStyle(button.parentElement).backgroundColor
        : null,
      prompt:
        button.querySelector('span[aria-hidden="true"]')?.textContent ?? "",
      output: button.querySelector("pre")?.textContent ?? "",
    }));
  }, command);
  expect(terminalBodies).toEqual(
    Array.from({ length: 2 }, () => ({
      background: "rgb(11, 10, 16)",
      prompt: "$",
      output,
    })),
  );

  const screenTab = pane.getByRole("tab", "Screen", { exact: true });
  await screenTab.click();
  await expect(screenTab).toHaveAttribute("aria-selected", "true");
  await messages.getByRole("button", { name: /printf/ }).click();
  await expect(
    pane.getByRole("tab", "Terminal", { exact: true }),
  ).toHaveAttribute("aria-selected", "true");
  await expect(
    pane.getByRole("region", "The Bot's terminal", { exact: true }),
  ).toBeVisible();
});

test("a streamed command changes from Running to Blocked without claiming an exit code", async (fixtures) => {
  const { browser, screen } = fixtures;
  await computerConversation(
    fixtures,
    { status: "ready", frame: "frame" },
    { terminal: true },
  );
  const command = "cat restricted-report.txt";
  const reason = "An admin's rule doesn't allow this file.";
  const toolCallId = "blocked-command";
  using stream = await stageChatRun(
    browser,
    ({ threadId, runId }) => [
      { type: "RUN_STARTED", threadId, runId },
      {
        type: "TOOL_CALL_START",
        toolCallId,
        toolCallName: "computer_run_command",
        parentMessageId: "command-step",
      },
      {
        type: "TOOL_CALL_ARGS",
        toolCallId,
        delta: JSON.stringify({ command }),
      },
    ],
    ({ threadId, runId }) => [
      { type: "TOOL_CALL_END", toolCallId },
      {
        type: "TOOL_CALL_RESULT",
        toolCallId,
        role: "tool",
        messageId: "command-result",
        content: JSON.stringify({ ok: false, refused: true, reason }),
      },
      { type: "RUN_FINISHED", threadId, runId },
    ],
  );
  await screen
    .getByRole("textbox", "Message", { exact: true })
    .fill("Read the approved parts of the report.");
  await screen.getByRole("button", "Send message", { exact: true }).click();
  const card = screen
    .getByRole("region", "Messages", { exact: true })
    .getByRole("region", "Ran a command", { exact: true });
  await expect(card.getByText("Running", { exact: true })).toBeVisible();
  await expect(card.getByText(command, { exact: true })).toBeVisible();
  await expect(card).not.toContainText(/Exit \d|It printed nothing/);
  stream.finish();
  await expect(card.getByText("Running", { exact: true })).toHaveCount(0);
  await expect(card.getByText("Blocked", { exact: true })).toBeVisible();
  await expect(card.getByText(reason, { exact: true })).toBeVisible();
  await expect(card).not.toContainText(/Exit \d|It printed nothing/);
});

test("computer preview visibility uses the latest entry of each observer batch", async ({
  app,
  browser,
  screen,
}) => {
  await browser.addInitScript(() => {
    class BrowserBatchObserver extends IntersectionObserver {
      constructor(
        callback: IntersectionObserverCallback,
        options?: IntersectionObserverInit,
      ) {
        super(() => {}, options);
        const deliver = (visibility: boolean[]) => {
          const target = document.querySelector(
            '[data-preview-ref="observed"]',
          );
          if (!target) throw new Error("Missing observed figure");
          const rect = target.getBoundingClientRect();
          callback(
            visibility.map((isIntersecting) => ({
              boundingClientRect: rect,
              intersectionRatio: isIntersecting ? 1 : 0,
              intersectionRect: isIntersecting ? rect : new DOMRectReadOnly(),
              isIntersecting,
              rootBounds: null,
              target,
              time: performance.now(),
            })),
            this,
          );
        };
        Object.defineProperty(window, "deliverPreviewVisibility", {
          value: deliver,
          configurable: true,
        });
      }
    }
    window.IntersectionObserver = BrowserBatchObserver;
  });
  await app.open("/tests/browser/preview-visibility.html");
  const indicator = screen.getByRole("status", "Preview observation", {
    exact: true,
  });
  await expect(indicator).toHaveText("Hidden");
  await expect
    .poll(() =>
      browser.evaluate(
        () => typeof Reflect.get(window, "deliverPreviewVisibility"),
      ),
    )
    .toBe("function");
  for (const [batch, expected] of [
    [[false, true], "Visible"],
    [[true, false], "Hidden"],
  ] as const) {
    await browser.evaluate(
      (entries) => {
        Reflect.get(window, "deliverPreviewVisibility")(entries);
        return null;
      },
      [...batch],
    );
    await expect(indicator).toHaveText(expected);
  }
});
