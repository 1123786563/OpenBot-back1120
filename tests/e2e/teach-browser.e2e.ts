import { type Browser, test } from "@e2e-dev/web";
import { expect, type TestFixtures } from "e2e";
import type {
  LearningRunSummary,
  PersonalReview,
  RecordingSkills,
} from "../../shared/learning";
import {
  type BrowserApiState,
  type BrowserOpenResponse,
  type BrowserWindow,
  browserApiPaths,
  browserNarrationRequestSchema,
  browserRecordingRequestSchema,
  browserTabsRequestSchema,
  type LauncherState,
} from "../../shared/openbot-browser";
import {
  type RecorderActivity,
  type RecordingRow,
  recorderPaths,
} from "../../shared/recorder-api";
import { observeLiveScreen } from "./browser-screen-stream";
import {
  serveNarrationPreference,
  simulateBrowserSpeech,
} from "./teach-browser-speech";

const page = "/browser";
const title = "Teach a Bot";
const computerId = `person-${"ab12".repeat(8)}`;
const liveScreen =
  "Your browser. Click it to type into it, and press Escape to leave it.";
const opening = "Opening your browser…";
const label = "Recording: Submit the receipt";
const recorded = "Refund an order";
const row: RecordingRow = {
  id: "recording-1",
  title: recorded,
  recordedAt: "2026-11-02T14:30:00.000Z",
  ended: "succeeded",
  reason: null,
};
const site = {
  id: "tab-1",
  url: "https://example.com/",
  title: "Example Domain",
  active: true,
};
const blank = {
  id: "tab-2",
  url: "about:blank",
  title: "about:blank",
  active: true,
};

function closed(shows?: BrowserWindow): BrowserApiState {
  return {
    available: true,
    ...(shows ? { shows } : {}),
    computerId,
    open: false,
    tabs: [],
  };
}

function opened(shows: BrowserWindow): BrowserApiState {
  return {
    ...closed(shows),
    open: true,
    window: shows,
    browser: shows === "native" ? "chrome" : "chromium",
    narration: shows === "native" ? "own" : "external",
    recorder: {
      connected: true,
      phase: "idle",
      actions: 0,
      narration: shows === "native" ? "own" : "external",
    },
    tabs: shows === "screen" ? [site] : [],
  };
}

function activity(phase: LauncherState["phase"]): RecorderActivity {
  return {
    phase,
    recordingId: "rec-1",
    title: "Submit the receipt",
    startedAt: Date.now() - 83_000,
    actions: 4,
  };
}

function recording(
  phase: LauncherState["phase"],
  shows: BrowserWindow = "native",
): BrowserApiState {
  const state = opened(shows);
  const current = activity(phase);
  return {
    ...state,
    recorder: {
      connected: true,
      ...current,
      narration: shows === "native" ? "own" : "external",
      ...(shows === "native" ? { voice: "listening" } : {}),
    },
    activity: current,
  };
}

