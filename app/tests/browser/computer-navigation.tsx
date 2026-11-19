import { QueryClientProvider } from "@tanstack/react-query";
import { useState } from "react";
import { createRoot } from "react-dom/client";
import { ComputerView } from "@/components/computer/computer-view";
import { failedComputerCall } from "@/lib/computers/call";
import { WAITING_FOR_PERSON } from "@/lib/copilot/approval-context";
import { NavigationStep } from "@/lib/copilot/computer-tools";
import { queryClient } from "@/query-client";
import "@/styles.css";

const computerId = "navigation-preview-fixture";
const url = "https://report-preview.example.test/order";
const title = "Fixture reports portal";
const page = { url, title };

const results = {
  refused: failedComputerCall(403, {
    error: 'Policy rule: page.host == "report-preview.example.test".',
  }),
  failed: failedComputerCall(502, { error: "net::ERR_NAME_NOT_RESOLVED" }),
  waiting: WAITING_FOR_PERSON,
};

function Preview() {
  const scenario = new URLSearchParams(location.search).get("scenario");
  const [finished, setFinished] = useState(false);
  if (scenario === "standalone-empty" || scenario === "standalone-page")
    return (
      <ComputerView
        computerId={computerId}
        active={false}
        finished
        toolCallId="historical-navigation"
        {...(scenario === "standalone-page" ? { page } : {})}
      />
    );
  if (scenario === "live")
    return (
      <>
        <button type="button" onClick={() => setFinished(true)}>
          Finish opening the page
        </button>
        <NavigationStep
          computerId={computerId}
          url={url}
          result={finished ? JSON.stringify({ ok: true, ...page }) : undefined}
          status={finished ? "complete" : "executing"}
          toolCallId="live-navigation"
        />
      </>
    );
  if (scenario === "refused" || scenario === "failed" || scenario === "waiting")
    return (
      <NavigationStep
        computerId={computerId}
        url={url}
        result={JSON.stringify(results[scenario])}
        status="complete"
        toolCallId={scenario}
      />
    );
  throw new Error("Unknown navigation preview scenario");
}

const root = document.getElementById("root");
if (!root) throw new Error("Missing browser test root");
createRoot(root).render(
  <QueryClientProvider client={queryClient}>
    <main aria-label="Navigation preview">
      <Preview />
    </main>
  </QueryClientProvider>,
);
