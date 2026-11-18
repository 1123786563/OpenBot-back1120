import { ui, useLocale } from "@/lib/i18n";
import { createFileRoute } from "@tanstack/react-router";
import { BotSubpage } from "@/components/bot-profile/bot-subpage";
import { SharingSections } from "@/components/bot-profile/sharing";

export const Route = createFileRoute("/_authed/_app/bots/$agentId/sharing")({
  component: SharingPage,
});

function SharingPage() {
  useLocale();
  const { agentId } = Route.useParams();
  return (
    <BotSubpage
      agentId={agentId}
      description={ui(
        "Choose who can use this Bot. Each person’s conversations with it are private.",
      )}
      title={ui("Sharing")}
    >
      {(agent) => <SharingSections agent={agent} />}
    </BotSubpage>
  );
}
