import { ui, useLocale } from "@/lib/i18n";
import { createFileRoute } from "@tanstack/react-router";
import { BotApprovalRules } from "@/components/approvals/bot-rules";
import { BotSubpage } from "@/components/bot-profile/bot-subpage";

export const Route = createFileRoute("/_authed/_app/bots/$agentId/approvals")({
  component: ApprovalRulesPage,
});

function ApprovalRulesPage() {
  useLocale();
  const { agentId } = Route.useParams();
  return (
    <BotSubpage
      agentId={agentId}
      description={ui(
        "Choose which actions this Bot can take without your approval.",
      )}
      title={ui("Approval rules")}
    >
      {(agent) => <BotApprovalRules agentId={agent.id} />}
    </BotSubpage>
  );
}
