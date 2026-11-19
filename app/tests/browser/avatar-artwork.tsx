import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { useState } from "react";
import { createRoot } from "react-dom/client";
import { AbstractAvatar } from "@/components/agents/abstract-avatar";
import { BotLookProvider } from "@/components/agents/bot-look";
import { BotOrb } from "@/components/agents/bot-orb";
import { HarnessMark } from "@/components/agents/harness-mark";
import { ChannelAvatar } from "@/components/channels/avatar";
import { PluginLogo } from "@/components/plugins/plugin-logo";
import { agentListQueryOptions } from "@/lib/agents/queries";
import { SKINS } from "@/skins/registry";
import "@/styles.css";

const client = new QueryClient({
  defaultOptions: { queries: { staleTime: Infinity } },
});
client.setQueryData(agentListQueryOptions().queryKey, [
  {
    id: "knowledge-copy",
    name: "Knowledge copy",
    avatarSeed: "knowledge",
    title: "Knowledge",
    roleDescription: "Answers questions about the workspace.",
    visibility: "private",
    endpoint: null,
    builtIn: false,
    canManage: true,
    hasAuth: false,
    hasCallbackToken: false,
    isolated: false,
    isolationActive: false,
    isolationOffReason: null,
    hidden: false,
    pinned: false,
    mine: true,
    systemOwned: false,
    runsOnOpenBotModel: true,
  },
]);

function Artwork() {
  const [logo, setLogo] = useState<string>();
  return (
    <main>
      <section aria-label="Bot orbs">
        <BotOrb name="Expense Review" seed="expense-review" />
        <BotOrb name="Idle Knowledge" seed="knowledge" size={24} />
        <BotOrb name="Large Knowledge" seed="knowledge" size={96} />
        <BotOrb
          name="Working Knowledge"
          seed="knowledge"
          size={24}
          state="working"
        />
        <BotOrb name="Idle Risk Analyst" seed="risk-analyst" size={24} />
      </section>
      {Object.entries(SKINS).map(([skin, settings]) => (
        <BotLookProvider key={skin} value={settings.botLook ?? "face"}>
          <section aria-label={skin}>
            <div data-avatar="bot">
              <AbstractAvatar name="Knowledge" seed="knowledge" size={32} />
            </div>
            <div data-avatar="conversation">
              <ChannelAvatar
                participantIds={["knowledge-copy"]}
                size={32}
                typing
              />
            </div>
            <div data-avatar="group">
              <ChannelAvatar
                participantIds={["knowledge", "risk-analyst", "release-notes"]}
                size={32}
              />
            </div>
          </section>
        </BotLookProvider>
      ))}
      <section aria-label="Harness marks">
        <div className="flex items-center gap-2" data-harness="marked">
          <HarnessMark id="langgraph" name="LangGraph" />
          <span>LangGraph</span>
        </div>
        <div className="flex items-center gap-2" data-harness="unmarked">
          <HarnessMark id={null} name="Unmarked" />
          <span>Unmarked</span>
        </div>
      </section>
      <section aria-label="App logo">
        <div data-logo>
          <PluginLogo logo={logo} />
        </div>
        <button
          type="button"
          onClick={() => setLogo("/fixture-broken-logo.svg")}
        >
          Load broken logo
        </button>
        <button type="button" onClick={() => setLogo("/fixture-new-logo.svg")}>
          Load replacement logo
        </button>
      </section>
    </main>
  );
}

const root = document.getElementById("root");
if (!root) throw new Error("Missing browser test root");
createRoot(root).render(
  <QueryClientProvider client={client}>
    <Artwork />
  </QueryClientProvider>,
);
