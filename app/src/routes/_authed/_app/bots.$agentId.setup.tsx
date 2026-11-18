import { ui, useLocale } from "@/lib/i18n";
import { createFileRoute } from "@tanstack/react-router";
import { BotSubpage } from "@/components/bot-profile/bot-subpage";
import { SetupSections } from "@/components/bot-profile/setup";

export const Route = createFileRoute("/_authed/_app/bots/$agentId/setup")({
  component: SetupPage,
});

function SetupPage() {
  useLocale();
  const { agentId } = Route.useParams();
  return (
    <BotSubpage
      agentId={agentId}
      description={ui(
        "Edit this Bot’s profile, visibility, and runtime settings.",
      )}
      title={ui("Setup")}
    >
      {(agent) => <SetupSections agent={agent} />}
    </BotSubpage>
  );
}
