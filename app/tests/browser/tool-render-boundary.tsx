import { useState } from "react";
import { createRoot } from "react-dom/client";
import {
  ToolRenderBoundary,
  toolCallFinal,
} from "@/components/channels/tool-boundary";
import { ArgumentsArrivingContext } from "@/components/gallery/streaming";
import "@/styles.css";

function Chart({ ready }: { ready: boolean }) {
  if (!ready) throw new Error("Fixture render failed");
  return <p>Chart rendered</p>;
}

function ToolCard() {
  const scenario = new URLSearchParams(location.search).get("scenario");
  const [nextChunk, setNextChunk] = useState(false);
  const args = nextChunk ? '{"options":["a","b"]}' : '{"options":["a"';
  const final =
    scenario === "final" ||
    (scenario === "decision" && toolCallFinal('{"options":"a, b"}', undefined));

  return (
    <main>
      <p>The conversation is still visible.</p>
      <button type="button" onClick={() => setNextChunk(true)}>
        Deliver next chunk
      </button>
      <section aria-label="Tool card">
        <ArgumentsArrivingContext.Provider value={scenario !== "stopped"}>
          <ToolRenderBoundary
            name={scenario === "decision" ? "Choice" : "Chart"}
            final={final}
            resetKey={scenario === "no-key" ? undefined : args}
          >
            <Chart ready={nextChunk} />
          </ToolRenderBoundary>
        </ArgumentsArrivingContext.Provider>
      </section>
    </main>
  );
}

const root = document.getElementById("root");
if (!root) throw new Error("Missing browser test root");
createRoot(root).render(<ToolCard />);
