import { QueryClientProvider } from "@tanstack/react-query";
import { createRoot } from "react-dom/client";
import { UpdateBanner } from "@/components/layout/update-banner";
import { type DesktopAppUpdate, desktopKeys } from "@/lib/desktop/queries";
import { queryClient } from "@/query-client";
import "@/styles.css";

/**
 * The update banner over a page at the width of OpenBot's content column. The desktop app is
 * the IPC Tauri injects (`__TAURI_INTERNALS__`), answering `update_offer` with `window.__offer`;
 * `window.__show(offer)` changes that answer and has the banner ask again, as its poll does.
 *
 * `?width=<px>` is the column's width.
 */
type Page = Window & {
  __show: (offer: DesktopAppUpdate) => Promise<void>;
  __TAURI_INTERNALS__: unknown;
  __updateCalls: { command: string; args?: Record<string, unknown> }[];
};
const page = window as unknown as Page;
const params = new URLSearchParams(location.search);
const width = Number(params.get("width") ?? 650);
if (params.get("theme") === "dark")
  document.documentElement.classList.add("dark");

let offer: DesktopAppUpdate = {
  version: params.get("version"),
  current: "1.0.0",
  installing: null,
  updatesItself: true,
  ready: null,
};
page.__updateCalls = [];
if (params.get("shell") !== "web") {
  page.__TAURI_INTERNALS__ = {
    invoke: async (command: string, args?: Record<string, unknown>) => {
      page.__updateCalls.push({ command, args });
      switch (command) {
        case "plugin:openbot-desktop|update_offer":
          if (params.get("shell") === "old")
            throw `command ${command} not found`;
          return sessionStorage.getItem("dismissed-update") === offer.version
            ? { ...offer, version: null }
            : offer;
        case "plugin:openbot-desktop|dismiss_update":
          if (args?.version === offer.version && offer.version)
            sessionStorage.setItem("dismissed-update", offer.version);
          return null;
        case "plugin:openbot-desktop|install_update":
          if (params.get("install") === "fail")
            throw "signature verification failed";
          return new Promise<void>(() => {});
        default:
          throw `command ${command} not found`;
      }
    },
    transformCallback: () => 0,
  };
}
page.__show = async (next) => {
  offer = next;
  await queryClient.invalidateQueries({ queryKey: desktopKeys.appUpdate });
};

const root = document.getElementById("root");
if (root)
  createRoot(root).render(
    <QueryClientProvider client={queryClient}>
      <div className="flex h-svh flex-col bg-background" style={{ width }}>
        <UpdateBanner />
        <h1 className="p-4 font-semibold text-2xl" data-below="">
          Start a conversation
        </h1>
      </div>
    </QueryClientProvider>,
  );
