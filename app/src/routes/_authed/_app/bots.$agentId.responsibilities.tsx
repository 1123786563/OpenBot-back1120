import { ui, useLocale } from "@/lib/i18n";
import { createFileRoute } from "@tanstack/react-router";
import { BotSubpage } from "@/components/bot-profile/bot-subpage";
import { BotResponsibilities } from "@/components/responsibilities/responsibilities";

export const Route = createFileRoute(
  "/_authed/_app/bots/$agentId/responsibilities",
)({
  component: ResponsibilitiesPage,
});

function ResponsibilitiesPage() {
  useLocale();
  const { agentId } = Route.useParams();
  return (
    <BotSubpage
      agentId={agentId}
      description={ui(
        "Review this Bot’s ongoing goals, what triggered each run, and its results.",
      )}
      title={ui("Goals")}
    >
      {(agent) => <BotResponsibilities agentId={agent.id} />}
    </BotSubpage>
  );
}
