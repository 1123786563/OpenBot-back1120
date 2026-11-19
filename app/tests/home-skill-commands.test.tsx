import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { renderHook } from "@testing-library/react";
import type { ReactNode } from "react";
import { pluginKeys } from "@/lib/plugins/queries";
import { useAnyBotSkillCommands } from "@/lib/plugins/skill-commands";

beforeAll(() => GlobalRegistrator.register());
afterAll(() => GlobalRegistrator.unregister());

const standup = {
  slug: "standup",
  title: "Standup notes",
  summary: "Turns yesterday's work into a standup update",
  instructions: "Summarise yesterday.",
};

function wrapper(skills: Record<string, (typeof standup)[]>) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false, staleTime: Infinity } },
  });
  for (const [agentId, list] of Object.entries(skills))
    client.setQueryData(pluginKeys.forAgent(agentId), {
      tools: [],
      skills: list,
    });
  return ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={client}>{children}</QueryClientProvider>
  );
}

describe("useAnyBotSkillCommands", () => {
  test("returns the Bots that offer a Skill", () => {
    const { result } = renderHook(
      () => useAnyBotSkillCommands(["ada", "grace", "linus"]),
      {
        wrapper: wrapper({ ada: [standup], grace: [], linus: [standup] }),
      },
    );
    expect(result.current.botsFor("standup")).toEqual(["ada", "linus"]);
    expect(result.current.botsFor("gone")).toEqual([]);
  });
});
