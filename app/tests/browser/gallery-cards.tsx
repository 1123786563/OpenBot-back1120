import { useState } from "react";
import { createRoot } from "react-dom/client";
import {
  type DecisionAnswer,
  DecisionCard,
} from "@/components/decisions/decision-card";
import {
  ChecklistCard,
  NoticeCard,
  RecordCard,
} from "@/components/gallery/cards";
import { ApprovalCard, ChoiceCard } from "@/components/gallery/decisions";
import { FormCard } from "@/components/gallery/form";
import { QuoteCard } from "@/components/gallery/quote";
import { DataTable } from "@/components/gallery/table";
import "@/styles.css";

const params = new URLSearchParams(location.search);
const example = params.get("example");
const state = params.get("state");
const emails = [
  [
    "Northwind Traders",
    "1a1b9a5fcb357c40",
    "5:00–5:25 pm. Discuss its proposed open-source proof of concept, architecture fit, capabilities and human handoff.",
  ],
  ["Contoso", "1a1b9a5ac4f756e7", "4:00–5:00 pm. Proof-of-concept discussion."],
  ["Fabrikam", "1a1b9a594ffa763a", "2:00–3:00 pm. Weekly engineering sync."],
  [
    "Tailspin Toys",
    "1a1b9a121f53fe9c",
    "7:30–7:55 am. Stand-up to develop a plan and establish next steps; the invitation links to a mutual action plan.",
  ],
  [
    "Litware",
    "1a1b99f29f125e40",
    "7:00–7:25 am. Demo covering on-premise agents and workflows, managed infrastructure, authentication and security.",
  ],
];
const points = emails.map(
  ([name, id, rest]) =>
    `[${name}](https://mail.google.com/mail/u/0/#inbox/${id}) — ${rest}`,
);
const line = points[0];
const longUrl =
  "https://mail.google.com/mail/u/0/#inbox/1a1b9a5fcb357c40a1b9a5fcb357c40a1b9a5fcb357c40a1b9a5fcb357c40";
const quote = "A Kubernetes operator is a custom controller.";
const form = {
  title: "Project brief",
  fields: [
    { id: "team", label: "Team", type: "text", required: true },
    { id: "email", label: "Work email", type: "email", required: true },
    {
      id: "seats",
      label: "Seats",
      type: "number",
      min: 1,
      max: 20,
      required: true,
    },
    {
      id: "priority",
      label: "Priority",
      type: "select",
      options: ["This week", "This month"],
      required: true,
    },
    { id: "notes", label: "Notes", type: "textarea" },
  ],
};

async function answer(value: unknown) {
  const response = await fetch("/tests/gallery-answer", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(value),
  });
  if (!response.ok) throw new Error("The answer could not be sent");
}

function FormExample() {
  const [, redraw] = useState(0);
  const complete = state === "saved" || state === "unreadable";
  return (
    <>
      <FormCard
        args={state === "invalid" ? { title: "Bad form", fields: [] } : form}
        status={
          state === "streaming"
            ? "inProgress"
            : complete
              ? "complete"
              : "executing"
        }
        respond={
          state === "disabled" ? undefined : (value: unknown) => answer(value)
        }
        result={
          state === "unreadable"
            ? "unreadable result"
            : complete
              ? JSON.stringify({
                  status: "submitted",
                  values: {
                    team: "Saved team",
                    email: "saved@example.test",
                    seats: 7,
                    priority: "This week",
                    notes: "First line\nSecond line",
                  },
                })
              : undefined
        }
      />
      <button type="button" onClick={() => redraw((n) => n + 1)}>
        Rerender
      </button>
    </>
  );
}

const options = [
  { value: "staging", label: "Staging", description: "Safe, and reversible" },
  { value: "production", label: "Production", description: "Live customers" },
];

function Question({ title }: { title: string }) {
  const [saved, setSaved] = useState<DecisionAnswer | undefined>(
    state === "answered"
      ? { label: "Answered", choice: "Production", tone: "positive" }
      : undefined,
  );
  return (
    <DecisionCard
      title={title}
      options={options}
      other={
        state === "other"
          ? { placeholder: "Answer something else…" }
          : undefined
      }
      answer={saved}
      onSubmit={async (value, text) => {
        await answer({ title, value, text });
        setSaved({
          label: "Answered",
          choice:
            text || options.find((option) => option.value === value)?.label,
          tone: "positive",
        });
      }}
    />
  );
}

