import { afterAll, afterEach, beforeAll, expect, test } from "bun:test";
import { CopilotKitProvider, useCopilotKit } from "@copilotkit/react-core/v2";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { QueryClientProvider } from "@tanstack/react-query";
import { cleanup, render, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { ActiveBotProvider, useActiveBot } from "@/lib/copilot/active-bot";
import { SkillTools } from "@/lib/copilot/skill-tools";
import { SKILL_CREATOR_SLUG } from "@/lib/skills/proposal";
import { queryClient } from "@/query-client";
import { settleReactWork } from "./settle-react-work";

// Exercise the handler retained by CopilotKit before the skill catalogue arrives.
beforeAll(() => GlobalRegistrator.register());
afterEach(cleanup);
afterAll(async () => {
  await settleReactWork();
  GlobalRegistrator.unregister();
});

const originalFetch = global.fetch;
afterEach(() => {
  global.fetch = originalFetch;
  queryClient.clear();
});

const BOT = "bot-a";
const ME = "user-1";

const existingSkill = {
  id: "skill-1",
  slug: "weekly-summary",
  ownerUserId: ME,
  title: "Weekly summary",
  summary: "Say what moved this week.",
  instructions: "List what moved this week.",
  origin: "user",
  installedBy: ME,
  grantedTo: [],
  tools: [],
};

/**
 * The server, with the roster and the skills held back until `release` is called, so they arrive
 * after the grant has turned the tools on: the order a first visit sees.
 */
function serving(grant: string) {
  let release = () => {};
  const released = new Promise<void>((resolve) => {
    release = resolve;
  });
  global.fetch = Object.assign(
    async (input: RequestInfo | URL) => {
      const path = new URL(String(input), "http://127.0.0.1").pathname;
      if (path === `/api/plugins/for/${BOT}`)
        return Response.json({
          tools: [],
          skills: [
            { slug: grant, title: grant, summary: "", instructions: "" },
          ],
        });
      if (path === "/api/me")
        return Response.json({
          user: { id: ME, email: "me@example.com", role: "user" },
        });
      if (path === "/api/plugins") {
        await released;
        return Response.json({
          catalogue: [],
          servers: [],
          skills: [existingSkill],
          botsMayCallBack: false,
        });
      }
      return Response.json({ error: "Not found" }, { status: 404 });
    },
    { preconnect: originalFetch.preconnect },
  );
  return () => release();
}

type Handler = (args: unknown, context: unknown) => Promise<unknown>;
/**
 * Read from the SDK when asked, not when Capture renders: the provider does not re-render its
 * consumers when a tool is added, so a read at render time sees the registry before the tool did.
 */
class Registry {
  copilotkit?: ReturnType<typeof useCopilotKit>["copilotkit"];
  handler(name: string) {
    return this.copilotkit?.getTool({ toolName: name })?.handler as
      | Handler
      | undefined;
  }
}

function Capture({ kept }: { kept: Registry }) {
  kept.copilotkit = useCopilotKit().copilotkit;
  return null;
}

function Declare() {
  useActiveBot(BOT);
  return null;
}

function Providers({ children }: { children: ReactNode }) {
  return (
    <QueryClientProvider client={queryClient}>
      <CopilotKitProvider>
        <ActiveBotProvider>
          <Declare />
          {children}
        </ActiveBotProvider>
      </CopilotKitProvider>
    </QueryClientProvider>
  );
}

async function skillToolsLoaded() {
  const release = serving(SKILL_CREATOR_SLUG);
  const kept = new Registry();
  render(
    <Providers>
      <SkillTools />
      <Capture kept={kept} />
    </Providers>,
  );
  await waitFor(() => {
    expect(kept.handler("list_skills")).toBeDefined();
  });

  // The skills arrive after the grant turned the tools on.
  release();
  return kept;
}

test("the skill reads tell the Bot about skills that loaded after the tools turned on", async () => {
  const kept = await skillToolsLoaded();
  // What the model is told, from the handlers the SDK kept.
  const listed = await kept.handler("list_skills")?.({}, {});
  expect(String(listed)).toContain("/weekly-summary — Weekly summary (yours)");
  const read = await kept.handler("read_skill")?.(
    { slug: "weekly-summary" },
    {},
  );
  expect(String(read)).toContain("List what moved this week.");
});
