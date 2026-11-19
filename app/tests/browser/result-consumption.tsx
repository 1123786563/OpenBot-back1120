import type { Message } from "@ag-ui/core";
import {
  CopilotChatConfigurationProvider,
  CopilotChatMessageView,
  CopilotKitProvider,
} from "@copilotkit/react-core/v2";
import { useState } from "react";
import { createRoot } from "react-dom/client";
import { ChatTranscript } from "@/components/channels/chat-transcript";
import { TelemetryAssistantMessage } from "@/components/channels/telemetry-assistant-message";
import "@/styles.css";

const params = new URLSearchParams(location.search);
const direct = params.has("direct");
const threadId = params.has("unlinked") ? undefined : "telemetry-thread";
const messages: Message[] = [
  { id: "person", role: "user", content: "Show the result" },
  { id: "answer", role: "assistant", content: "This is the completed answer." },
];
if (params.has("second"))
  messages.push({
    id: "second-answer",
    role: "assistant",
    content: "A second part of the answer.",
  });
const nextTurn: Message[] = [
  ...messages,
  { id: "next-prompt", role: "user", content: "Another question" },
  { id: "next-answer", role: "assistant", content: "Still working" },
];

function Fixture() {
  const [continued, setContinued] = useState(false);
  const [clipped, setClipped] = useState(params.has("clipped"));
  const [busy, setBusy] = useState(params.has("busy"));
  const [revision, setRevision] = useState(0);
  const [belowFold, setBelowFold] = useState(params.has("below-fold"));
  return (
    <main>
      <button type="button" onClick={() => setBusy(!busy)}>
        Toggle run
      </button>
      <button type="button" onClick={() => setRevision(revision + 1)}>
        Remount answer
      </button>
      <button type="button" onClick={() => setBelowFold(!belowFold)}>
        Move answer
      </button>
      <button type="button" onClick={() => setContinued(true)}>
        Begin next turn
      </button>
      <button type="button" onClick={() => setClipped(false)}>
        Reveal answer
      </button>
      <output aria-label="Run state">{busy ? "Working" : "Settled"}</output>
      {belowFold && <div style={{ height: "110vh" }} />}
      <section
        key={revision}
        className="mx-auto max-w-2xl"
        style={clipped ? { height: 0, overflow: "hidden" } : undefined}
      >
        {direct ? (
          <CopilotChatConfigurationProvider threadId={threadId}>
            <CopilotChatMessageView
              messages={continued ? nextTurn : messages}
              assistantMessage={TelemetryAssistantMessage}
              isRunning={busy}
            />
          </CopilotChatConfigurationProvider>
        ) : (
          <ChatTranscript
            busy={busy}
            messages={messages}
            threadId={threadId}
            restoring={false}
          />
        )}
      </section>
    </main>
  );
}

const root = document.getElementById("root");
if (!root) throw new Error("Missing result telemetry fixture root");
createRoot(root).render(
  <CopilotKitProvider enableInspector={false}>
    <Fixture />
  </CopilotKitProvider>,
);
