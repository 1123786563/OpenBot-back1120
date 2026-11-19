import type { Message } from "@ag-ui/core";
import { CopilotKitProvider } from "@copilotkit/react-core/v2";
import { QueryClientProvider } from "@tanstack/react-query";
import { createRoot } from "react-dom/client";
import { ChatTranscript } from "@/components/channels/chat-transcript";
import { CodingTools } from "@/lib/copilot/coding-tools";
import { queryClient } from "@/query-client";
import "@/styles.css";

const response = await fetch("/fixture/coding-transcript");
if (!response.ok)
  throw new Error(
    `Could not load coding transcript fixture: ${response.status}`,
  );
const { messages, busy } = (await response.json()) as {
  messages: Message[];
  busy: boolean;
};
const root = document.getElementById("root");
if (!root) throw new Error("Missing browser test root");
createRoot(root).render(
  <QueryClientProvider client={queryClient}>
    <CopilotKitProvider>
      <CodingTools />
      <ChatTranscript busy={busy} messages={messages} restoring={false} />
    </CopilotKitProvider>
  </QueryClientProvider>,
);