function DecisionExample() {
  return (
    <>
      <textarea aria-label="Message" />
      {state === "multiple" ? (
        <>
          <Question title="First" />
          <Question title="Second" />
        </>
      ) : (
        <Question title="Which environment?" />
      )}
    </>
  );
}

function Cards() {
  return (
    <>
      <section aria-label="Email notice">
        <NoticeCard
          title="Five most recent unread emails"
          body="All five are updated calendar invitations from Alex Rivera for Monday, November 9. Times are Pacific; your attendance is marked optional."
          points={points}
        />
      </section>
      <section aria-label="Rich notice">
        <NoticeCard
          title="Replies"
          body={
            "**Two** need a reply before `Friday`:\n\n- Contoso\n- Fabrikam"
          }
        />
      </section>
      <section aria-label="Unsafe notice">
        <NoticeCard
          title="Unsafe"
          body={
            '<img src="x" onerror="window.__galleryUnsafe = true"> [here](javascript:window.__galleryUnsafe=true)'
          }
        />
      </section>
      <section aria-label="Record markdown">
        <RecordCard
          title="Email"
          fields={[{ label: "Message", value: line }]}
        />
      </section>
      <section aria-label="Checklist markdown">
        <ChecklistCard
          title="Replies"
          items={[{ text: line, done: false, note: "Waiting on **Contoso**" }]}
        />
      </section>
      <section aria-label="Quote markdown">
        <QuoteCard attribution="Inbox" quote={line} />
      </section>
      <section aria-label="Approval markdown">
        <ApprovalCard
          args={{
            title: "Archive this email",
            summary: line,
            details: [{ label: "From", value: "**Contoso**" }],
          }}
          status="executing"
          respond={async () => {}}
          result={undefined}
        />
      </section>
      <section aria-label="Choice markdown">
        <ChoiceCard
          args={{
            title: "Which one should I archive?",
            summary: line,
            options: [{ id: "contoso", label: "Contoso" }],
          }}
          status="executing"
          respond={async () => {}}
          result={undefined}
        />
      </section>
      <section aria-label="Table markdown">
        <DataTable
          title="Unread"
          columns={["Email", "Minutes"]}
          rows={[{ cells: [line, 25] }]}
        />
      </section>
      <section aria-label="Nested list notice">
        <NoticeCard
          title="Replies"
          points={["- Contoso\n- Fabrikam", "One plain point"]}
        />
      </section>
      <section aria-label="Long notice">
        <NoticeCard title="Link" body={longUrl} points={[longUrl]} />
      </section>
      <section aria-label="Long checklist">
        <ChecklistCard title="Link" items={[{ text: longUrl, done: false }]} />
      </section>
      <section aria-label="Long quote">
        <QuoteCard attribution="Inbox" quote={longUrl} />
      </section>
      <section aria-label="Long choice">
        <ChoiceCard
          args={{
            title: "Which one?",
            options: [{ id: "a", label: "Contoso", description: longUrl }],
          }}
          status="executing"
          respond={async () => {}}
          result={undefined}
        />
      </section>
      <section aria-label="Checklist status">
        <ChecklistCard
          title="Three fixes"
          items={[
            { text: "Raise the connection pool to 20", done: true },
            { text: "Cache the pricing lookup", done: true },
            { text: "Retry the webhook with backoff", done: false },
          ]}
        />
      </section>
      <section aria-label="Attributed quote">
        <QuoteCard attribution="Knowledge Bot" quote={quote} />
      </section>
      <section aria-label="Anonymous quote">
        <QuoteCard quote={quote} />
      </section>
      {(["positive", "caution", "negative", "neutral", "posi"] as const).map(
        (tone) => (
          <section key={tone} aria-label={`Notice tone ${tone}`}>
            <NoticeCard
              title="Standing check created"
              body="It runs every morning."
              tone={tone as "positive"}
            />
          </section>
        ),
      )}
    </>
  );
}

const root = document.getElementById("root");
if (!root) throw new Error("Missing browser test root");
createRoot(root).render(
  <main style={{ maxWidth: 672, margin: "auto", padding: 16 }}>
    {example === "form" ? (
      <FormExample />
    ) : example === "decision" ? (
      <DecisionExample />
    ) : example === "table" ? (
      <DataTable
        title="Team capacity"
        columns={["Team", "Hours"]}
        rows={
          state === "empty"
            ? []
            : state === "invalid"
              ? [{ cells: ["Only one"] }]
              : [
                  { cells: ["Design", 18] },
                  { cells: ["Product", 4] },
                  { cells: ["Engineering", 72] },
                ]
        }
      />
    ) : (
      <Cards />
    )}
  </main>,
);
