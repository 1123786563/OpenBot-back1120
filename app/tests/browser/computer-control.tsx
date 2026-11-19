import { QueryClientProvider } from "@tanstack/react-query";
import { Profiler, StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { ComputerControlButton } from "@/components/computer/computer-controls";
import { queryClient } from "@/query-client";
import "@/styles.css";

const root = document.getElementById("root");
if (!root) throw new Error("Missing browser test root");
const computerId = new URLSearchParams(location.search).get("computer");
if (!computerId) throw new Error("Missing Computer ID");

function countCommits(id: string) {
  const section = document.getElementById(id);
  if (section) {
    section.dataset.commits = String(
      Number(section.dataset.commits ?? "0") + 1,
    );
  }
}

createRoot(root).render(
  <StrictMode>
    <QueryClientProvider client={queryClient}>
      <main>
        <section id="preview-controls" aria-label="Preview controls">
          <Profiler id="preview-controls" onRender={countCommits}>
            <ComputerControlButton computerId={computerId} />
          </Profiler>
        </section>
        <section id="viewer-controls" aria-label="Viewer controls">
          <Profiler id="viewer-controls" onRender={countCommits}>
            <ComputerControlButton computerId={computerId} />
          </Profiler>
        </section>
      </main>
    </QueryClientProvider>
  </StrictMode>,
);
