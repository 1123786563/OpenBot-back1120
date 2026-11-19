import type { Message } from "@ag-ui/core";
import { CopilotKitProvider, useFrontendTool } from "@copilotkit/react-core/v2";
import { QueryClientProvider } from "@tanstack/react-query";
import { useState } from "react";
import { createRoot } from "react-dom/client";
import { ChatTranscript } from "@/components/channels/chat-transcript";
import { GALLERY as ACTIVITY } from "@/components/gallery/activity";
import { GALLERY as CARDS } from "@/components/gallery/cards";
import { GALLERY as CHARTS } from "@/components/gallery/charts";
import { GALLERY as DECISIONS } from "@/components/gallery/decisions";
import { GALLERY as FORMS } from "@/components/gallery/form";
import { GALLERY as QUOTES } from "@/components/gallery/quote";
import { GALLERY as TABLES } from "@/components/gallery/table";
import type { GalleryComponent } from "@/lib/copilot/gallery-registry";
import {
  makeDecisionRender,
  makeGalleryRender,
} from "@/lib/copilot/gallery-tools";
import { createGrantStore, type GrantStore } from "@/lib/copilot/grant-store";
import { queryClient } from "@/query-client";
import "@/styles.css";

/** The table call from the Windows run: `columns` lost both of its brackets. */
const BROKEN =
  '{"title":"Weekend picks in Chicago","caption":"Saturday Nov 7 to Sunday Nov 8","columns":"Event","When","Where","Source"],"rows":[{"cells":["Marathon expo","Sat 10am","McCormick Place","chicagomarathon.com"]}]}';

/** Claude Code refusing those arguments, as the harness streams it and keeps it in the history. */
const CLAUDE_CODE_REFUSED = JSON.stringify({
  error: true,
  content:
    "<tool_use_error>InputValidationError: mcp__ag_ui__showTable was called with input that could not be parsed as JSON</tool_use_error>",
});

/** CopilotKit's own answer to a call whose arguments it couldn't parse (`executeToolHandler`). */
const BROWSER_REFUSED = `Error: Unexpected token ',', ..."s":"Event","When","... is not valid JSON`;

const SHOWN: GalleryComponent[] = [
  ...TABLES,
  ...ACTIVITY,
  ...CARDS,
  ...CHARTS,
  ...QUOTES,
];
const ASKED: GalleryComponent[] = [...DECISIONS, ...FORMS];
const ALL = [...SHOWN, ...ASKED];

function spec(name: string): GalleryComponent {
  const found = ALL.find((candidate) => candidate.name === name);
  if (!found) throw new Error(`${name} is not in the gallery.`);
  return found;
}

/** One component registered as the app registers it, with the Bot holding all of them. */
function Registered({
  component,
  store,
}: {
  component: GalleryComponent;
  store: GrantStore;
}) {
  const [render] = useState(() =>
    component.kind === "decision"
      ? makeDecisionRender(component, store, async () => {})
      : makeGalleryRender(component, store),
  );
  useFrontendTool({
    name: component.name,
    parameters: component.parameters,
    handler: async () => component.confirmation ?? "",
    render,
    ...(component.kind === "decision"
      ? { type: "human-in-the-loop" as const }
      : {}),
  } as Parameters<typeof useFrontendTool>[0]);
  return null;
}

/** A turn of one call, answered with `result`, or still without one. */
function turn(name: string, args: string, result?: string): Message[] {
  return [
    {
      id: "u1",
      role: "user",
      content: "Find three things to do this weekend.",
    },
    {
      id: "a1",
      role: "assistant",
      content: "Here are three solid picks with dates and sources:",
      toolCalls: [
        { id: "call-1", type: "function", function: { name, arguments: args } },
      ],
    },
    ...(result === undefined
      ? []
      : [
          {
            id: "t1",
            role: "tool" as const,
            toolCallId: "call-1",
            content: result,
          },
        ]),
  ];
}

const params = new URLSearchParams(location.search);
const scenario = params.get("scenario") ?? "harness-reloaded";
const showComponent = params.get("component");
const partial = '{"title":"Weekend picks in Chi';
const selected = showComponent ? [spec(showComponent)] : ALL;

function GalleryCallState() {
  const [ended, setEnded] = useState(false);
  const busy =
    !ended && (scenario === "harness-live" || scenario === "waiting");
  const [store] = useState(() => {
    const grants = createGrantStore();
    grants.set({
      grants: {
        status: "known",
        held: new Map(
          ALL.map((component) => [component.name, component.description]),
        ),
      },
    });
    return grants;
  });
  return (
    <QueryClientProvider client={queryClient}>
      <main>
        {scenario === "waiting" ? (
          <button type="button" onClick={() => setEnded(true)}>
            End run
          </button>
        ) : null}
        {selected.map((component) => {
          const valid = scenario === "success" || scenario === "valid-refused";
          const args = valid
            ? JSON.stringify(component.preview)
            : scenario === "waiting"
              ? partial
              : scenario === "aborted"
                ? JSON.stringify({
                    title: "Refund this order?",
                    summary: "The customer was charged twice.",
                  })
                : BROKEN;
          const result =
            scenario === "waiting"
              ? undefined
              : scenario === "success" || scenario === "answered"
                ? component.confirmation
                : scenario === "browser"
                  ? BROWSER_REFUSED
                  : scenario === "aborted"
                    ? "Error: Human-in-the-loop interaction aborted"
                    : CLAUDE_CODE_REFUSED;
          return (
            <section aria-label={component.title} key={component.name}>
              <CopilotKitProvider>
                <Registered component={component} store={store} />
                <ChatTranscript
                  busy={busy}
                  messages={turn(component.name, args, result)}
                  restoring={false}
                />
              </CopilotKitProvider>
            </section>
          );
        })}
      </main>
    </QueryClientProvider>
  );
}

const root = document.getElementById("root");
if (!root) throw new Error("Missing browser test root");
createRoot(root).render(<GalleryCallState />);
