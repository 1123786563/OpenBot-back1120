import { ProgressRow } from "@/components/channels/progress-row";
import { ToolLine } from "@/components/channels/tool-line";
import "@/styles.css";
import { createRoot } from "react-dom/client";

const label = "Read 1 file, searched for 2 patterns and listed 1 directory";
const detail = "ls -la /private/tmp/work";

const root = document.getElementById("root");
if (!root) throw new Error("The tool line fixture needs a root");
createRoot(root).render(
  <main className="mx-auto max-w-3xl px-4">
    <section aria-label="Wrap without disclosure">
      <ToolLine label={label} detail={detail} />
    </section>
    <section aria-label="Wrap with disclosure">
      <ToolLine label={label} detail={detail}>
        What came back
      </ToolLine>
    </section>
    <section aria-label="Running steps">
      <ToolLine label="Asked you" detail="Which city should I search?" running>
        Waiting for an answer.
      </ToolLine>
      <ProgressRow label="Asking Ana…" />
      <span data-testid="muted" className="text-muted-foreground">
        Muted text
      </span>
    </section>
  </main>,
);
