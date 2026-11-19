import type { Message } from "@ag-ui/core";
import {
  CopilotChatConfigurationProvider,
  CopilotKitProvider,
} from "@copilotkit/react-core/v2";
import { QueryClientProvider } from "@tanstack/react-query";
import { createRoot } from "react-dom/client";
import { ChatTranscript } from "@/components/channels/chat-transcript";
import { queryClient } from "@/query-client";
import "@/styles.css";
import {
  answered,
  handedBack,
  type RecordedSubtask,
} from "../subagent.fixture";

function turn(subtask: RecordedSubtask, settled: boolean): Message[] {
  return [
    {
      id: "ask",
      role: "user",
      content: "Which account needs attention first?",
    },
    {
      id: "call-message",
      role: "assistant",
      content: "",
      toolCalls: [
        {
          id: subtask.call.id,
          type: "function",
          function: { name: subtask.call.name, arguments: subtask.call.args },
        },
      ],
    },
    ...(settled
      ? [
          {
            id: "result",
            role: "tool" as const,
            toolCallId: subtask.call.id,
            content: subtask.result,
          },
        ]
      : []),
  ];
}

const state = new URLSearchParams(location.search).get("state");
const working = state === "working" || state === "parallel";
const task =
  state === "handed-back"
    ? handedBack
    : state === "refused"
      ? {
          ...answered,
          result: JSON.stringify(
            "Refused. No subagent was started: one answer can start up to 5 subagents, and this one has. Do this part yourself.",
          ),
        }
      : answered;
const messages = turn(task, !working && state !== "stopped");
if (state === "parallel")
  messages.push(
    ...turn(handedBack, false)
      .slice(1)
      .map((message) => ({ ...message, id: "parallel-call" })),
  );
const root = document.getElementById("root");
if (!root) throw new Error("Missing subtask fixture root");
createRoot(root).render(
  <QueryClientProvider client={queryClient}>
    <CopilotKitProvider>
      <CopilotChatConfigurationProvider
        agentId="general-assistant"
        threadId={task.parentThreadId}
      >
        <ChatTranscript busy={working} messages={messages} restoring={false} />
      </CopilotChatConfigurationProvider>
    </CopilotKitProvider>
  </QueryClientProvider>,
);
