import type { Browser } from "@e2e-dev/web";
import { desktopNotificationPlugin } from "./fixtures/desktop-notification-plugin";

type Notice = { title?: string; body?: string; tag?: string; path?: string };
type DesktopNoticeCall = { command: string; args?: Record<string, unknown> };
export type BrowserNotices = Window & {
  fixtureFocus?: boolean;
  fixtureNotices?: Notice[];
  fixtureVisibility?: DocumentVisibilityState;
  fixtureNoticeActions?: { click: () => void; closed: () => boolean }[];
  fixtureDesktopCalls?: DesktopNoticeCall[];
  fixtureReleaseDesktopPermission?: () => void;
  fixtureRosterReady?: boolean;
  fixtureRosterEvents?: Record<string, unknown>[];
  __TAURI_INTERNALS__?: unknown;
};

export async function captureNotices(
  browser: Browser,
  options: {
    desktop?: "native" | "plugin";
    desktopPermission?: "delayed" | "first-unanswered";
    desktopWindows?: boolean;
    focus?: boolean;
    permission?: NotificationPermission;
    observeRoster?: boolean;
  } = {},
) {
  await browser.addInitScript(
    ({
      focus,
      permission,
      desktop,
      desktopPermission,
      plugin,
      observeRoster,
    }) => {
      const page = window as BrowserNotices;
      page.fixtureFocus = focus;
      page.fixtureNotices = [];
      page.fixtureNoticeActions = [];
      Object.defineProperty(document, "visibilityState", {
        get: () => page.fixtureVisibility ?? "visible",
      });
      document.hasFocus = () => page.fixtureFocus ?? true;
      class CapturedNotification {
        static readonly permission = permission;
        onclick?: () => void;
        private closed = false;
        constructor(
          title: string,
          options?: NotificationOptions & { extra?: { path?: string } },
        ) {
          page.fixtureNotices?.push({
            title,
            body: options?.body,
            tag: options?.tag,
            path: options?.extra?.path,
          });
          page.fixtureNoticeActions?.push({
            click: () => this.onclick?.(),
            closed: () => this.closed,
          });
        }
        close() {
          this.closed = true;
        }
      }
      Object.defineProperty(window, "Notification", {
        value: CapturedNotification,
        writable: true,
      });
      if (observeRoster) {
        page.fixtureRosterEvents = [];
        const NativeSocket = window.WebSocket;
        window.WebSocket = class extends NativeSocket {
          constructor(url: string | URL, protocols?: string | string[]) {
            super(url, protocols);
            if (!String(url).includes("/api/channels/events")) return;
            this.addEventListener("open", () => {
              page.fixtureRosterReady = true;
            });
            this.addEventListener("close", () => {
              page.fixtureRosterReady = false;
            });
            this.addEventListener("message", (event) => {
              page.fixtureRosterEvents?.push(JSON.parse(String(event.data)));
            });
          }
        };
      }
      if (desktop) {
        page.fixtureDesktopCalls = [];
        const permissionAnswer = Promise.withResolvers<boolean>();
        page.fixtureReleaseDesktopPermission = () =>
          permissionAnswer.resolve(true);
        let permissionReads = 0;
        page.__TAURI_INTERNALS__ = {
          transformCallback: () => 0,
          async invoke(command: string, args?: Record<string, unknown>) {
            page.fixtureDesktopCalls?.push({ command, args });
            switch (command) {
              case "plugin:notification|is_permission_granted":
                permissionReads++;
                if (desktopPermission === "delayed")
                  return permissionAnswer.promise;
                if (
                  desktopPermission === "first-unanswered" &&
                  permissionReads === 1
                )
                  return new Promise(() => {});
                return true;
              case "plugin:notification|request_permission":
                return "granted";
              case "plugin:openbot-desktop|notify":
                if (desktop === "plugin")
                  throw new Error("Native notify is unavailable");
                page.fixtureNotices?.push(args as Notice);
                return null;
              case "plugin:notification|notify": {
                const note = args?.options as Omit<Notice, "path"> & {
                  extra?: { path?: string };
                };
                page.fixtureNotices?.push({
                  title: note.title,
                  body: note.body,
                  tag: note.tag,
                  path: note.extra?.path,
                });
                return null;
              }
              default:
                return null;
            }
          },
        };
        new Function(plugin)();
      }
    },
    {
      focus: options.focus ?? true,
      permission: options.permission ?? "granted",
      desktop: options.desktop ?? null,
      desktopPermission: options.desktopPermission ?? null,
      plugin: options.desktop
        ? desktopNotificationPlugin.replace(
            "__TEMPLATE_windows__",
            String(options.desktopWindows ?? false),
          )
        : "",
      observeRoster: options.observeRoster ?? false,
    },
  );
  return () =>
    browser.evaluate(() => (window as BrowserNotices).fixtureNotices ?? []);
}
