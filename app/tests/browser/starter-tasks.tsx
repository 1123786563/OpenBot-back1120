import { StarterSuggestions } from "@/components/starter-tour/starter-suggestions";
import { authKeys } from "@/lib/auth/queries";
import { queryClient } from "@/query-client";
import "@/styles.css";
import { QueryClientProvider } from "@tanstack/react-query";
import {
  createMemoryHistory,
  createRootRoute,
  createRouter,
  RouterProvider,
} from "@tanstack/react-router";
import { useState } from "react";
import { createRoot } from "react-dom/client";

const params = new URLSearchParams(location.search);
const scenario = params.get("scenario");

function Tour() {
  const [sent, setSent] = useState<string[]>([]);
  const [attempts, setAttempts] = useState(0);
  const [pending, setPending] = useState<PromiseWithResolvers<void>>();
  const [busy, setBusy] = useState(scenario === "busy");
  const onSelect = async (message: string) => {
    setAttempts(attempts + 1);
    if (scenario === "retry" && attempts === 0)
      throw new Error("Task could not start. Try again.");
    setSent((previous) => [...previous, message]);
    if (scenario === "busy") {
      const operation = Promise.withResolvers<void>();
      setPending(operation);
      await operation.promise;
      setPending(undefined);
    }
  };
  return (
    <main className="mx-auto w-full max-w-2xl">
      {scenario === "busy" && (
        <>
          <button type="button" onClick={() => setBusy(false)}>
            Enable tasks
          </button>
          <button type="button" onClick={() => pending?.resolve()}>
            Finish sending
          </button>
        </>
      )}
      {scenario === "account" && (
        <button
          type="button"
          onClick={() =>
            queryClient.setQueryData(authKeys.currentUser(), {
              id: "second",
              name: "Second person",
              onboarding: null,
            })
          }
        >
          Switch account
        </button>
      )}
      <StarterSuggestions
        agentId={params.get("bot") ?? "picked-harness"}
        channelId={params.get("channel") ?? undefined}
        disabled={busy}
        onSelect={onSelect}
      />
      <form data-slot="composer" className="h-12 rounded border px-3">
        <label>
          <input aria-label="Message" />
        </label>
      </form>
      <output aria-label="Submitted tasks">{JSON.stringify(sent)}</output>
    </main>
  );
}

const router = createRouter({
  routeTree: createRootRoute({ component: Tour }),
  history: createMemoryHistory(),
});
const root = document.getElementById("root");
if (!root) throw new Error("Missing Starter Tour fixture root");
createRoot(root).render(
  <QueryClientProvider client={queryClient}>
    <RouterProvider router={router} />
  </QueryClientProvider>,
);
