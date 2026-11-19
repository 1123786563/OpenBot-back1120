import { ToolCallStatus } from "@copilotkit/react-core/v2";
import { useState } from "react";
import { createRoot } from "react-dom/client";
import { z } from "zod";
import { ArgumentsArrivingContext } from "@/components/gallery/streaming";
import { galleryComponent } from "@/lib/copilot/gallery-registry";
import {
  makeDecisionRender,
  makeGalleryRender,
  useDecisionTool,
} from "@/lib/copilot/gallery-tools";
import { createGrantStore } from "@/lib/copilot/grant-store";
import "@/styles.css";

const requiredComponent = (name: string) => {
  const component = galleryComponent(name);
  if (!component) throw new Error(`Missing Gallery component ${name}`);
  return component;
};

const chart = requiredComponent("showBarChart");
const approval = requiredComponent("askApproval");
const table = requiredComponent("showTable");
const params = z.object({ title: z.string(), value: z.number() });
const store = createGrantStore();
const grants = {
  status: "known" as const,
  held: new Map(
    [chart, approval, table].map((item) => [item.name, item.description]),
  ),
};
const Value = makeGalleryRender(
  {
    ...chart,
    parameters: params,
    Component: ({ title, value }) => (
      <p>
        {String(title)}: {String(value ?? "pending")}
      </p>
    ),
  },
  store,
);
const Chart = makeGalleryRender(chart, store);
const Table = makeGalleryRender(table, store);
const approvalArgs = {
  title: "Approve refund?",
  summary: "The customer was charged twice.",
};
const scenario = new URLSearchParams(location.search).get("scenario");

function GrantChanges() {
  const [stage, setStage] = useState("unknown");
  const [result, setResult] = useState<{
    call: string | undefined;
    answer: unknown;
  }>();
  const [Decision] = useState(() =>
    makeDecisionRender(approval, store, async (answer, call) => {
      setResult({ call, answer });
    }),
  );
  return (
    <main>
      <button
        type="button"
        onClick={() => {
          store.set({ grants });
          setStage("held");
        }}
      >
        Load grants and finish arguments
      </button>
      <button
        type="button"
        onClick={() => {
          store.set({
            refusals: new Map([
              ["call-2", "That component was just switched off."],
            ]),
          });
          setStage("revoked");
        }}
      >
        Refuse next call
      </button>
      <button
        type="button"
        onClick={() =>
          store.set({ grants: { status: "known", held: new Map() } })
        }
      >
        Load without grants
      </button>
      <button
        type="button"
        onClick={() => store.set({ grants: { status: "failed" } })}
      >
        Fail grant load
      </button>
      <section aria-label="Earlier call">
        <Value
          args={{ title: stage === "unknown" ? "Re" : "Revenue", value: 125 }}
          status={stage === "unknown" ? "inProgress" : "complete"}
          toolCallId="call-1"
        />
      </section>
      {stage === "revoked" && (
        <section aria-label="Later call">
          <Value
            args={{ title: "Later", value: 126 }}
            status="complete"
            toolCallId="call-2"
          />
        </section>
      )}
      <Decision
        args={approvalArgs}
        status="executing"
        toolCallId="approval-1"
      />
      {result && (
        <output aria-label="Submitted decision">
          {JSON.stringify(result)}
        </output>
      )}
    </main>
  );
}

function ArgumentStates() {
  const [done, setDone] = useState(false);
  return (
    <main>
      <button type="button" onClick={() => setDone(true)}>
        Finish stream
      </button>
      <section aria-label="Streaming number">
        <Value
          args={{ title: "Sales", value: done ? 125 : 12 }}
          status={done ? "complete" : "inProgress"}
        />
      </section>
      <section aria-label="Executing call">
        <Value args={{ title: "Sales", value: 125 }} status="executing" />
      </section>
      <section aria-label="Stopped call">
        <ArgumentsArrivingContext.Provider value={false}>
          <Value args={{ title: "Sales", value: 125 }} status="inProgress" />
        </ArgumentsArrivingContext.Provider>
      </section>
      <section aria-label="Streaming table">
        <Table
          args={{
            title: "Sales",
            columns: ["Quarter", "Revenue"],
            rows: [{ cells: ["Q1", 8] }, { cells: ["Q2", 9] }],
          }}
          status={done ? "complete" : "inProgress"}
        />
      </section>
      <section aria-label="Streaming chart">
        <Chart args={{ title: "Revenue" }} status="inProgress" />
      </section>
      <section aria-label="Finished empty chart">
        <Chart args={{ title: "Revenue", points: [] }} status="complete" />
      </section>
      <section aria-label="Stopped chart">
        <ArgumentsArrivingContext.Provider value={false}>
          <Chart args={{ title: "Revenue" }} status="inProgress" />
        </ArgumentsArrivingContext.Provider>
      </section>
    </main>
  );
}

const parallelCalls = [
  { id: "refund", title: "Refund the first order?" },
  { id: "cancel", title: "Cancel the second order?" },
];

function ParallelDecisions() {
  const [executing, setExecuting] = useState(false);
  const [answers, setAnswers] = useState<Record<string, unknown>>({});
  let registered:
    | Parameters<NonNullable<Parameters<typeof useDecisionTool>[3]>>[0]
    | undefined;
  useDecisionTool(approval, store, grants.held, (tool) => {
    registered = tool;
  });
  const tool = registered;
  if (!tool?.render || !tool.handler)
    throw new Error("Approval tool did not register");
  const { handler, render: Decision } = tool;
  return (
    <main>
      {!executing && (
        <button
          type="button"
          onClick={() => {
            for (const call of parallelCalls) {
              void Promise.resolve(
                handler(
                  {},
                  {
                    toolCall: {
                      id: call.id,
                      type: "function",
                      function: { name: approval.name, arguments: "{}" },
                    },
                  },
                ),
              ).then((answer) => {
                setAnswers((previous) => ({ ...previous, [call.id]: answer }));
              });
            }
            setExecuting(true);
          }}
        >
          Finish both requests
        </button>
      )}
      {parallelCalls.map((call) => (
        <section aria-label={call.title} key={call.id}>
          <Decision
            args={{ title: call.title, summary: approvalArgs.summary }}
            name={approval.name}
            result={undefined}
            status={
              executing ? ToolCallStatus.Executing : ToolCallStatus.InProgress
            }
            toolCallId={call.id}
          />
        </section>
      ))}
      <output aria-label="Decision results">{JSON.stringify(answers)}</output>
    </main>
  );
}

const root = document.getElementById("root");
if (!root) throw new Error("Missing browser test root");
if (scenario === "arguments" || scenario === "parallel") store.set({ grants });
createRoot(root).render(
  scenario === "parallel" ? (
    <ParallelDecisions />
  ) : scenario === "arguments" ? (
    <ArgumentStates />
  ) : (
    <GrantChanges />
  ),
);
