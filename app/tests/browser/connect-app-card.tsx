import { AppAccessCard } from "@/components/channels/app-access-card";
import { ConnectAppCard } from "@/components/channels/connect-app-card";
import { ConversationProvider } from "@/lib/copilot/conversation";
import { queryClient } from "@/query-client";
import "@/styles.css";
import { QueryClientProvider } from "@tanstack/react-query";
import {
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
  Outlet,
  RouterProvider,
} from "@tanstack/react-router";
import { useState } from "react";
import { createRoot } from "react-dom/client";

function Conversation() {
  const [messages, setMessages] = useState<string[]>([]);
  const [latest, setLatest] = useState(true);
  return (
    <main>
      <ConversationProvider
        ask={(text) => setMessages((current) => [...current, text])}
      >
        <ConnectAppCard
          message="You have not connected your Notion account. Connect it and ask again."
          place={{ toolCallId: "fixture-notion-card", latest }}
          serverId="srv_notion"
          title="Notion"
        />
      </ConversationProvider>
      <button type="button" onClick={() => setLatest((current) => !current)}>
        Toggle latest message
      </button>
      <output data-testid="sent-messages">{messages.join("\n")}</output>
    </main>
  );
}

const rootRoute = createRootRoute({ component: Outlet });
const mode = new URLSearchParams(location.search).get("card");
const conversation = createRoute({
  getParentRoute: () => rootRoute,
  path: "/",
  component: () =>
    mode === "standalone" || mode === "no-bot" ? (
      <main>
        <AppAccessCard
          place={{ toolCallId: "fixture-gmail-card", latest: true }}
          prompt={{
            serverId: "composio-gmail",
            title: "Gmail",
            message: "Gmail needs a connection.",
            ...(mode === "standalone" ? { agentId: "fixture-gmail-bot" } : {}),
          }}
        />
      </main>
    ) : (
      <Conversation />
    ),
});
const settings = createRoute({
  getParentRoute: () => rootRoute,
  path: "/connections/$key",
  component: () => null,
});
const router = createRouter({
  routeTree: rootRoute.addChildren([conversation, settings]),
  history: createMemoryHistory(),
});
const root = document.getElementById("root");
if (!root) throw new Error("Missing connection card fixture root");

createRoot(root).render(
  <QueryClientProvider client={queryClient}>
    <RouterProvider router={router} />
  </QueryClientProvider>,
);
