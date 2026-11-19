import type { Message } from "@ag-ui/core";
import { CopilotKitProvider } from "@copilotkit/react-core/v2";
import { QueryClientProvider } from "@tanstack/react-query";
import { useState } from "react";
import { flushSync } from "react-dom";
import { createRoot } from "react-dom/client";
import { ChatTranscript } from "@/components/channels/chat-transcript";
import { usePacedReveal } from "@/components/channels/paced-reveal";
import { queryClient } from "@/query-client";
import "@/styles.css";

const words = Array.from({ length: 60 }, (_, index) => `word${index}`);
const history = words.join(" ");
const question: Message = {
  id: "u1",
  role: "user",
  content: "What did you find?",
};
const reply = (text: string): Message => ({
  id: "a1",
  role: "assistant",
  content: text,
});

function Transcript({ scenario }: { scenario: string | null }) {
  const [started, setStarted] = useState(scenario === "history");
  const [busy, setBusy] = useState(scenario !== "history");
  const [initial, setInitial] = useState<string>();
  const text =
    scenario === "sentence" ? "Here is a chart of your sales:" : history;
  return (
    <main>
      <button
        type="button"
        onClick={() => {
          flushSync(() => setStarted(true));
          setInitial(
            document.querySelector('[data-message-id="a1"]')?.textContent ?? "",
          );
        }}
      >
        Deliver reply
      </button>
      <button type="button" onClick={() => setBusy(false)}>
        Finish run
      </button>
      <output aria-label="Run state">{busy ? "Busy" : "Finished"}</output>
      {initial !== undefined && (
        <output aria-label="Initial reply">
          {initial.length === 0 ? "(empty)" : initial}
        </output>
      )}
      <ChatTranscript
        busy={busy}
        messages={started ? [question, reply(text)] : [question]}
        restoring={false}
      />
    </main>
  );
}

function NoFrames({ streaming }: { streaming: boolean }) {
  const [finished, setFinished] = useState(!streaming);
  const shown = usePacedReveal(
    finished ? history : words.slice(0, 30).join(" "),
    {
      live: true,
      streaming: !finished,
    },
  );
  return (
    <main>
      <button type="button" onClick={() => setFinished(true)}>
        Finish stream
      </button>
      <output aria-label="Revealed text">{shown}</output>
    </main>
  );
}

let now = 0;
let frameId = 0;
const pendingFrames = new Map<number, FrameRequestCallback>();

function installFrameClock() {
  performance.now = () => now;
  window.requestAnimationFrame = (callback) => {
    pendingFrames.set(++frameId, callback);
    return frameId;
  };
  window.cancelAnimationFrame = (id) => {
    pendingFrames.delete(id);
  };
}

function InterleavedFrames() {
  const [text, setText] = useState(() =>
    Array.from({ length: 200 }, (_, index) => `w${index}`).join(" "),
  );
  const shown = usePacedReveal(text, { live: true, streaming: true });
  return (
    <main>
      <button
        type="button"
        onClick={() => {
          for (let i = 0; i < 25; i++) {
            now += 10;
            flushSync(() => setText((previous) => `${previous} t${i}`));
            now += 6;
            const frames = [...pendingFrames.values()];
            pendingFrames.clear();
            flushSync(() => {
              for (const frame of frames) frame(now);
            });
          }
        }}
      >
        Deliver tokens between frames
      </button>
      <output aria-label="Revealed text">{shown}</output>
    </main>
  );
}

const scenario = new URLSearchParams(location.search).get("scenario");
if (scenario === "interleaved") installFrameClock();
const root = document.getElementById("root");
if (!root) throw new Error("Missing browser test root");
createRoot(root).render(
  <QueryClientProvider client={queryClient}>
    <CopilotKitProvider>
      {scenario === "no-frames" || scenario === "no-frames-streaming" ? (
        <NoFrames streaming={scenario === "no-frames-streaming"} />
      ) : scenario === "interleaved" ? (
        <InterleavedFrames />
      ) : (
        <Transcript scenario={scenario} />
      )}
    </CopilotKitProvider>
  </QueryClientProvider>,
);
