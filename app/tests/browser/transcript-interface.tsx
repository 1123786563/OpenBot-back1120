import type { Message } from "@ag-ui/core";
import { CopilotKitProvider } from "@copilotkit/react-core/v2";
import { QueryClientProvider } from "@tanstack/react-query";
import { useState } from "react";
import { createRoot } from "react-dom/client";
import { ChatTranscript } from "@/components/channels/chat-transcript";
import { queryClient } from "@/query-client";
import "@/styles.css";

const callId = "trip-budget-interface";
const pendingMessages: Message[] = [
  { id: "question", role: "user", content: "Build a weekend trip budget." },
  {
    id: "tool-call",
    role: "assistant",
    content: "",
    toolCalls: [
      {
        id: callId,
        type: "function",
        function: { name: "render_ui", arguments: "{}" },
      },
    ],
  },
];
const completeMessages: Message[] = [
  ...pendingMessages,
  {
    id: "tool-result",
    role: "tool",
    toolCallId: callId,
    content: '{"rendered":true}',
  },
  { id: "reply", role: "assistant", content: "The trip budget is ready." },
];

function InterfaceStep() {
  const [done, setDone] = useState(false);
  return (
    <main>
      <button type="button" onClick={() => setDone(true)}>
        Finish drawing
      </button>
      <ChatTranscript
        busy={!done}
        messages={done ? completeMessages : pendingMessages}
        restoring={false}
      />
    </main>
  );
}

const root = document.getElementById("root");
if (!root) throw new Error("Missing browser test root");
createRoot(root).render(
  <QueryClientProvider client={queryClient}>
    <CopilotKitProvider>
      <InterfaceStep />
    </CopilotKitProvider>
  </QueryClientProvider>,
);
