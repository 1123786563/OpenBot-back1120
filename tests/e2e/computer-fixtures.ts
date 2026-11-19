import type { Browser } from "@e2e-dev/web";
import type { ComputerControlState } from "../../shared/computer-control";
import { observeLiveScreen } from "./browser-screen-stream";
import { configureChatStream } from "./chat-stream";
import { createConversation } from "./conversations";
import { createBot } from "./signed-in";

export const screenshot =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aB1sAAAAASUVORK5CYII=";
export const site = "https://computer-fixture.example.test/reports";
export const shotFailure = "The computer did not respond.";
type ComputerState = "ready" | "starting" | "absent" | "unreachable";
type Frame = "frame" | "failure" | Exclude<ComputerState, "ready">;

export async function serveComputer(
  browser: Browser,
  botId: string,
  initial: { status: ComputerState; frame: Frame },
  viewer?: string,
) {
  const base = `/api/computers/${encodeURIComponent(botId)}`;
  let status = initial.status;
  let frame = initial.frame;
  let screenshots = 0;
  let framesServed = 0;
  let controlReads = 0;
  let successfulControlReads = 0;
  let failedControlReads = 0;
  let controlFailuresRemaining = 0;
  let takeStatus: Promise<200 | 503> = Promise.resolve(200);
  let waitForControlRead: Promise<void> | undefined;
  let waitForScreenshot: Promise<void> | undefined;
  let pageUrl = site;
  const handoffs: { action: string; body: unknown }[] = [];
  let control: ComputerControlState = {
    holder: "bot",
    since: new Date().toISOString(),
    requested: false,
    transitioning: false,
    resumeSnapshotRequired: false,
    recoveryRequired: false,
  };
  await browser.route(
    new RegExp(
      `${RegExp.escape(base)}/(?:status|screenshot|control(?:/(?:request|take|release))?|activity|browser)(?:\\?[^#]*)?$`,
    ),
    async (route) => {
      const path = new URL(route.request.url).pathname;
      if (path.endsWith("/status")) {
        return route.fulfill({
          json: {
            botId,
            state: status,
            ...(status === "unreachable" ? { reason: "supervisor down" } : {}),
          },
        });
      }
      if (path.endsWith("/control")) {
        controlReads++;
        if (controlFailuresRemaining > 0) {
          controlFailuresRemaining--;
          await route.fulfill({ status: 502, json: { error: "Unavailable" } });
          failedControlReads++;
          return;
        }
        await waitForControlRead;
        await route.fulfill({ json: control });
        successfulControlReads++;
        return;
      }
      if (
        path.startsWith(`${base}/control/`) &&
        route.request.method === "POST" &&
        viewer
      ) {
        const action = path.slice(`${base}/control/`.length);
        const body: unknown = JSON.parse(route.request.postData ?? "null");
        handoffs.push({ action, body });
        if (action === "request") {
          if (
            !body ||
            typeof body !== "object" ||
            !("reason" in body) ||
            typeof body.reason !== "string"
          ) {
            return route.fulfill({
              status: 400,
              json: { error: "Missing handoff reason" },
            });
          }
          const source =
            "source" in body && body.source === "manual" ? "manual" : "model";
          const toolCallId =
            "toolCallId" in body && typeof body.toolCallId === "string"
              ? body.toolCallId
              : undefined;
          control = {
            ...control,
            requested: true,
            ...(source === "model" ? { reason: body.reason } : {}),
            request: {
              id: source === "manual" ? "terminal-handoff" : "help-handoff",
              reason: body.reason,
              source,
              ...(toolCallId ? { toolCallId } : {}),
              status: "waiting",
              createdAt: control.since,
              updatedAt: control.since,
            },
          };
        } else {
          if (action === "take" && (await takeStatus) === 503)
            return route.fulfill({
              status: 503,
              json: { error: "Unavailable" },
            });
          const { heldBy: _holder, reason, request, ...rest } = control;
          if (
            !request ||
            !body ||
            typeof body !== "object" ||
            !("requestId" in body) ||
            body.requestId !== request.id
          ) {
            return route.fulfill({
              status: 400,
              json: { error: "Missing handoff request" },
            });
          }
          control = {
            ...rest,
            requested: false,
            holder: action === "take" ? "human" : "bot",
            request: {
              ...request,
              status: action === "take" ? "taken" : "completed",
            },
            ...(action === "take"
              ? { heldBy: viewer, ...(reason ? { reason } : {}) }
              : {}),
          };
        }
        return route.fulfill({ json: control });
      }
      if (path.endsWith("/activity"))
        return route.fulfill({ json: { entries: [] } });
      if (path.endsWith("/browser"))
        return route.fulfill({
          json: { open: true, mine: false, recordingIsMine: false, tabs: [] },
        });
      screenshots++;
      await waitForScreenshot;
      if (frame === "failure")
        return route.fulfill({ status: 503, json: { error: shotFailure } });
      if (frame !== "frame")
        return route.fulfill({
          json: {
            ready: false,
            state: frame,
            ...(frame === "unreachable" ? { reason: "supervisor down" } : {}),
          },
        });
      await route.fulfill({
        json: {
          base64: screenshot,
          width: 320,
          height: 200,
          capturedAt: new Date().toISOString(),
          url: pageUrl,
        },
      });
      framesServed++;
    },
  );
  return {
    set(next: typeof initial) {
      status = next.status;
      frame = next.frame;
    },
    screenshots: () => screenshots,
    framesServed: () => framesServed,
    controlReads: () => controlReads,
    successfulControlReads: () => successfulControlReads,
    failedControlReads: () => failedControlReads,
    failControlReads(count: number) {
      controlFailuresRemaining = count;
    },
    delaySuccessfulControlReads(until: Promise<void>) {
      waitForControlRead = until;
    },
    respondToTake(status: Promise<200 | 503>) {
      takeStatus = status;
    },
    setTransitioning(transitioning: boolean) {
      control = { ...control, transitioning };
    },
    holdForViewer() {
      if (!viewer)
        throw new Error("No test viewer configured for Computer control");
      control = {
        ...control,
        holder: "human",
        heldBy: viewer,
        request: {
          id: "existing-handoff",
          source: "manual",
          status: "taken",
          reason: "The viewer already took control.",
          createdAt: control.since,
          updatedAt: control.since,
        },
      };
    },
    delayScreenshots(until: Promise<void>) {
      waitForScreenshot = until;
    },
    setPage(url: string) {
      pageUrl = url;
    },
    handoffs,
  };
}

