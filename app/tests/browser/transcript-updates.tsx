import type { Message } from "@ag-ui/core";
import { CopilotKitProvider } from "@copilotkit/react-core/v2";
import { QueryClientProvider } from "@tanstack/react-query";
import { useState } from "react";
import { flushSync } from "react-dom";
import { createRoot } from "react-dom/client";
import { ChatTranscript } from "@/components/channels/chat-transcript";
import { useTranscriptPages } from "@/components/channels/transcript-pages";
import { type VoiceChatEntry, withVoiceChats } from "@/lib/voice/archive";
import { queryClient } from "@/query-client";
import "@/styles.css";

const rowIds = (count: number, prefix = "r") =>
  Array.from({ length: count }, (_, index) => `${prefix}${index}`);
const initial = rowIds(100);
const history = [
  { id: "u1", role: "user", content: "Planning a shipment" },
  { id: "a1", role: "assistant", content: "When does it leave?" },
  { id: "u2", role: "user", content: "Friday morning" },
  { id: "a2", role: "assistant", content: "I have the details." },
] satisfies Message[];

function Pages() {
  const [ids, setIds] = useState(initial);
  const { from, split, drawEarlier, drawTo } = useTranscriptPages(ids, false);
  return (
    <main>
      <button type="button" onClick={() => drawTo(33)}>
        Jump to row 33
      </button>
      <button type="button" onClick={() => drawTo(50)}>
        Jump to row 50
      </button>
      <button
        type="button"
        onClick={() => setIds([...rowIds(5, "recovered"), ...initial])}
      >
        Recover rows above
      </button>
      <button type="button" onClick={drawEarlier}>
        Draw earlier page
      </button>
      <button
        type="button"
        onClick={() => setIds(initial.filter((id) => id !== "r3"))}
      >
        Remove earlier rows
      </button>
      <ol aria-label="Earlier rows" start={from + 1}>
        {ids.slice(from, split).map((id) => (
          <li key={id}>{id}</li>
        ))}
      </ol>
      <ol aria-label="Opening rows" start={split + 1}>
        {ids.slice(split).map((id) => (
          <li key={id}>{id}</li>
        ))}
      </ol>
    </main>
  );
}

function VoiceArrival({ live }: { live: boolean }) {
  const [calls, setCalls] = useState<VoiceChatEntry[]>([]);
  const [initialOpacity, setInitialOpacity] = useState<string>();
  function addCall() {
    const startedAt = Date.now() + (live ? 1000 : -3_600_000);
    flushSync(() =>
      setCalls([
        {
          id: "shipment",
          channelId: "fixture",
          anchorMessageId: "a1",
          startedAt: new Date(startedAt).toISOString(),
          endedAt: new Date(startedAt + 60_000).toISOString(),
          transcript: [],
          durationSeconds: 60,
          summary: "The shipment leaves Friday.",
          summaryStatus: "ready",
        },
      ]),
    );
    const animation = document.querySelector(
      '[data-message-id="voice-chat:shipment"] [data-slot="message-arriving"]',
    );
    if (!animation) throw new Error("Missing voice row entrance");
    setInitialOpacity(getComputedStyle(animation).opacity);
  }
  return (
    <main>
      <button type="button" onClick={addCall}>
        Deliver voice chat
      </button>
      {initialOpacity && (
        <output aria-label="Initial voice opacity">{initialOpacity}</output>
      )}
      <ChatTranscript
        messages={withVoiceChats(history, calls)}
        restoring={false}
      />
    </main>
  );
}

function GmailSteps() {
  const [answered, setAnswered] = useState(false);
  const [busy, setBusy] = useState(true);
  const query: Message = {
    id: "emails",
    role: "user",
    content: "Summarize my newest emails.",
  };
  const steps = Array.from({ length: 5 }, (_, index): Message[] => {
    const id = `mail-${index}`;
    const tool =
      index === 4 ? "GMAIL_FETCH_MESSAGE_BY_THREAD_ID" : "GMAIL_FETCH_EMAILS";
    const call: Message = {
      id: `assistant-${id}`,
      role: "assistant",
      content: "",
      toolCalls: [
        {
          id,
          type: "function",
          function: {
            name: `mcp__composio-gmail__${tool}`,
            arguments: JSON.stringify({ page: index + 1 }),
          },
        },
      ],
    };
    return index === 4 && !answered
      ? [call]
      : [
          call,
          {
            id: `result-${id}`,
            role: "tool",
            toolCallId: id,
            content: '{"messages":[{"subject":"Quarterly numbers"}]}',
          },
        ];
  }).flat();
  return (
    <main>
      <button type="button" onClick={() => setAnswered(true)}>
        Deliver final tool result
      </button>
      <button type="button" onClick={() => setBusy(false)}>
        Finish working
      </button>
      <ChatTranscript
        busy={busy}
        messages={[query, ...steps]}
        restoring={false}
      />
    </main>
  );
}

function SearchUpdates({ running }: { running: boolean }) {
  const [chunk, setChunk] = useState(0);
  const [call] = useState(() => ({
    id: "search-second",
    type: "function" as const,
    function: {
      name: "web_search",
      arguments: running ? "" : '{"q":"second query"}',
    },
  }));
  const messages: Message[] = [
    { id: "look-up", role: "user", content: "Look up weekend events." },
    {
      id: "searches",
      role: "assistant",
      content: "",
      toolCalls: [
        {
          id: "search-first",
          type: "function",
          function: { name: "web_search", arguments: '{"q":"first query"}' },
        },
        call,
      ],
    },
    {
      id: "result-first",
      role: "tool",
      toolCallId: "search-first",
      content: "First source",
    },
  ];
  if (!running)
    messages.push(
      {
        id: "result-second",
        role: "tool",
        toolCallId: "search-second",
        content: "Second source",
      },
      {
        id: "reply-stream",
        role: "assistant",
        content: `Here are the events.${Array.from({ length: chunk }, (_, index) => ` Event ${index + 1}.`).join("")}`,
      },
    );
  return (
    <main>
      <button
        type="button"
        onClick={() => {
          if (running) call.function.arguments = '{"q":"second query"}';
          setChunk(chunk + 1);
        }}
      >
        {running ? "Deliver search arguments" : "Stream another event"}
      </button>
      <ChatTranscript busy messages={messages} restoring={false} />
    </main>
  );
}

const scenario = new URLSearchParams(location.search).get("scenario");
const root = document.getElementById("root");
if (!root) throw new Error("Missing browser test root");
createRoot(root).render(
  scenario === "pages" ? (
    <Pages />
  ) : (
    <QueryClientProvider client={queryClient}>
      <CopilotKitProvider>
        {scenario === "gmail" ? (
          <GmailSteps />
        ) : scenario === "running-search" || scenario === "finished-search" ? (
          <SearchUpdates running={scenario === "running-search"} />
        ) : (
          <VoiceArrival live={scenario === "new-call"} />
        )}
      </CopilotKitProvider>
    </QueryClientProvider>
  ),
);
