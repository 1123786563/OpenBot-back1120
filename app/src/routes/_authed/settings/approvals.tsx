import { ui, useLocale } from "@/lib/i18n";
import { createFileRoute } from "@tanstack/react-router";
import { ApprovalSettings } from "@/components/approvals/settings";
import { PageShell } from "@/components/layout/page-shell";
import { TeamBotConsents } from "@/components/settings/team-bot-consents";

export const Route = createFileRoute("/_authed/settings/approvals")({
  component: ApprovalsSettingsPage,
});

function ApprovalsSettingsPage() {
  useLocale();
  return (
    <PageShell
      description={ui(
        "Choose when your Bots ask before they change things. Rules here apply to all of them.",
      )}
      title={ui("Approvals")}
    >
      <ApprovalSettings />
      <TeamBotConsents />
    </PageShell>
  );
}