async function serveTeachBrowser(
  browser: Browser,
  {
    state = closed("native"),
    failState = false,
    holdState,
    holdOpen,
    refuseOpen,
    holdRecordings,
    rows = [],
    recordingResult,
    rejectRecording,
    rejectTabClose,
    rejectNarration,
    learning,
  }: {
    state?: BrowserApiState;
    failState?: boolean;
    holdState?: Promise<void>;
    holdOpen?: Promise<void>;
    refuseOpen?: string;
    holdRecordings?: Promise<void>;
    rows?: RecordingRow[];
    recordingResult?: {
      actions: number;
      phrases: number;
      lateActions?: number;
    };
    rejectRecording?: Partial<{ start: string; stop: string }>;
    rejectTabClose?: string;
    rejectNarration?: string;
    learning?: RecordingLearningOptions;
  } = {},
) {
  const writes: {
    path: string;
    method: string;
    body: unknown;
    from?: string;
  }[] = [];
  let stateReads = 0;
  let recordingsReads = 0;
  let phrasesPosted = 0;
  await browser.route(/\/api\/browser(?:\/[^?#]*)?$/, async (route) => {
    const request = route.request;
    const { pathname } = new URL(request.url);
    if (pathname === browserApiPaths.state && request.method === "GET") {
      stateReads++;
      await holdState;
      return failState
        ? route.fulfill({ status: 500, json: { error: "Unavailable" } })
        : route.fulfill({
            contentType: "application/json",
            body: JSON.stringify(state),
          });
    }
    const body: unknown = request.postData
      ? JSON.parse(request.postData)
      : null;
    writes.push({
      path: pathname,
      method: request.method,
      body,
      ...(request.headers.referer
        ? { from: new URL(request.headers.referer).pathname }
        : {}),
    });
    if (pathname === browserApiPaths.open) {
      await holdOpen;
      if (refuseOpen) {
        const error = refuseOpen;
        refuseOpen = undefined;
        return route.fulfill({ status: 409, json: { error } });
      }
      const window = state.shows ?? "native";
      if (recordingResult && !state.open) state = { ...state, open: true };
      const answer = {
        ok: true,
        computerId,
        window,
        browser: window === "native" ? "chrome" : "chromium",
        narration: window === "native" ? "own" : "external",
      } satisfies BrowserOpenResponse;
      return route.fulfill({ json: answer });
    }
    if (pathname === browserApiPaths.recording && request.method === "POST") {
      const recordingRequest = browserRecordingRequestSchema.safeParse(body);
      if (!recordingRequest.success || !state.open || !state.recorder) {
        return route.fulfill({
          status: 400,
          json: { error: "Invalid recording request" },
        });
      }
      const data = recordingRequest.data;
      const error = rejectRecording?.[data.action];
      if (error) return route.fulfill({ status: 409, json: { error } });
      if (recordingResult) {
        if (data.action === "start") phrasesPosted = 0;
        state = {
          ...state,
          recorder:
            data.action === "start"
              ? {
                  ...state.recorder,
                  connected: true,
                  phase: "recording",
                  recordingId: "recording-1",
                  title: data.title,
                  startedAt: Date.now() - 42_000,
                  actions: recordingResult.actions,
                }
              : {
                  connected: true,
                  phase: "idle",
                  actions: 0,
                  narration: state.recorder.narration,
                  lastStopped: {
                    recordingId: state.recorder.recordingId ?? "recording-1",
                    title: state.recorder.title ?? "",
                    stoppedAt: Date.now(),
                    actions:
                      recordingResult.lateActions ?? state.recorder.actions,
                    phrases: recordingResult.phrases + phrasesPosted,
                  },
                },
        };
        return route.fulfill({ json: state });
      }
    }
    if (pathname === browserApiPaths.narration && request.method === "POST") {
      const narration = browserNarrationRequestSchema.safeParse(body);
      if (!narration.success)
        return route.fulfill({
          status: 400,
          json: { error: "Invalid narration request" },
        });
      if (rejectNarration)
        return route.fulfill({ status: 409, json: { error: rejectNarration } });
      if ("text" in narration.data) phrasesPosted++;
      return route.fulfill({ json: { ok: true } });
    }
    if (pathname === browserApiPaths.tabs && request.method === "POST") {
      const tabsRequest = browserTabsRequestSchema.safeParse(body);
      if (tabsRequest.success && tabsRequest.data.action === "new") {
        state = {
          ...state,
          tabs: [
            ...state.tabs.map((tab) => ({ ...tab, active: false })),
            { ...blank, id: "tab-new" },
          ],
        };
        return route.fulfill({ json: state });
      }
      if (tabsRequest.success && tabsRequest.data.action === "activate") {
        const { tabId } = tabsRequest.data;
        state = {
          ...state,
          tabs: state.tabs.map((tab) => ({ ...tab, active: tab.id === tabId })),
        };
        return route.fulfill({ json: state });
      }
      if (tabsRequest.success && tabsRequest.data.action === "close") {
        if (rejectTabClose)
          return route.fulfill({
            status: 409,
            json: { error: rejectTabClose },
          });
        const { tabId } = tabsRequest.data;
        const remaining = state.tabs.filter((tab) => tab.id !== tabId);
        const active =
          remaining.find((tab) => tab.active)?.id ?? remaining.at(-1)?.id;
        state = {
          ...state,
          tabs: remaining.map((tab) => ({ ...tab, active: tab.id === active })),
        };
        return route.fulfill({ json: state });
      }
    }
    if (
      pathname === browserApiPaths.clear &&
      request.method === "POST" &&
      !request.postData
    ) {
      state = { ...opened("screen"), tabs: [{ ...blank, id: "tab-fresh" }] };
      return route.fulfill({ json: state });
    }
    if (pathname === browserApiPaths.navigate) {
      return route.fulfill({
        contentType: "application/json",
        body: JSON.stringify(state),
      });
    }
    return route.fulfill({
      status: 404,
      json: { error: "Unexpected browser request" },
    });
  });
  const learningRequests = await serveRecordingLearning(browser, learning);
  await browser.route(
    /\/api\/recorder\/recordings(?:\?[^#]*)?$/,
    async (route) => {
      const { pathname } = new URL(route.request.url);
      if (pathname !== recorderPaths.recordings) return route.continue();
      recordingsReads++;
      await holdRecordings;
      return route.fulfill({ json: { recordings: rows, nextCursor: null } });
    },
  );
  return {
    writes,
    learningRequests,
    stateReads: () => stateReads,
    recordingsReads: () => recordingsReads,
    setState(next: BrowserApiState) {
      state = next;
    },
    setRows(next: RecordingRow[]) {
      rows = next;
    },
  };
}

for (const shows of ["native", "screen", undefined] as const) {
  test(`Teach a Bot is a keyboard-operable link with ${shows ?? "legacy"} browser state`, async ({
    app,
    browser,
    screen,
  }) => {
    const { writes } = await serveTeachBrowser(browser, {
      state: closed(shows),
    });
    await app.open("/");
    const link = screen.getByRole("link", title, { exact: true });
    const heading = screen.getByRole("heading", title, {
      exact: true,
      level: 1,
    });
    await expect(link).toHaveAttribute("href", page);
    await expect(
      screen.getByRole("button", title, { exact: true }),
    ).toHaveCount(0);
    expect(writes).toEqual([]);

    await link.click();
    await expect(browser).toHaveURL(page);
    await expect(heading).toBeVisible();
    const entries = shows === "native" ? 0 : 1;
    await expect.poll(() => writes.length).toBe(entries);
    expect(writes).toEqual(
      shows === "native"
        ? []
        : [
            {
              path: browserApiPaths.open,
              method: "POST",
              body: null,
              from: page,
            },
          ],
    );

    await browser.back();
    await expect(browser).toHaveURL("/");
    await link.press("Enter");
    await expect(browser).toHaveURL(page);
    await expect(heading).toBeVisible();
    await expect.poll(() => writes.length).toBe(entries * 2);
    expect(
      writes.every(
        ({ path, from }) => path === browserApiPaths.open && from === page,
      ),
    ).toBe(true);
  });
}

for (const failState of [false, true]) {
  test(`the sidebar hides Teach a Bot when browser access ${failState ? "cannot be read" : "is unavailable"}`, async ({
    app,
    browser,
    screen,
  }) => {
    const { stateReads, writes } = await serveTeachBrowser(browser, {
      state: { ...closed(), available: false },
      failState,
    });
    await app.open("/");
    await expect(screen.getByRole("textbox", "Message")).toBeVisible();
    await expect.poll(stateReads).toBe(failState ? 2 : 1);
    await expect(screen.getByRole("link", title, { exact: true })).toHaveCount(
      0,
    );
    expect(writes).toEqual([]);
  });
}

for (const shows of ["native", "screen"] as const) {
  test(`the sidebar follows starting, recording and stopping for an open ${shows} browser`, async ({
    app,
    browser,
    screen,
  }) => {
    const { stateReads, setState, writes } = await serveTeachBrowser(browser, {
      state: opened(shows),
    });
    await app.open("/");
    const link = screen.getByRole("link", /^Teach a Bot/);
    const dot = link.getByRole("img", /^Recording:/);
    await expect(link).toBeVisible();
    await expect(dot).toHaveCount(0);
    const before = stateReads();
    setState(recording("starting", shows));
    await expect(
      link.getByRole("img", `${label}, starting`, { exact: true }),
    ).toBeVisible({ timeout: 2500 });
    setState(recording("recording", shows));
    await expect(
      screen.getByRole(
        "link",
        /^Teach a Bot Recording: Submit the receipt, 1:2\d$/,
      ),
    ).toBeVisible({ timeout: 2500 });
    const live = link.getByRole(
      "img",
      /^Recording: Submit the receipt, 1:2\d$/,
    );
    await expect(live).toBeVisible();
    await expect(
      browser.locator(
        '[role="img"][aria-label^="Recording: Submit the receipt"] .bg-destructive',
      ),
    ).toBeVisible();
    await link.hover();
    await expect(browser.locator('[data-slot="tooltip-content"]')).toHaveText(
      /^Recording: Submit the receipt, 1:[23]\d$/,
    );
    expect(stateReads()).toBeGreaterThan(before);
    setState(recording("stopping", shows));
    await expect(
      link.getByRole("img", `${label}, stopping`, { exact: true }),
    ).toBeVisible({ timeout: 2500 });
    setState(opened(shows));
    await expect(dot).toHaveCount(0, { timeout: 2500 });
    await expect(
      screen.getByRole("link", title, { exact: true }),
    ).toBeVisible();
    expect(writes).toEqual([]);
  });
}

test("the sidebar follows an everyday Recorder without opening an OpenBot browser", async ({
  app,
  browser,
  screen,
}) => {
  const { stateReads, setState, writes } = await serveTeachBrowser(browser, {
    state: { ...closed("native"), activity: activity("recording") },
  });
  await app.open("/");
  const link = screen.getByRole("link", /^Teach a Bot/);
  await expect(
    link.getByRole("img", /^Recording: Submit the receipt, 1:2\d$/),
  ).toBeVisible();
  const before = stateReads();
  setState(closed("native"));
  await expect(link.getByRole("img", /^Recording:/)).toHaveCount(0, {
    timeout: 2500,
  });
  expect(stateReads()).toBeGreaterThan(before);
  expect(writes).toEqual([]);
});

test("a browser recorder report alone does not show sidebar activity", async ({
  app,
  browser,
  screen,
}) => {
  const { activity: _activity, ...state } = recording("recording");
  const { stateReads } = await serveTeachBrowser(browser, { state });
  await app.open("/");
  const link = screen.getByRole("link", title, { exact: true });
  await expect(link).toBeVisible();
  await expect.poll(stateReads).toBeGreaterThan(1);
  await expect(link.getByRole("img", /^Recording:/)).toHaveCount(0);
});

for (const note of [undefined, "No browser here."]) {
  test(`Teach a Bot keeps recordings available when no browser is configured${note ? " and the server explains why" : ""}`, async ({
    app,
    browser,
    screen,
  }) => {
    const { writes } = await serveTeachBrowser(browser, {
      state: { ...closed(), available: false, ...(note ? { note } : {}) },
      rows: [row],
    });
    await app.open(page);
    await expect(
      screen.getByText(
        note ?? "OpenBot isn't set up to run a browser for you. Ask an admin.",
        { exact: true },
      ),
    ).toBeVisible();
    await expect(
      screen.getByRole("heading", "Your recordings", { exact: true }),
    ).toBeVisible();
    await expect(screen.getByText(recorded, { exact: true })).toBeVisible();
    expect(writes).toEqual([]);
  });
}

test("the hosted browser opens once, keeps recordings below it and links to Learning", async ({
  app,
  browser,
  screen,
}) => {
  const launch = Promise.withResolvers<void>();
  const listing = Promise.withResolvers<void>();
  const { recordingsReads, writes } = await serveTeachBrowser(browser, {
    state: opened("screen"),
    holdOpen: launch.promise,
    holdRecordings: listing.promise,
    rows: [row],
  });
  const embedded = screen.getByLabel(liveScreen, { exact: true });
  const strip = browser.locator('[data-slot="recordings-strip"]');
  try {
    await app.open(page);
    await expect(
      screen.getByRole("heading", title, { exact: true, level: 1 }),
    ).toBeVisible();
    await expect(screen.getByRole("heading", /./, { level: 1 })).toHaveCount(1);
    await expect(
      screen.getByText(
        "Show your Bots how to do a task. Press Record, name the task, and do it once in the browser.",
        { exact: true },
      ),
    ).toBeVisible();
    await expect(screen.getByText(opening, { exact: true })).toBeVisible();
    await expect(screen.getByText(/Start recording/)).toHaveCount(0);
    await expect(embedded).toHaveCount(0);
    await expect(
      screen.getByRole("button", "Record", { exact: true }),
    ).toHaveCount(0);
    await expect(
      screen.getByRole("textbox", "Address", { exact: true }),
    ).toHaveCount(0);
    await expect.poll(() => writes.length).toBe(1);
    await expect.poll(recordingsReads).toBeGreaterThan(0);
    await expect(strip).toHaveCount(0);
    launch.resolve();
    await expect(embedded).toBeVisible();
    await expect(
      screen.getByRole("button", "Record", { exact: true }),
    ).toBeVisible();
    await expect(screen.getByText(opening, { exact: true })).toHaveCount(0);
    await expect(
      screen.getByRole("textbox", "Search or go to a site", { exact: true }),
    ).toHaveCount(0);
    await expect(strip).toHaveCount(0);
  } finally {
    launch.resolve();
    listing.resolve();
  }
  await expect(strip.getByText(recorded, { exact: true })).toBeVisible();
  const layout = await browser.evaluate((label) => {
    const strip = document.querySelector('[data-slot="recordings-strip"]');
    const live = Array.from(document.querySelectorAll("[aria-label]")).find(
      (node) => node.getAttribute("aria-label") === label,
    );
    return strip && live
      ? {
          below: Boolean(
            live.compareDocumentPosition(strip) &
              Node.DOCUMENT_POSITION_FOLLOWING,
          ),
          overflowY: getComputedStyle(strip).overflowY,
        }
      : null;
  }, liveScreen);
  expect(layout).toEqual({ below: true, overflowY: "auto" });
  const learn = screen.getByRole("link", "See what your Bots learned", {
    exact: true,
  });
  await expect(learn).toHaveAttribute("href", "/settings/learning");
  await expect(screen.getByRole("switch", /automatically/i)).toHaveCount(0);
  expect(writes).toEqual([
    { path: browserApiPaths.open, method: "POST", body: null, from: page },
  ]);
});

test("the hosted browser shows its empty recordings strip only after the list responds", async ({
  app,
  browser,
  screen,
}) => {
  const { promise, resolve } = Promise.withResolvers<void>();
  const { recordingsReads } = await serveTeachBrowser(browser, {
    state: opened("screen"),
    holdRecordings: promise,
  });
  const strip = browser.locator('[data-slot="recordings-strip"]');
  try {
    await app.open(page);
    await expect(screen.getByLabel(liveScreen, { exact: true })).toBeVisible();
    await expect.poll(recordingsReads).toBeGreaterThan(0);
    await expect(strip).toHaveCount(0);
  } finally {
    resolve();
  }
  await expect(strip.getByText(/No recordings yet/)).toBeVisible();
});

test("a Recorder bookmark shows the list without launching the hosted browser", async ({
  app,
  browser,
  screen,
}) => {
  const { writes } = await serveTeachBrowser(browser, {
    state: opened("screen"),
    rows: [row],
  });
  await app.open(`${page}?recordings=1`);
  await expect(screen.getByText(recorded, { exact: true })).toBeVisible();
  expect(writes).toEqual([]);
  await screen.getByRole("button", "Open browser", { exact: true }).click();
  await expect(screen.getByLabel(liveScreen, { exact: true })).toBeVisible();
  expect(writes).toEqual([
    { path: browserApiPaths.open, method: "POST", body: null, from: page },
  ]);
});

test("an empty hosted tab submits a normalized address and clears the start field", async ({
  app,
  browser,
  screen,
}) => {
  const { writes } = await serveTeachBrowser(browser, {
    state: { ...opened("screen"), tabs: [blank] },
  });
  await app.open(page);
  const address = screen.getByRole("textbox", "Search or go to a site", {
    exact: true,
  });
  await address.fill("openbot.ai");
  await address.press("Enter");
  await expect
    .poll(() => writes.filter(({ path }) => path === browserApiPaths.navigate))
    .toEqual([
      {
        path: browserApiPaths.navigate,
        method: "POST",
        body: { url: "https://openbot.ai" },
        from: page,
      },
    ]);
  await expect(address).toHaveValue("");
});

test("Teach a Bot waits for Desktop state and shows the form without launching a browser", async ({
  app,
  browser,
  screen,
}) => {
  const { promise, resolve } = Promise.withResolvers<void>();
  const { stateReads, writes } = await serveTeachBrowser(browser, {
    state: closed("native"),
    holdState: promise,
  });
  const heading = screen.getByRole("heading", title, { exact: true, level: 1 });
  try {
    await app.open(page);
    await expect.poll(stateReads).toBeGreaterThan(0);
    await expect(heading).toHaveCount(0);
    await expect(screen.getByText(opening, { exact: true })).toHaveCount(0);
  } finally {
    resolve();
  }
  await expect(heading).toBeVisible();
  await screen.getByRole("button", "Continue", { exact: true }).click();
  await expect(
    screen.getByRole("textbox", "Task name", { exact: true }),
  ).toBeVisible();
  await expect(
    screen.getByRole("switch", "Narration", { exact: true }),
  ).toBeVisible();
  await expect(screen.getByText(opening, { exact: true })).toHaveCount(0);
  await expect(screen.getByLabel(liveScreen, { exact: true })).toHaveCount(0);
  expect(writes).toEqual([]);
});

test("stopping a native recording refreshes Your recordings without reloading the page", async ({
  app,
  browser,
  screen,
}) => {
  const { setState, setRows, recordingsReads, writes } =
    await serveTeachBrowser(browser, {
      state: recording("recording"),
    });
  await app.open(page);
  await expect(
    screen.getByRole("heading", title, { exact: true, level: 1 }),
  ).toBeVisible();
  await expect(screen.getByText(/No recordings yet/)).toBeVisible();
  const before = recordingsReads();
  setRows([row]);
  setState(opened("native"));
  await expect(screen.getByText(recorded, { exact: true })).toBeVisible();
  expect(recordingsReads()).toBeGreaterThan(before);
  await expect(screen.getByText(/No recordings yet/)).toHaveCount(0);
  expect(writes).toEqual([]);
});

const notAnswering = "Your browser isn't answering. OpenBot will keep trying.";

test("a hosted launch refusal displays one server error and can be retried", async ({
  app,
  browser,
  screen,
}) => {
  const { writes, setState } = await serveTeachBrowser(browser, {
    state: { ...closed("screen"), problem: notAnswering },
    refuseOpen: notAnswering,
  });
  await app.open(page);
  const error = screen.getByText(notAnswering, { exact: true });
  const retry = screen.getByRole("button", "Try again", { exact: true });
  const write = {
    path: browserApiPaths.open,
    method: "POST",
    body: null,
    from: page,
  };
  await expect(error).toBeVisible();
  await expect(error).toHaveCount(1);
  await expect(retry).toBeEnabled();
  expect(writes).toEqual([write]);
  setState(opened("screen"));
  await retry.click();
  await expect(screen.getByLabel(liveScreen, { exact: true })).toBeVisible();
  await expect(error).toHaveCount(0);
  expect(writes).toEqual([write, write]);
});

test("a Desktop browser that is not answering reports the server's message", async ({
  app,
  browser,
  screen,
}) => {
  const { writes } = await serveTeachBrowser(browser, {
    state: { ...closed("native"), problem: notAnswering },
  });
  await app.open(page);
  await expect(
    screen.getByRole("alert").filter({ hasText: notAnswering }),
  ).toBeVisible();
  expect(writes).toEqual([]);
});

test("the hosted screen reports a disconnected browser and recovers without reopening it", async ({
  app,
  browser,
  screen,
}) => {
  const { setState, writes } = await serveTeachBrowser(browser, {
    state: opened("screen"),
  });
  await app.open(page);
  const embedded = screen.getByLabel(liveScreen, { exact: true });
  const error = screen.getByText(notAnswering, { exact: true });
  await expect(embedded).toBeVisible();
  setState({ ...closed("screen"), problem: notAnswering });
  await expect(error).toBeVisible();
  await expect(embedded).toHaveCount(0);
  await expect(screen.getByText("Your browser is closed.")).toHaveCount(0);
  await expect(screen.getByRole("button", "Open it again")).toHaveCount(0);
  setState(opened("screen"));
  await expect(embedded).toBeVisible();
  await expect(error).toHaveCount(0);
  expect(writes).toEqual([
    { path: browserApiPaths.open, method: "POST", body: null, from: page },
  ]);
});

test("opening a hosted tab selects it and focuses the address field", async ({
  app,
  browser,
  screen,
}) => {
  const { writes } = await serveTeachBrowser(browser, {
    state: { ...opened("screen"), tabs: [site, { ...blank, active: false }] },
  });
  await app.open(page);
  const tabs = screen.getByRole("tablist", "Tabs", { exact: true });
  await expect(tabs.getByRole("tab")).toHaveCount(2);
  await screen.getByRole("button", "New tab", { exact: true }).click();
  await expect(tabs.getByRole("tab")).toHaveCount(3);
  await expect(
    tabs.getByRole("tab", "New tab", { exact: true, selected: true }),
  ).toBeVisible();
  await expect(tabs.getByRole("tab", /./, { selected: false })).toHaveCount(2);
  await expect(
    screen.getByRole("textbox", "Address", { exact: true }),
  ).toBeFocused();
  expect(writes).toEqual([
    { path: browserApiPaths.open, method: "POST", body: null, from: page },
    {
      path: browserApiPaths.tabs,
      method: "POST",
      body: { action: "new" },
      from: page,
    },
  ]);
});

test("clearing hosted browser data requires confirmation and opens a fresh tab", async ({
  app,
  browser,
  screen,
}) => {
  const { writes } = await serveTeachBrowser(browser, {
    state: { ...opened("screen"), tabs: [site, { ...blank, active: false }] },
  });
  await app.open(page);
  const tabs = screen.getByRole("tablist", "Tabs", { exact: true });
  const original = tabs.getByRole("tab", "Example Domain", { exact: true });
  const clear = screen.getByRole("button", "Clear browser data", {
    exact: true,
  });
  const dialog = screen.getByRole("dialog", "Clear this browser?", {
    exact: true,
  });
  await expect(original).toBeVisible();
  await expect(tabs.getByRole("tab")).toHaveCount(2);
  await clear.click();
  await expect(
    dialog.getByText(
      "Cookies, saved passwords and history are wiped. You'll have to sign in everywhere again.",
      { exact: true },
    ),
  ).toBeVisible();
  await dialog.getByRole("button", "Cancel", { exact: true }).click();
  await expect(dialog).toHaveCount(0);
  await expect(original).toBeVisible();
  await expect(tabs.getByRole("tab")).toHaveCount(2);
  const open = {
    path: browserApiPaths.open,
    method: "POST",
    body: null,
    from: page,
  };
  expect(writes).toEqual([open]);
  await clear.click();
  await dialog.getByRole("button", "Clear", { exact: true }).click();
  await expect(dialog).toHaveCount(0);
  await expect(tabs.getByRole("tab")).toHaveCount(1);
  await expect(
    tabs.getByRole("tab", "New tab", { exact: true, selected: true }),
  ).toBeVisible();
  await expect(
    screen.getByRole("textbox", "Address", { exact: true }),
  ).toHaveValue("");
  await expect(
    screen.getByText("Browser cleared", { exact: true }),
  ).toBeVisible();
  expect(writes).toEqual([
    open,
    { path: browserApiPaths.clear, method: "POST", body: null, from: page },
  ]);
});

const task = "Submit an expense report";
const emptyExplanation =
  "The Recorder records the pages you open on websites and what you do there, with what each step saves, AI assistant conversations and your narration, in every tab you use while it records, except sites you leave out.";

async function nameRecording(
  screen: TestFixtures["screen"],
  shape: BrowserWindow,
  { narration = true }: { narration?: boolean } = {},
) {
  if (shape === "native") {
    await screen.getByRole("button", "Continue", { exact: true }).click();
  } else {
    const record = screen.getByRole("button", "Record", { exact: true });
    await expect(record).toBeVisible();
    await expect(record).toHaveCount(1);
    await expect(screen.getByRole("textbox", "Task name")).toHaveCount(0);
    await expect(
      screen.getByRole("switch", "Narration", { exact: true }),
    ).toHaveCount(0);
    await record.click();
  }
  const name = screen.getByRole("textbox", "Task name", { exact: true });
  const next = screen.getByRole(
    "button",
    shape === "native" ? "Continue" : "Start recording",
    { exact: true },
  );
  await expect(next).toBeDisabled();
  const toggle = screen.getByRole("switch", "Narration", { exact: true });
  if (narration) await expect(toggle).toBeVisible();
  else await expect(toggle).toHaveCount(0);
  if (shape === "screen") await expect(name).toBeFocused();
  await name.fill(task);
  await expect(next).toBeEnabled();
  if (shape === "screen") return next;
  await next.click();
  return screen.getByRole("button", "Open browser and record", { exact: true });
}

function emptyStoppedNotice(shape: BrowserWindow) {
  return shape === "native"
    ? `${task} Nothing was recorded. ${emptyExplanation}`
    : `Nothing was recorded in “${task}”. ${emptyExplanation}`;
}

function savedNotice(shape: BrowserWindow, counts: string) {
  return shape === "native"
    ? `${task} Saved to your Learning space: ${counts}.`
    : `Saved “${task}” to your Learning space: ${counts}.`;
}

function withLastStopped(
  shape: BrowserWindow,
  report: Partial<NonNullable<LauncherState["lastStopped"]>>,
): BrowserApiState {
  const base = opened(shape);
  if (!base.recorder) throw new Error("An open test browser needs a Recorder");
  return {
    ...base,
    recorder: {
      ...base.recorder,
      lastStopped: {
        recordingId: "recording-1",
        title: task,
        stoppedAt: Date.now() - 1_000,
        actions: 1,
        phrases: 0,
        ...report,
      },
    },
  };
}

function wrote(path: string, body: unknown = null) {
  return { path, method: "POST", body, from: page };
}

test("Desktop opens and reconnects a browser before recording, shows its progress and starts another task", async ({
  app,
  browser,
  screen,
}) => {
  const { setState, writes } = await serveTeachBrowser(browser, {
    state: {
      ...closed("native"),
      recorder: {
        connected: false,
        phase: "idle",
        actions: 0,
        narration: "own",
      },
    },
    recordingResult: { actions: 7, phrases: 0 },
  });
  await serveNarrationPreference(browser, "on");
  await app.open(page);
  const introduction = screen.getByRole(
    "heading",
    "Do it once, and your Bots learn it",
    { exact: true },
  );
  const name = screen.getByRole("textbox", "Task name", { exact: true });
  const next = screen.getByRole("button", "Continue", { exact: true });
  const back = screen.getByRole("button", "Back", { exact: true });
  await expect(introduction).toBeVisible();
  await expect(name).toHaveCount(0);
  const start = await nameRecording(screen, "native");
  await back.click();
  await back.click();
  await expect(introduction).toBeVisible();
  expect(
    await browser.evaluate(() =>
      localStorage.getItem("openbot.teach-a-bot.introduced"),
    ),
  ).toBeNull();
  await next.click();
  await expect(name).toHaveValue(task);
  await next.click();
  await expect(
    screen.getByText(`“${task}” · Narration on`, { exact: true }),
  ).toBeVisible();
  await expect(
    screen.getByText("The Recorder is still connecting.", { exact: true }),
  ).toHaveCount(0);
  expect(writes).toEqual([]);
  await start.click();
  await expect(screen.getByText(task, { exact: true })).toBeVisible();
  await expect(browser.locator('[role="timer"]')).toHaveText(
    /^0:4\d · 7 actions$/,
  );
  const language = await browser.evaluate(() => navigator.language);
  const open = wrote(browserApiPaths.open);
  const record = wrote(browserApiPaths.recording, {
    action: "start",
    title: task,
    language,
    narrate: true,
  });
  expect(writes).toEqual([open, record]);
  await screen.getByRole("button", "Show browser", { exact: true }).click();
  await expect.poll(() => writes.length).toBe(3);
  await screen.getByRole("button", "Stop", { exact: true }).click();
  await expect(screen.getByRole("status").filter({ hasText: task })).toHaveText(
    savedNotice("native", "7 actions"),
  );
  expect(writes).toEqual([
    open,
    record,
    open,
    wrote(browserApiPaths.recording, { action: "stop" }),
  ]);
  await screen.getByRole("button", "Record another", { exact: true }).click();
  await expect(name).toHaveValue("");
  setState(opened("native"));
  await browser.reload();
  await expect(name).toBeVisible();
  await expect(introduction).toHaveCount(0);
});

for (const shape of ["native", "screen"] as const) {
  for (const [result, scenario, counts] of [
    [{ actions: 0, phrases: 0 }, "an empty recording", ""],
    [
      { actions: 0, phrases: 3 },
      "narration alone",
      "0 actions and 3 narrated phrases",
    ],
    [
      { actions: 0, phrases: 0, lateActions: 1 },
      "an action that arrives at Stop",
      "1 action",
    ],
  ] as const) {
    test(`${shape} reports ${scenario} from the Stop response`, async ({
      app,
      browser,
      screen,
    }) => {
      const { writes } = await serveTeachBrowser(browser, {
        state: opened(shape),
        recordingResult: result,
      });
      await serveNarrationPreference(browser, "off");
      await app.open(page);
      const start = await nameRecording(screen, shape);
      if (shape === "screen" && scenario === "an empty recording") {
        const about = screen.getByRole("button", "About narration", {
          exact: true,
        });
        await about.hover();
        await expect(
          browser.locator('[data-slot="tooltip-content"]'),
        ).toHaveText(
          "Talk out loud while you do the task to explain your thinking. What you say becomes part of what your Bots learn.",
        );
        await expect(about).toHaveAttribute("type", "button");
        await about.click();
        await expect(
          screen.getByRole("textbox", "Task name", { exact: true }),
        ).toHaveValue(task);
        expect(writes).toEqual([wrote(browserApiPaths.open)]);
      }
      await start.click();
      await expect(browser.locator('[role="timer"]')).toHaveText(/0 actions/);
      await expect(
        screen.getByRole("textbox", "Task name", { exact: true }),
      ).toHaveCount(0);
      await screen.getByRole("button", "Stop", { exact: true }).click();
      const status = screen.getByRole("status").filter({ hasText: task });
      await expect(status).toHaveText(
        counts ? savedNotice(shape, counts) : emptyStoppedNotice(shape),
      );
      await expect(
        status.getByText(counts ? /Nothing was recorded/ : /Saved/),
      ).toHaveCount(0);
      const language = await browser.evaluate(() => navigator.language);
      expect(writes).toEqual([
        wrote(browserApiPaths.open),
        wrote(browserApiPaths.recording, {
          action: "start",
          title: task,
          language,
          narrate: false,
        }),
        wrote(browserApiPaths.recording, { action: "stop" }),
      ]);
    });
  }

  const unavailable =
    "OpenBot's backend is busy or unreachable. Retrying; nothing is lost.";
  const kept = "It's kept in this browser";
  const delivery = [
    {
      scenario: "an empty recording",
      report: { actions: 0 },
      notice: emptyStoppedNotice(shape),
    },
    {
      scenario: "a saved recording",
      report: { actions: 1, phrases: 2 },
      notice: savedNotice(shape, "1 action and 2 narrated phrases"),
    },
    ...(
      [
        [
          "a refused recording",
          { kept: "refused" },
          `${kept} and sent again later.`,
          false,
        ],
        [
          "a signed-out Recorder",
          { kept: "signed-out" },
          `${kept} until you connect it to OpenBot again.`,
          false,
        ],
        [
          "a delivery retry",
          { sending: true, retrying: unavailable },
          unavailable,
          true,
        ],
      ] as const
    ).map(([scenario, report, why, retrying]) => ({
      scenario,
      report,
      notice:
        shape === "native"
          ? `${task} Not saved to your Learning space${retrying ? " yet" : ""}. ${why}`
          : `“${task}” wasn't saved to your Learning space${retrying ? " yet" : ""}. ${why}`,
    })),
    {
      scenario: "a pending delivery",
      report: { sending: true },
      notice:
        shape === "native"
          ? `${task} Saving to your Learning space: 1 action.`
          : `Saving “${task}” to your Learning space: 1 action.`,
    },
  ];
  for (const { scenario, report, notice } of delivery) {
    test(`${shape} shows ${scenario} after reloading Teach a Bot`, async ({
      app,
      browser,
      screen,
    }) => {
      const { setState, writes } = await serveTeachBrowser(browser, {
        state: opened(shape),
      });
      await app.open(page);
      const status = screen.getByRole("status").filter({ hasText: task });
      await expect(
        screen.getByRole("heading", title, { exact: true, level: 1 }),
      ).toBeVisible();
      await expect(status).toHaveCount(0);
      setState(withLastStopped(shape, report));
      await browser.reload();
      await expect(status).toHaveText(notice);
      expect(
        writes.filter(({ path }) => path === browserApiPaths.recording),
      ).toEqual([]);
    });
  }

  test(`${shape} shows the Recorder's errors for a refused start and stop`, async ({
    app,
    browser,
    screen,
  }) => {
    const startError =
      "This browser is no longer connected to OpenBot. Open it from OpenBot again.";
    const stopError = "The Recorder could not do that. Try again.";
    const { setState, writes } = await serveTeachBrowser(browser, {
      state: opened(shape),
      rejectRecording: { start: startError, stop: stopError },
    });
    await serveNarrationPreference(browser, "off");
    await app.open(page);
    await (await nameRecording(screen, shape)).click();
    await expect(
      screen.getByRole("alert").filter({ hasText: startError }),
    ).toHaveText(startError);

    setState(recording("recording", shape));
    const stop = screen.getByRole("button", "Stop", { exact: true });
    await stop.click();
    await expect(
      screen.getByRole("alert").filter({ hasText: stopError }),
    ).toHaveText(stopError);
    await expect(stop).toBeVisible();
    const language = await browser.evaluate(() => navigator.language);
    expect(writes).toEqual([
      wrote(browserApiPaths.open),
      wrote(browserApiPaths.recording, {
        action: "start",
        title: task,
        language,
        narrate: false,
      }),
      wrote(browserApiPaths.recording, { action: "stop" }),
    ]);
  });
}

test("Desktop shows an externally discarded recording by name", async ({
  app,
  browser,
  screen,
}) => {
  const { writes } = await serveTeachBrowser(browser, {
    state: withLastStopped("native", { actions: 7, discarded: true }),
  });
  await app.open(page);
  await expect(screen.getByRole("status").filter({ hasText: task })).toHaveText(
    `${task} Discarded. You chose not to save it.`,
  );
  expect(writes).toEqual([]);
});

test("Desktop refreshes Your recordings when a held recording reaches Learning", async ({
  app,
  browser,
  screen,
}) => {
  const { recordingsReads, setRows, setState, writes } =
    await serveTeachBrowser(browser, {
      state: withLastStopped("native", { kept: "refused" }),
    });
  await app.open(page);
  await expect(
    screen.getByRole("status").filter({ hasText: task }),
  ).toContainText("sent again later");
  await expect(screen.getByText(/No recordings yet/)).toBeVisible();
  const before = recordingsReads();
  setRows([{ ...row, title: task }]);
  setState(withLastStopped("native", {}));
  const list = browser.locator("section").filter({
    has: screen.getByRole("heading", "Your recordings", { exact: true }),
  });
  const date = await browser.evaluate(
    (timestamp) => new Date(timestamp).toLocaleString("en"),
    row.recordedAt,
  );
  await expect(list.getByText(task, { exact: true })).toBeVisible();
  await expect(list.getByText(date, { exact: true })).toBeVisible();
  expect(recordingsReads()).toBeGreaterThan(before);
  expect(writes).toEqual([]);
});

const recordingsSpace = "openbot-person-ada";
const learnedDescription = "Submit an expense report with the correct receipt.";
const learningExplanation =
  "OpenBot learns a skill from it, and you'll find it in Settings, Learning. Once it's learned, ask any Bot to do it.";

type RecordingLearningOptions = {
  review?: PersonalReview;
  skills?: RecordingSkills["skills"];
  refusal?: string;
};

async function serveRecordingLearning(
  browser: Browser,
  { review, skills = [], refusal }: RecordingLearningOptions = {},
) {
  const starts: { method: string; container: string | null; body: unknown }[] =
    [];
  const lookups: { title: string | null; since: string | null }[] = [];
  await browser.route(
    /\/api\/settings\/learning\/recording-skills(?:\?[^#]*)?$/,
    (route) => {
      const { searchParams } = new URL(route.request.url);
      lookups.push({
        title: searchParams.get("title"),
        since: searchParams.get("since"),
      });
      return route.fulfill({ json: { skills } });
    },
  );
  if (review) {
    await browser.route(/\/api\/settings\/learning\/review$/, (route) =>
      route.fulfill({ json: review }),
    );
    await browser.route(
      /\/api\/settings\/learning\/runs(?:\?[^#]*)?$/,
      (route) => {
        const { method, postData, url } = route.request;
        starts.push({
          method,
          container: new URL(url).searchParams.get("container"),
          body: postData ? JSON.parse(postData) : null,
        });
        if (refusal)
          return route.fulfill({ status: 409, json: { error: refusal } });
        review.sources = review.sources.map((source) => ({
          ...source,
          latestRun:
            source.kind === "recordings"
              ? learningRun("queued")
              : source.latestRun,
        }));
        return route.fulfill({
          json: { run: { id: "run-queued", status: "queued" } },
        });
      },
    );
  }
  return {
    starts,
    lookups,
    setSkills(next: RecordingSkills["skills"]) {
      skills = next;
    },
  };
}

function learningRun(
  status: LearningRunSummary["status"],
  failure?: string,
): LearningRunSummary {
  const now = new Date().toISOString();
  return {
    id: `run-${status}`,
    status,
    trigger: "manual",
    proposals: null,
    insights: null,
    failureCode: failure ? "BatchInsightAgentFailed" : null,
    failure: failure ?? null,
    createdAt: now,
    startedAt: status === "queued" ? null : now,
    completedAt: status === "succeeded" || status === "failed" ? now : null,
  };
}

function recordingReview(
  latestRun: LearningRunSummary | null = null,
): PersonalReview {
  return {
    canReview: true,
    autoApprove: true,
    approved: 0,
    sources: [
      {
        containerId: recordingsSpace,
        kind: "recordings",
        label: "Your recordings",
        proposals: [],
        latestRun,
      },
    ],
  };
}

function expenseSkill(
  status: "pending_review" | "approved",
): RecordingSkills["skills"][number] {
  return {
    id: "4b9f2a8e-1c3d-4e5f-8a9b-0c1d2e3f4a5b",
    title: "submit-an-expense-report",
    description: learnedDescription,
    reason: "You did this in a recording.",
    operation: "add",
    status,
    createdAt: new Date().toISOString(),
    reviewedAt: null,
    container: recordingsSpace,
  };
}

for (const shape of ["native", "screen"] as const) {
  test(`${shape} starts Learning from a saved recording and opens Settings, Learning`, async ({
    app,
    browser,
    screen,
  }) => {
    const state = withLastStopped(shape, { actions: 6, phrases: 6 });
    const { learningRequests, writes } = await serveTeachBrowser(browser, {
      state,
      learning: { review: recordingReview() },
    });
    await app.open(page);
    if (shape === "native") {
      await expect(
        screen.getByRole("heading", `Saved “${task}”`, { exact: true }),
      ).toBeVisible();
      await expect(
        screen.getByRole("button", "Record another", { exact: true }),
      ).toBeVisible();
    }
    await expect(
      screen.getByRole("status").filter({ hasText: task }),
    ).toHaveText(savedNotice(shape, "6 actions and 6 narrated phrases"));
    await expect(
      screen.getByText(learningExplanation, { exact: true }),
    ).toBeVisible();
    await expect(
      screen.getByText("Learning runs on its own", { exact: true }),
    ).toBeVisible();
    const learn = screen.getByRole("button", "Learn now", { exact: true });
    const settings = screen.getByRole("button", "See your skills", {
      exact: true,
    });
    await expect(settings).toHaveAttribute("href", "/settings/learning");
    expect(learningRequests.starts).toEqual([]);
    await learn.click();
    await expect(
      screen.getByText("Learning from your recordings", { exact: true }),
    ).toBeVisible();
    await expect(learn).toHaveCount(0);
    expect(learningRequests.starts).toEqual([
      { method: "POST", container: recordingsSpace, body: {} },
    ]);
    expect(
      writes.filter(({ path }) => path === browserApiPaths.recording),
    ).toEqual([]);
    await settings.click();
    await expect(browser).toHaveURL("/settings/learning");
  });

  test(`${shape} shows a skill from the saved recording and opens its task in a new conversation`, async ({
    app,
    browser,
    screen,
  }) => {
    const stoppedAt = Date.now() - 5_000;
    const { learningRequests } = await serveTeachBrowser(browser, {
      state: withLastStopped(shape, { stoppedAt, actions: 6, phrases: 6 }),
      learning: {
        review: recordingReview(learningRun("succeeded")),
        skills: [expenseSkill("pending_review")],
      },
    });
    await app.open(page);
    await expect(
      screen.getByText("Ready to review", { exact: true }),
    ).toBeVisible();
    const review = screen.getByRole("button", "Review", { exact: true });
    await expect(review).toHaveAttribute("href", "/settings/learning");
    expect(learningRequests.lookups).toEqual([
      { title: task, since: String(stoppedAt) },
    ]);
    await expect(
      screen.getByRole("button", "Try it", { exact: true }),
    ).toHaveCount(0);
    if (shape === "native") {
      await expect(
        screen.getByRole("heading", "Your new skill is ready to review", {
          exact: true,
        }),
      ).toBeVisible();
    }
    learningRequests.setSkills([expenseSkill("approved")]);
    await browser.reload();
    await expect(
      screen.getByText("Skill learned", { exact: true }),
    ).toBeVisible();
    await expect(
      screen.getByText(learnedDescription, { exact: true }),
    ).toBeVisible();
    await expect(review).toHaveCount(0);
    if (shape === "native") {
      await expect(
        screen.getByRole("heading", "Your Bots learned it", { exact: true }),
      ).toBeVisible();
    } else {
      await expect(
        screen.getByText(
          `Your Bots can do “${task}” now. Try it, or ask any Bot to do it.`,
          { exact: true },
        ),
      ).toBeVisible();
    }
    await screen.getByRole("button", "Try it", { exact: true }).click();
    const editor = screen.getByRole("textbox", "Message", { exact: true });
    await expect(editor).toHaveText(task);
    await expect(browser).toHaveURL(/\/\?ask=/);
    expect(learningRequests.starts).toEqual([]);
  });
}

const modelUnavailable =
  "Learning can't run on the model you signed in with. To use it, sign OpenBot in with an OpenAI or Anthropic API key, or a Claude or ChatGPT plan.";

test("a saved Desktop recording stays available when Learning has no usable model", async ({
  app,
  browser,
  screen,
}) => {
  const { learningRequests } = await serveTeachBrowser(browser, {
    state: withLastStopped("native", {}),
    learning: {
      review: { ...recordingReview(), modelProblem: modelUnavailable },
    },
  });
  await app.open(page);
  await expect(
    screen.getByText("Learning can't run yet", { exact: true }),
  ).toBeVisible();
  await expect(
    screen.getByText(modelUnavailable, { exact: true }),
  ).toBeVisible();
  await expect(
    screen.getByText(
      "Your recording is kept. OpenBot learns a skill from it once Learning can run.",
      { exact: true },
    ),
  ).toBeVisible();
  await expect(
    screen.getByRole("button", "Learn now", { exact: true }),
  ).toHaveCount(0);
  expect(learningRequests.starts).toEqual([]);
});

test("a failed Desktop Learning run exposes its reason and a refused retry says why", async ({
  app,
  browser,
  screen,
}) => {
  const why =
    "Your model plan didn't answer Learning. Try Learn now again in a few minutes.";
  const { learningRequests } = await serveTeachBrowser(browser, {
    state: withLastStopped("native", {}),
    learning: {
      review: recordingReview(learningRun("failed", why)),
      refusal: modelUnavailable,
    },
  });
  await app.open(page);
  await expect(
    screen.getByText("Learning didn't finish", { exact: true }),
  ).toBeVisible();
  await expect(screen.getByText(why, { exact: true })).toBeVisible();
  await screen.getByRole("button", "Learn now", { exact: true }).click();
  await expect(
    screen.getByText("Learning didn't start", { exact: true }),
  ).toBeVisible();
  await expect(
    screen.getByText(modelUnavailable, { exact: true }),
  ).toBeVisible();
  expect(learningRequests.starts).toEqual([
    { method: "POST", container: recordingsSpace, body: {} },
  ]);
});

test("a hosted recording still being delivered offers no Learning action until it is saved", async ({
  app,
  browser,
  screen,
}) => {
  const { learningRequests, setState } = await serveTeachBrowser(browser, {
    state: withLastStopped("screen", { actions: 6, phrases: 6, sending: true }),
    learning: { review: recordingReview() },
  });
  await app.open(page);
  await expect(screen.getByRole("status").filter({ hasText: task })).toHaveText(
    `Saving “${task}” to your Learning space: 6 actions and 6 narrated phrases.`,
  );
  await expect(
    screen.getByRole("button", "See your skills", { exact: true }),
  ).toHaveCount(0);
  await expect(
    screen.getByRole("button", "Learn now", { exact: true }),
  ).toHaveCount(0);
  await expect(
    screen.getByText("Learning runs on its own", { exact: true }),
  ).toHaveCount(0);
  expect(learningRequests.lookups).toEqual([]);
  setState(withLastStopped("screen", { actions: 6, phrases: 6 }));
  await expect(screen.getByRole("status").filter({ hasText: task })).toHaveText(
    savedNotice("screen", "6 actions and 6 narrated phrases"),
  );
  await expect(
    screen.getByRole("button", "Learn now", { exact: true }),
  ).toBeVisible();
  expect(learningRequests.starts).toEqual([]);
});

const docsTab = {
  id: "tab-docs",
  url: "https://docs.example.com/",
  title: "Docs",
  active: false,
};
const mailTab = {
  id: "tab-mail",
  url: "https://mail.example.com/",
  title: "Mail",
  active: false,
};

test("the hosted tab strip moves focus with arrows, Home and End, and selects only on Enter", async ({
  app,
  browser,
  screen,
}) => {
  const { writes } = await serveTeachBrowser(browser, {
    state: { ...opened("screen"), tabs: [site, docsTab, mailTab] },
  });
  await app.open(page);
  const tabs = screen.getByRole("tablist", "Tabs", { exact: true });
  const first = tabs.getByRole("tab", site.title, { exact: true });
  const docs = tabs.getByRole("tab", docsTab.title, { exact: true });
  const mail = tabs.getByRole("tab", mailTab.title, { exact: true });
  await expect(first).toHaveAttribute("tabindex", "0");
  await expect(docs).toHaveAttribute("tabindex", "-1");
  await expect(mail).toHaveAttribute("tabindex", "-1");
  await first.focus();
  for (const [key, focused] of [
    ["ArrowRight", docs],
    ["End", mail],
    ["ArrowRight", first],
    ["ArrowLeft", mail],
    ["Home", first],
    ["ArrowRight", docs],
  ] as const) {
    await browser.keyboard.press(key);
    await expect(focused).toBeFocused();
  }
  await expect(first).toHaveAttribute("aria-selected", "true");
  await expect(docs).toHaveAttribute("aria-selected", "false");
  expect(writes).toEqual([wrote(browserApiPaths.open)]);
  await browser.keyboard.press("Enter");
  await expect(docs).toHaveAttribute("aria-selected", "true");
  const panel = screen.getByRole("tabpanel", docsTab.title, { exact: true });
  await expect(
    panel.getByRole("textbox", "Address", { exact: true }),
  ).toHaveValue(docsTab.url);
  expect(writes).toEqual([
    wrote(browserApiPaths.open),
    wrote(browserApiPaths.tabs, { action: "activate", tabId: docsTab.id }),
  ]);
});

test("Delete focuses the tab the browser made active and closing a background tab keeps it active", async ({
  app,
  browser,
  screen,
}) => {
  const { writes } = await serveTeachBrowser(browser, {
    state: { ...opened("screen"), tabs: [site, docsTab, mailTab] },
  });
  await app.open(page);
  const first = screen.getByRole("tab", site.title, { exact: true });
  const docs = screen.getByRole("tab", docsTab.title, { exact: true });
  const mail = screen.getByRole("tab", mailTab.title, { exact: true });
  await first.focus();
  await browser.keyboard.press("Delete");
  await expect(first).toHaveCount(0);
  await expect(mail).toBeFocused();
  await expect(mail).toHaveAttribute("aria-selected", "true");
  await expect(mail).toHaveAttribute("tabindex", "0");
  await docs.focus();
  await browser.keyboard.press("Delete");
  await expect(docs).toHaveCount(0);
  await expect(mail).toBeFocused();
  await expect(mail).toHaveAttribute("aria-selected", "true");
  expect(writes).toEqual([
    wrote(browserApiPaths.open),
    wrote(browserApiPaths.tabs, { action: "close", tabId: site.id }),
    wrote(browserApiPaths.tabs, { action: "close", tabId: docsTab.id }),
  ]);
});

test("the connected hosted canvas receives keys only while it has focus", async ({
  app,
  browser,
  screen,
}) => {
  const observe = await observeLiveScreen(browser, computerId);
  const { writes } = await serveTeachBrowser(browser, {
    state: { ...opened("screen"), tabs: [site, docsTab, mailTab] },
  });
  await app.open(page);
  const canvas = screen.getByLabel(liveScreen, { exact: true });
  await expect(canvas).toHaveAttribute("data-connected", "true");
  const stream = `/api/computers/${computerId}/stream`;
  const observations = await observe();
  expect(observations).toEqual({
    requests: expect.arrayContaining([stream]),
    keys: [],
  });
  const first = screen.getByRole("tab", site.title, { exact: true });
  const docs = screen.getByRole("tab", docsTab.title, { exact: true });
  const mail = screen.getByRole("tab", mailTab.title, { exact: true });
  const newTab = screen.getByRole("button", "New tab", { exact: true });
  await first.focus();
  for (const [key, focused] of [
    ["ArrowRight", docs],
    ["End", mail],
    ["Home", first],
    ["ArrowLeft", mail],
  ] as const) {
    await browser.keyboard.press(key);
    await expect(focused).toBeFocused();
  }
  await browser.keyboard.press("Enter");
  await expect(mail).toHaveAttribute("aria-selected", "true");
  await browser.keyboard.press("Delete");
  await expect(docs).toBeFocused();
  await browser.keyboard.press("Tab");
  await expect(newTab).toBeFocused();
  await browser.keyboard.press("Space");
  const address = screen.getByRole("textbox", "Address", { exact: true });
  await expect(address).toBeFocused();
  expect(writes).toEqual([
    wrote(browserApiPaths.open),
    wrote(browserApiPaths.tabs, { action: "activate", tabId: mailTab.id }),
    wrote(browserApiPaths.tabs, { action: "close", tabId: mailTab.id }),
    wrote(browserApiPaths.tabs, { action: "new" }),
  ]);
  expect(await observe()).toEqual(observations);

  // Return to a real page in the fixture so the canvas can take focus.
  await docs.click();
  await expect(docs).toHaveAttribute("aria-selected", "true");
  await expect(canvas).toHaveAttribute("data-connected", "true");
  await canvas.click();
  await expect(canvas).toBeFocused();
  await browser.keyboard.press("a");
  await browser.keyboard.press("ArrowLeft");
  const forwarded = [
    ["down", "a"],
    ["up", "a"],
    ["down", "ArrowLeft"],
    ["up", "ArrowLeft"],
  ];
  expect(await observe()).toEqual({
    requests: expect.arrayContaining([stream]),
    keys: forwarded,
  });
  await browser.keyboard.press("Escape");
  await expect(canvas).not.toBeFocused();
  await browser.keyboard.press("b");
  expect(await observe()).toEqual({
    requests: expect.arrayContaining([stream]),
    keys: forwarded,
  });
  await address.fill("openbot.ai");
  await address.press("Enter");
  await expect(canvas).toBeFocused();
  await expect
    .poll(() => writes.at(-1))
    .toEqual(wrote(browserApiPaths.navigate, { url: "https://openbot.ai" }));
});

test("the hosted browser keeps the active tab, canvas and navigation controls in sync", async ({
  app,
  browser,
  screen,
}) => {
  const observe = await observeLiveScreen(browser, computerId);
  const { writes } = await serveTeachBrowser(browser, {
    state: { ...opened("screen"), tabs: [site, { ...blank, active: false }] },
  });
  await app.open(page);
  const first = screen.getByRole("tab", site.title, { exact: true });
  const panel = screen.getByRole("tabpanel", site.title, { exact: true });
  const canvas = panel.getByLabel(liveScreen, { exact: true });
  await expect(first).toHaveAttribute("aria-selected", "true");
  const panelId = await panel.getAttribute("id");
  expect(panelId).toMatch(/\S/);
  if (!panelId) throw new Error("The active panel is missing its ID");
  await expect(first).toHaveAttribute("aria-controls", panelId);
  await expect(
    panel.getByRole("textbox", "Address", { exact: true }),
  ).toHaveValue(site.url);
  await expect(canvas).toHaveAttribute("data-connected", "true");
  expect(await browser.locator("canvas").getAttribute("aria-label")).toBe(
    liveScreen,
  );
  expect(await observe()).toEqual({
    requests: expect.arrayContaining([`/api/computers/${computerId}/stream`]),
    keys: [],
  });
  const address = screen.getByRole("textbox", "Address", { exact: true });
  await screen.getByRole("tab", "New tab", { exact: true }).click();
  await expect(address).toHaveValue("");
  await screen.getByRole("button", "New tab", { exact: true }).click();
  await expect(screen.getByRole("tab")).toHaveCount(3);
  await first.focus();
  await browser.keyboard.press("Delete");
  await expect(first).toHaveCount(0);
  await screen.getByRole("button", "Back", { exact: true }).click();
  await expect
    .poll(() => writes.at(-1))
    .toEqual(wrote(browserApiPaths.navigate, { action: "back" }));
  await screen.getByRole("button", "Reload", { exact: true }).click();
  await expect
    .poll(() => writes.at(-1))
    .toEqual(wrote(browserApiPaths.navigate, { action: "reload" }));
  await address.fill("openbot.ai");
  await address.press("Enter");
  await expect
    .poll(() => writes.at(-1))
    .toEqual(wrote(browserApiPaths.navigate, { url: "https://openbot.ai" }));
  await address.fill("how to file an expense report");
  await address.press("Enter");
  await expect
    .poll(() => writes)
    .toEqual([
      wrote(browserApiPaths.open),
      wrote(browserApiPaths.tabs, { action: "activate", tabId: blank.id }),
      wrote(browserApiPaths.tabs, { action: "new" }),
      wrote(browserApiPaths.tabs, { action: "close", tabId: site.id }),
      wrote(browserApiPaths.navigate, { action: "back" }),
      wrote(browserApiPaths.navigate, { action: "reload" }),
      wrote(browserApiPaths.navigate, { url: "https://openbot.ai" }),
      wrote(browserApiPaths.navigate, {
        url: "https://www.google.com/search?q=how%20to%20file%20an%20expense%20report",
      }),
    ]);
});

const narrationOff = "Narration is off.";
const missingMicrophone = "No microphone found. Narration is off.";

async function narrationRecording(browser: Browser, shape: BrowserWindow) {
  const fixture = await serveTeachBrowser(browser, {
    state: opened(shape),
    recordingResult: { actions: 2, phrases: 0 },
  });
  return {
    recordingWrites: () =>
      fixture.writes.filter(({ path }) => path === browserApiPaths.recording),
  };
}

function firstNarrationQuestion(screen: TestFixtures["screen"]) {
  return screen.getByRole("dialog", "Narrate while you record?", {
    exact: true,
  });
}

function narrationToggle(screen: TestFixtures["screen"]) {
  return screen.getByRole("switch", "Narration", { exact: true });
}

async function checkNarrationStart(
  browser: Browser,
  recordingWrites: () => unknown[],
  narrate: boolean,
) {
  const language = await browser.evaluate(() => navigator.language);
  expect(recordingWrites()).toEqual([
    wrote(browserApiPaths.recording, {
      action: "start",
      title: task,
      language,
      narrate,
    }),
  ]);
}

for (const [shape, narrate] of [
  ["native", false],
  ["screen", true],
] as const) {
  test(`${shape} asks before the first recording and saves the person's narration answer`, async ({
    app,
    browser,
    screen,
  }) => {
    const speech = await simulateBrowserSpeech(browser);
    const { recordingWrites } = await narrationRecording(browser, shape);
    const { changes } = await serveNarrationPreference(browser, null);
    await app.open(page);
    const start = await nameRecording(screen, shape);
    if (shape === "screen")
      await expect(narrationToggle(screen)).toHaveAttribute(
        "aria-checked",
        "false",
      );
    else
      await expect(
        screen.getByText(`“${task}” · Narration off`, { exact: true }),
      ).toBeVisible();
    await start.click();
    const question = firstNarrationQuestion(screen);
    await expect(question).toBeVisible();
    await expect(question).toContainText(
      "Your browser turns your speech into text on your own computer.",
    );
    expect(recordingWrites()).toEqual([]);
    expect(changes).toEqual([]);
    expect(await speech.recognitions()).toEqual([]);
    await question
      .getByRole(
        "button",
        narrate ? "Record with narration" : "Record without narration",
        { exact: true },
      )
      .click();
    await expect(question).toHaveCount(0);
    await expect(
      screen.getByRole("button", "Stop", { exact: true }),
    ).toBeVisible();
    await checkNarrationStart(browser, recordingWrites, narrate);
    expect(changes).toEqual([{ narration: narrate ? "on" : "off" }]);
    if (narrate) {
      await expect(
        screen.getByText("Listening", { exact: true }),
      ).toBeVisible();
      const language = await browser.evaluate(() => navigator.language);
      expect(await speech.recognitions()).toEqual([
        { language, local: true, error: "" },
      ]);
    } else {
      expect(await speech.recognitions()).toEqual([]);
    }
  });
}

test("unplugging the Desktop microphone skips the first narration question without saving a choice", async ({
  app,
  browser,
  screen,
}) => {
  const speech = await simulateBrowserSpeech(browser, {
    desktop: "available",
    speech: "no-local-model",
  });
  const { changes } = await serveNarrationPreference(browser, null);
  const { recordingWrites } = await narrationRecording(browser, "screen");
  await app.open(page);
  const start = await nameRecording(screen, "screen");
  const question = firstNarrationQuestion(screen);
  await start.click();
  await expect(
    question.getByRole("button", "Record with narration", { exact: true }),
  ).toBeVisible();
  await browser.keyboard.press("Escape");
  await expect(question).toHaveCount(0);
  expect(recordingWrites()).toEqual([]);
  await speech.setMicrophone(false);
  await expect(
    screen.getByText(missingMicrophone, { exact: true }).first(),
  ).toBeVisible();
  await screen.getByRole("button", "Record", { exact: true }).click();
  await screen.getByRole("textbox", "Task name", { exact: true }).fill(task);
  await start.click();
  await expect(
    screen.getByRole("button", "Stop", { exact: true }),
  ).toBeVisible();
  await checkNarrationStart(browser, recordingWrites, false);
  await expect(question).toHaveCount(0);
  expect(changes).toEqual([]);
  expect(await speech.recognitions()).toEqual([]);
});

for (const fail of [false, true]) {
  test(`Desktop uses the existing narration preference when its read ${fail ? "fails" : "is delayed"} without prompting`, async ({
    app,
    browser,
    screen,
  }) => {
    await simulateBrowserSpeech(browser);
    const held = Promise.withResolvers<void>();
    const { changes, reads } = await serveNarrationPreference(browser, "on", {
      fail,
      hold: fail ? undefined : held.promise,
    });
    const { recordingWrites } = await narrationRecording(browser, "native");
    try {
      await app.open(page);
      const start = await nameRecording(screen, "native");
      await expect.poll(reads).toBeGreaterThan(0);
      await start.click();
      await expect(firstNarrationQuestion(screen)).toHaveCount(0);
      if (!fail) expect(recordingWrites()).toEqual([]);
    } finally {
      held.resolve();
    }
    await expect(
      screen.getByRole("button", "Stop", { exact: true }),
    ).toBeVisible();
    await checkNarrationStart(browser, recordingWrites, !fail);
    await expect(firstNarrationQuestion(screen)).toHaveCount(0);
    expect(changes).toEqual([]);
  });
}

test("hosted narration reads the saved off choice then starts local listening only after it is enabled", async ({
  app,
  browser,
  screen,
}) => {
  const speech = await simulateBrowserSpeech(browser);
  const { changes } = await serveNarrationPreference(browser, "off");
  const { recordingWrites } = await narrationRecording(browser, "screen");
  await app.open(page);
  await (await nameRecording(screen, "screen")).click();
  await expect(
    screen.getByRole("button", "Stop", { exact: true }),
  ).toBeVisible();
  await checkNarrationStart(browser, recordingWrites, false);
  await expect(firstNarrationQuestion(screen)).toHaveCount(0);
  await expect(screen.getByText(narrationOff, { exact: true })).toBeVisible();
  expect(await speech.recognitions()).toEqual([]);
  expect(changes).toEqual([]);
  await narrationToggle(screen).click();
  await expect(screen.getByText("Listening", { exact: true })).toBeVisible();
  const language = await browser.evaluate(() => navigator.language);
  expect(await speech.recognitions()).toEqual([
    { language, local: true, error: "" },
  ]);
  expect(changes).toEqual([{ narration: "on" }]);
});

test("hosted narration requests the local language download from the toggle click before listening", async ({
  app,
  browser,
  screen,
}) => {
  const speech = await simulateBrowserSpeech(browser, {
    speech: "downloadable",
  });
  await serveNarrationPreference(browser, "on");
  const { recordingWrites } = await narrationRecording(browser, "screen");
  await app.open(page);
  await (await nameRecording(screen, "screen")).click();
  await expect(
    screen.getByRole("button", "Stop", { exact: true }),
  ).toBeVisible();
  await checkNarrationStart(browser, recordingWrites, true);
  await expect(screen.getByText(narrationOff, { exact: true })).toBeVisible();
  await expect(narrationToggle(screen)).toHaveAttribute(
    "aria-checked",
    "false",
  );
  expect(await speech.recognitions()).toEqual([]);
  expect(await speech.downloads()).toEqual([]);
  await narrationToggle(screen).click();
  const language = await browser.evaluate(() => navigator.language);
  await expect
    .poll(speech.downloads)
    .toEqual([{ language, userGesture: true, local: true }]);
  await expect(screen.getByText(narrationOff, { exact: true })).toBeVisible();
  expect(await speech.recognitions()).toEqual([]);
  await speech.finishDownload();
  await expect(screen.getByText("Listening", { exact: true })).toBeVisible({
    timeout: 8000,
  });
  expect(await speech.recognitions()).toEqual([
    { language, local: true, error: "" },
  ]);
});

for (const feature of ["unsupported", "no-local-model"] as const) {
  test(`the hosted browser records with narration off when speech is ${feature}`, async ({
    app,
    browser,
    screen,
  }) => {
    const speech = await simulateBrowserSpeech(browser, { speech: feature });
    await serveNarrationPreference(browser, "on");
    const { recordingWrites } = await narrationRecording(browser, "screen");
    await app.open(page);
    await (
      await nameRecording(screen, "screen", {
        narration: feature !== "unsupported",
      })
    ).click();
    await expect(
      screen.getByRole("button", "Stop", { exact: true }),
    ).toBeVisible();
    await expect(screen.getByText(narrationOff, { exact: true })).toBeVisible();
    if (feature === "unsupported")
      await expect(narrationToggle(screen)).toHaveCount(0);
    else
      await expect(narrationToggle(screen)).toHaveAttribute(
        "aria-checked",
        "false",
      );
    await checkNarrationStart(browser, recordingWrites, true);
    expect(await speech.recognitions()).toEqual([]);
  });
}

test("hosted narration reads the saved off choice after Chrome reloads", async ({
  app,
  browser,
  screen,
}) => {
  const speech = await simulateBrowserSpeech(browser);
  const { changes, reads } = await serveNarrationPreference(browser, "on");
  const { recordingWrites } = await narrationRecording(browser, "screen");
  await app.open(page);
  const record = screen.getByRole("button", "Record", { exact: true });
  await record.click();
  const toggle = narrationToggle(screen);
  await expect(toggle).toHaveAttribute("aria-checked", "true");
  await toggle.click();
  await expect(toggle).toHaveAttribute("aria-checked", "false");
  await expect.poll(() => changes).toEqual([{ narration: "off" }]);
  const before = reads();
  await browser.reload();
  await record.click();
  await expect.poll(reads).toBeGreaterThan(before);
  await expect(toggle).toHaveAttribute("aria-checked", "false");
  expect(recordingWrites()).toEqual([]);
  expect(await speech.recognitions()).toEqual([]);
});

for (const error of ["not-allowed", "audio-capture", "network"] as const) {
  test(`hosted narration shows ${error} and recovers when recognition is available`, async ({
    app,
    browser,
    screen,
  }) => {
    const speech = await simulateBrowserSpeech(browser, { error });
    await serveNarrationPreference(browser, "on");
    const { recordingWrites } = await narrationRecording(browser, "screen");
    await app.open(page);
    const start = await nameRecording(screen, "screen");
    const toggle = narrationToggle(screen);
    await expect(toggle).toHaveAttribute("aria-checked", "true");
    await start.click();
    const off = screen.getByText(narrationOff, { exact: true });
    await expect(off).toBeVisible();
    await expect(toggle).toHaveAttribute(
      "aria-checked",
      error === "network" ? "true" : "false",
    );
    const language = await browser.evaluate(() => navigator.language);
    expect(await speech.recognitions()).toEqual([
      { language, local: true, error },
    ]);
    await speech.setError("");
    if (error !== "network") await toggle.click();
    await expect(screen.getByText("Listening", { exact: true })).toBeVisible({
      timeout: 8000,
    });
    await expect(toggle).toHaveAttribute("aria-checked", "true");
    await expect(off).toHaveCount(0);
    expect(await speech.recognitions()).toEqual([
      { language, local: true, error },
      { language, local: true, error: "" },
    ]);
    await checkNarrationStart(browser, recordingWrites, true);
  });
}

test("Desktop uses the saved narration choice again when a microphone is plugged in", async ({
  app,
  browser,
  screen,
}) => {
  const speech = await simulateBrowserSpeech(browser, {
    desktop: "available",
    microphone: false,
  });
  const { changes } = await serveNarrationPreference(browser, "on");
  await narrationRecording(browser, "screen");
  await app.open(page);
  const missing = screen.getByText(missingMicrophone, { exact: true });
  await expect(missing.first()).toBeVisible();
  await browser.reload();
  await expect(missing.first()).toBeVisible();
  await screen.getByRole("button", "Record", { exact: true }).click();
  const toggle = narrationToggle(screen);
  await expect(toggle).toHaveAttribute("aria-checked", "false");
  await expect(
    screen.getByText("Narration is on.", { exact: true }),
  ).toHaveCount(0);
  await speech.setMicrophone(true);
  await expect(toggle).toHaveAttribute("aria-checked", "true");
  await expect(missing).toHaveCount(0);
  expect(changes).toEqual([]);
  expect(await speech.recognitions()).toEqual([]);
});

test("Desktop narration follows the Recorder's voice report while recording", async ({
  app,
  browser,
  screen,
}) => {
  await simulateBrowserSpeech(browser);
  const { setState, writes } = await serveTeachBrowser(browser, {
    state: opened("native"),
  });
  await serveNarrationPreference(browser, "on");
  await app.open(page);
  await screen.getByRole("button", "Continue", { exact: true }).click();
  await expect(narrationToggle(screen)).toBeVisible();
  const base = recording("recording", "native");
  const recorder = base.recorder;
  if (!recorder)
    throw new Error("Missing Recorder in active recording fixture");
  for (const [voice, sentence] of [
    ["listening", "Narration is on. We're capturing your voice."],
    ["muted", narrationOff],
    ["unavailable", narrationOff],
  ] as const) {
    if (voice === "unavailable") {
      setState({ ...base, recorder: { ...recorder, voice: "listening" } });
      await expect(
        screen.getByText("Narration is on. We're capturing your voice.", {
          exact: true,
        }),
      ).toBeVisible();
    }
    setState({ ...base, recorder: { ...recorder, voice } });
    await expect(screen.getByText(sentence, { exact: true })).toBeVisible();
  }
  expect(writes).toEqual([]);
});

test("a refused hosted recording replaces an earlier tab-close error", async ({
  app,
  browser,
  screen,
}) => {
  await simulateBrowserSpeech(browser);
  const { writes } = await serveTeachBrowser(browser, {
    state: opened("screen"),
    rejectRecording: { start: "A recording is already running." },
    rejectTabClose: "There is no such tab.",
  });
  await serveNarrationPreference(browser, "off");
  await app.open(page);
  await screen.getByRole("tab", site.title, { exact: true }).focus();
  await browser.keyboard.press("Delete");
  const oldError = screen
    .getByRole("alert")
    .filter({ hasText: "There is no such tab." });
  await expect(oldError).toBeVisible();
  await (await nameRecording(screen, "screen")).click();
  await expect(
    screen
      .getByRole("alert")
      .filter({ hasText: "A recording is already running." }),
  ).toBeVisible();
  await expect(oldError).toHaveCount(0);
  const language = await browser.evaluate(() => navigator.language);
  expect(writes).toEqual([
    wrote(browserApiPaths.open),
    wrote(browserApiPaths.tabs, { action: "close", tabId: site.id }),
    wrote(browserApiPaths.recording, {
      action: "start",
      title: task,
      language,
      narrate: false,
    }),
  ]);
});

for (const refuse of [false, true]) {
  test(`hosted narration ${refuse ? "stays visible when the Recorder refuses narration" : "sends the phrase in progress before Stop"}`, async ({
    app,
    browser,
    screen,
  }) => {
    const phrase = {
      interim: "I am opening",
      final: "I am opening the expenses page",
    };
    await simulateBrowserSpeech(browser, { phrase });
    await serveNarrationPreference(browser, "on");
    const rejection = "This browser hears your voice itself.";
    const { writes } = await serveTeachBrowser(browser, {
      state: opened("screen"),
      recordingResult: { actions: 7, phrases: 0 },
      rejectNarration: refuse ? rejection : undefined,
    });
    await app.open(page);
    await (await nameRecording(screen, "screen")).click();
    await expect(
      screen.getByText("Narration is on. We're capturing your voice.", {
        exact: true,
      }),
    ).toBeVisible();
    await expect
      .poll(
        () =>
          writes.filter(({ path }) => path === browserApiPaths.narration)
            .length,
      )
      .toBe(1);
    if (refuse) {
      await expect(narrationToggle(screen)).toHaveAttribute(
        "aria-checked",
        "true",
      );
      const attempted = writes.filter(
        ({ path }) => path === browserApiPaths.narration,
      );
      expect(attempted).toEqual([
        wrote(browserApiPaths.narration, {
          speaking: true,
          since: expect.any(Number),
          sentAt: expect.any(Number),
        }),
      ]);
      await expect(
        screen.getByRole("button", "Stop", { exact: true }),
      ).toBeVisible();
      return;
    }
    await screen.getByRole("button", "Stop", { exact: true }).click();
    await expect(
      screen.getByRole("status").filter({ hasText: task }),
    ).toHaveText(savedNotice("screen", "7 actions and 1 narrated phrase"));
    const [began, spoken, ended] = writes
      .filter(({ path }) => path === browserApiPaths.narration)
      .map(({ body }) => browserNarrationRequestSchema.parse(body));
    if (
      !began ||
      !("speaking" in began) ||
      !began.speaking ||
      !spoken ||
      !("text" in spoken) ||
      !ended ||
      !("speaking" in ended) ||
      ended.speaking
    ) {
      throw new Error(
        "Expected exactly a phrase start, the phrase and its end",
      );
    }
    expect(spoken.text).toBe(phrase.final);
    expect(spoken.startedAt).toBe(began.since);
    expect(spoken.startedAt).toBeLessThanOrEqual(spoken.endedAt);
    expect(began.sentAt).toBeLessThanOrEqual(spoken.sentAt);
    for (const { sentAt } of [began, spoken, ended]) {
      expect(Math.abs(Date.now() - sentAt)).toBeLessThan(10_000);
    }
    expect(writes.slice(2).map(({ path }) => path)).toEqual([
      browserApiPaths.narration,
      browserApiPaths.narration,
      browserApiPaths.narration,
      browserApiPaths.recording,
    ]);
    expect(writes.at(-1)).toEqual(
      wrote(browserApiPaths.recording, { action: "stop" }),
    );
  });
}

test("the Desktop web view uses on-device speech IPC and sends both phrases before Stop", async ({
  app,
  browser,
  screen,
}) => {
  const first = "I am opening the expenses page";
  const second = "Now the receipt from the taxi ride";
  const speech = await simulateBrowserSpeech(browser, {
    speech: "unsupported",
    desktop: "available",
    heard: [
      { type: "result", index: 0, text: "I am opening", final: false },
      { type: "result", index: 0, text: first, final: true },
      { type: "result", index: 1, text: "now the", final: false },
    ],
    atStop: [{ type: "result", index: 1, text: second, final: true }],
  });
  await serveNarrationPreference(browser, "on");
  const { writes } = await serveTeachBrowser(browser, {
    state: opened("screen"),
    recordingResult: { actions: 7, phrases: 0 },
  });
  await app.open(page);
  await (await nameRecording(screen, "screen")).click();
  await expect(
    screen.getByText("Narration is on. We're capturing your voice.", {
      exact: true,
    }),
  ).toBeVisible();
  const language = await browser.evaluate(() => navigator.language);
  expect(await speech.desktopCalls()).toEqual(
    expect.arrayContaining([
      { command: "plugin:openbot-desktop|speech_start", language },
    ]),
  );
  await expect
    .poll(
      () =>
        writes.filter(({ path }) => path === browserApiPaths.narration).length,
    )
    .toBe(4);
  await screen.getByRole("button", "Stop", { exact: true }).click();
  await expect(screen.getByRole("status").filter({ hasText: task })).toHaveText(
    savedNotice("screen", "7 actions and 2 narrated phrases"),
  );
  expect(await speech.desktopCalls()).toEqual(
    expect.arrayContaining([{ command: "plugin:openbot-desktop|speech_stop" }]),
  );
  const narration = writes
    .filter(({ path }) => path === browserApiPaths.narration)
    .map(({ body }) => browserNarrationRequestSchema.parse(body))
    .map((body) => ("text" in body ? body.text : body.speaking));
  expect(narration).toEqual([true, first, false, true, second, false]);
  expect(writes.at(-1)).toEqual(
    wrote(browserApiPaths.recording, { action: "stop" }),
  );
  await expect(screen.getByText(narrationOff, { exact: true })).toHaveCount(0);
  expect(await speech.recognitions()).toEqual([]);
});

test("a Desktop speech failure stays off after Stop until the person turns it on again", async ({
  app,
  browser,
  screen,
}) => {
  const speech = await simulateBrowserSpeech(browser, {
    speech: "unsupported",
    desktop: "available",
    error: "audio-capture",
  });
  const { changes } = await serveNarrationPreference(browser, "on");
  const { recordingWrites } = await narrationRecording(browser, "screen");
  await app.open(page);
  const record = screen.getByRole("button", "Record", { exact: true });
  const start = screen.getByRole("button", "Start recording", { exact: true });
  const name = screen.getByRole("textbox", "Task name", { exact: true });
  const toggle = narrationToggle(screen);
  const off = screen.getByText(narrationOff, { exact: true });
  const stop = screen.getByRole("button", "Stop", { exact: true });
  const language = await browser.evaluate(() => navigator.language);
  const desktopStarts = async () => {
    const calls = await speech.desktopCalls();
    if (!Array.isArray(calls))
      throw new Error("Expected recorded Desktop calls");
    return calls.filter(
      (call) => call.command === "plugin:openbot-desktop|speech_start",
    );
  };
  await (await nameRecording(screen, "screen")).click();
  await expect(off).toBeVisible();
  await expect(toggle).toHaveAttribute("aria-checked", "false");
  expect(await desktopStarts()).toEqual([
    { command: "plugin:openbot-desktop|speech_start", language },
  ]);
  await stop.click();
  await record.click();
  await expect(toggle).toHaveAttribute("aria-checked", "false");
  await expect(off).toHaveCount(0);
  await toggle.click();
  await expect(toggle).toHaveAttribute("aria-checked", "true");
  expect(await desktopStarts()).toHaveLength(1);
  await name.fill("Submit the taxi receipt");
  await start.click();
  await expect(off).toBeVisible();
  await expect(toggle).toHaveAttribute("aria-checked", "false");
  expect(await desktopStarts()).toHaveLength(2);
  await speech.setError("");
  await toggle.click();
  await expect(
    screen.getByText("Narration is on. We're capturing your voice.", {
      exact: true,
    }),
  ).toBeVisible();
  await expect(toggle).toHaveAttribute("aria-checked", "true");
  expect(await desktopStarts()).toHaveLength(3);
  await stop.click();
  await record.click();
  await expect(toggle).toHaveAttribute("aria-checked", "true");
  await expect(off).toHaveCount(0);
  expect(recordingWrites()).toEqual([
    wrote(browserApiPaths.recording, {
      action: "start",
      title: task,
      language,
      narrate: true,
    }),
    wrote(browserApiPaths.recording, { action: "stop" }),
    wrote(browserApiPaths.recording, {
      action: "start",
      title: "Submit the taxi receipt",
      language,
      narrate: true,
    }),
    wrote(browserApiPaths.recording, { action: "stop" }),
  ]);
  expect(changes).toEqual([{ narration: "on" }, { narration: "on" }]);
});