export type Fixtures = Parameters<typeof createBot>[0];

export async function readComputerViewer(browser: Browser) {
  return browser.evaluate(async () => {
    const response = await fetch("/api/me");
    if (!response.ok) throw new Error("Couldn't read the Computer viewer");
    const data: { user: { id: string } } = await response.json();
    return data.user.id;
  });
}

export async function computerConversation(
  fixtures: Fixtures,
  initial: { status: ComputerState; frame: Frame },
  {
    search = "?watch=true",
    history = [],
    readHistory = () => history,
    holdReconnect = false,
    terminal = false,
    blankName = false,
    prepare,
  }: {
    search?: string;
    history?: object[];
    readHistory?: () => readonly object[];
    holdReconnect?: boolean;
    terminal?: boolean;
    blankName?: boolean;
    prepare?: (state: Awaited<ReturnType<typeof serveComputer>>) => void;
  } = {},
) {
  const { app, browser } = fixtures;
  const bot = await createBot(fixtures);
  const channel = await createConversation(browser, bot.id);
  if (blankName) {
    await browser.route(
      new RegExp(`/api/channels/${RegExp.escape(channel)}$`),
      async (route) => {
        const response = await route.fetch();
        const body = await response.json<{ channel: { name: string } }>();
        const { name: _name, ...unnamed } = body.channel;
        return route.fulfill({
          json: { ...body, channel: unnamed },
        });
      },
    );
  }
  const viewer = terminal ? await readComputerViewer(browser) : undefined;
  await configureChatStream(browser, readHistory, async () => readHistory());
  const state = await serveComputer(browser, bot.id, initial, viewer);
  prepare?.(state);
  const terminalState = terminal
    ? await serveTerminalStream(browser, bot.id)
    : null;
  const observe = await observeLiveScreen(browser, bot.id, holdReconnect);
  const path = `/channel/${channel}`;
  await app.open(`${path}${search}`);
  return { bot, state, observe, path, terminalState };
}

export const terminalOutput =
  "~ $ echo hello from the Bot\r\nhello from the Bot\r\n~ $ ";

export async function serveTerminalStream(browser: Browser, botId: string) {
  const expectedPath = `/api/computers/${encodeURIComponent(botId)}/terminal`;
  await browser.addInitScript(
    ({ expectedPath, terminalOutput }) => {
      const RealSocket = window.WebSocket;
      const records: {
        path: string;
        binaryType: string;
        closed: boolean;
        sent: unknown[];
      }[] = [];
      Object.defineProperty(window, "terminalFixture", { value: records });
      class TerminalSocket {
        readyState: number = RealSocket.OPEN;
        binaryType = "blob";
        onopen: (() => void) | null = null;
        onclose: (() => void) | null = null;
        onmessage: ((event: { data: unknown }) => void) | null = null;
        record = {
          path: expectedPath,
          binaryType: "",
          closed: false,
          sent: [] as unknown[],
        };
        constructor() {
          records.push(this.record);
          queueMicrotask(() => {
            if (this.readyState !== RealSocket.OPEN) return;
            this.onopen?.();
            this.record.binaryType = this.binaryType;
            this.onmessage?.({
              data: JSON.stringify({ type: "snapshot", cols: 80, rows: 24 }),
            });
            this.onmessage?.({
              data: new TextEncoder().encode(terminalOutput).buffer,
            });
            this.onmessage?.({ data: JSON.stringify({ type: "ready" }) });
          });
        }
        send(payload: string) {
          this.record.sent.push(JSON.parse(payload));
        }
        close() {
          this.readyState = RealSocket.CLOSED;
          this.record.closed = true;
        }
      }
      window.WebSocket = new Proxy(RealSocket, {
        construct(target, args) {
          const path = new URL(String(args[0]), location.origin).pathname;
          return path === expectedPath
            ? new TerminalSocket()
            : Reflect.construct(target, args);
        },
      });
    },
    { expectedPath, terminalOutput },
  );
  return {
    expectedPath,
    read: async (): Promise<
      {
        path: string;
        binaryType: string;
        closed: boolean;
        sent: Record<string, unknown>[];
      }[]
    > => {
      const json = await browser.evaluate(() =>
        JSON.stringify(Reflect.get(window, "terminalFixture")),
      );
      return JSON.parse(json);
    },
  };
}

export function computerStep(
  id: string,
  name: string,
  args: object,
  result: object,
) {
  return [
    {
      id: `call-message-${id}`,
      role: "assistant",
      content: "",
      toolCalls: [
        {
          id,
          type: "function",
          function: { name, arguments: JSON.stringify(args) },
        },
      ],
    },
    {
      id: `result-${id}`,
      role: "tool",
      toolCallId: id,
      content: JSON.stringify(result),
    },
  ];
}
