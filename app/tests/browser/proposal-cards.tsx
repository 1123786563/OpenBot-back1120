import { ProposedBotCard } from "@/components/agents/proposed-bot";
import { ProposedSkillCard } from "@/components/skills/proposed-skill";
import "@/styles.css";
import {
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
  Outlet,
  RouterProvider,
} from "@tanstack/react-router";
import { useState, type ComponentProps } from "react";
import { createRoot } from "react-dom/client";

const params = new URLSearchParams(location.search);
const kind = params.get("kind");
const scenario = params.get("scenario");
const bot = {
  name: "Renewal Desk",
  title: "Accounts Receivable",
  roleDescription: [
    "Chase overdue invoices and draft the follow-up a person sends.",
    ...Array.from(
      { length: 12 },
      (_, index) =>
        `Check the ledger for account ${index + 1} and cite the original record.`,
    ),
    "Where an invoice is disputed rather than late, say so and stop.",
  ].join("\n"),
  skills: ["find-a-document", "check-a-claim"],
};
const skill = {
  slug: "weekly-summary",
  title: "Weekly summary",
  summary: "Say what moved this week.",
  instructions: "List what moved this week, newest first. Name each source.",
  tools: ["google-drive/search_files"],
};
const historicalAnswer =
  "Created. Renewal Desk now exists and is private. Its profile is at /bots/agent_1.";

function Proposal() {
  const [events, setEvents] = useState<unknown[]>([]);
  const [revision, setRevision] = useState(0);
  const [attempts, setAttempts] = useState(0);
  const record = (entry: unknown) =>
    setEvents((previous) => [...previous, entry]);
  const respond = async (answer: unknown) => record({ type: "answer", answer });
  const controls = scenario === "streaming" ? undefined : respond;
  const create: ComponentProps<typeof ProposedBotCard>["create"] = async (
    values,
    skills,
  ) => {
    setAttempts(attempts + 1);
    if (scenario === "retry" && attempts === 0) {
      throw new Error("A coworker called Renewal Desk already exists.");
    }
    const partial = scenario === "partial";
    record({ type: "create", values, skills });
    return {
      name: bot.name,
      agentId: "agent_1",
      granted: partial ? ["find-a-document"] : skills,
      failed: partial ? ["check-a-claim"] : [],
    };
  };
  const save: ComponentProps<typeof ProposedSkillCard>["save"] = async (
    values,
  ) => {
    setAttempts(attempts + 1);
    if (scenario === "retry" && attempts === 0) {
      throw new Error("weekly-summary is somebody else's skill.");
    }
    record({ type: "save", values });
  };
  return (
    <main className="mx-auto max-w-lg p-4">
      <section aria-label="Proposal">
        {kind === "bot" ? (
          <ProposedBotCard
            args={
              scenario === "invalid"
                ? { name: "" }
                : scenario === "streaming"
                  ? { name: bot.name }
                  : bot
            }
            create={create}
            respond={controls}
            result={scenario === "history" ? historicalAnswer : undefined}
          />
        ) : (
          <ProposedSkillCard
            args={
              scenario === "invalid"
                ? { slug: "Weekly Summary" }
                : scenario === "streaming"
                  ? { slug: "weekly" }
                  : skill
            }
            replaces={
              scenario === "replace"
                ? { ownership: "yours", title: skill.title }
                : undefined
            }
            respond={controls}
            save={save}
          />
        )}
      </section>
      {scenario === "invalid" && (
        <button type="button" onClick={() => setRevision(revision + 1)}>
          Refresh proposal
        </button>
      )}
      <output aria-label="Fixture revision">{revision}</output>
      <output aria-label="Write attempts">{attempts}</output>
      <output aria-label="Tool events">{JSON.stringify(events)}</output>
    </main>
  );
}

const root = createRootRoute({ component: Outlet });
const proposal = createRoute({
  getParentRoute: () => root,
  path: "/",
  component: Proposal,
});
const profile = createRoute({
  getParentRoute: () => root,
  path: "/bots/$agentId",
  component: () => <h1>Renewal Desk profile</h1>,
});
const router = createRouter({
  routeTree: root.addChildren([proposal, profile]),
  history: createMemoryHistory(),
});
const container = document.getElementById("root");
if (!container) throw new Error("Missing proposal fixture root");
createRoot(container).render(<RouterProvider router={router} />);
