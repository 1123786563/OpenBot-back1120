import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  createMemoryHistory,
  createRootRoute,
  createRouter,
  RouterProvider,
} from "@tanstack/react-router";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { DesktopReturn } from "@/components/desktop/desktop-return";
import "@/styles.css";

const app = new URLSearchParams(window.location.search).get("app");
const rootRoute = createRootRoute({
  component: () => (
    <DesktopReturn
      app={app ?? undefined}
      openDesktop={(link) =>
        performance.mark("open-desktop-attempt", { detail: link })
      }
    />
  ),
});
const router = createRouter({
  routeTree: rootRoute,
  history: createMemoryHistory(),
});
const root = document.getElementById("root");
if (!root) throw new Error("Missing desktop return fixture root");

createRoot(root).render(
  <StrictMode>
    <QueryClientProvider client={new QueryClient()}>
      <RouterProvider router={router as never} />
    </QueryClientProvider>
  </StrictMode>,
);
