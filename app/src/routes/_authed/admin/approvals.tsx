import { ui, useLocale } from "@/lib/i18n";
import { createFileRoute } from "@tanstack/react-router";
import { TeamApprovalSettings } from "@/components/approvals/team-settings";
import { PageShell } from "@/components/layout/page-shell";

export const Route = createFileRoute("/_authed/admin/approvals")({
  component: AdminApprovalsPage,
});

function AdminApprovalsPage() {
  useLocale();
  return (
    <PageShell
      description={ui(
        "Set approval rules for members’ Bots and review requests to use shared accounts.",
      )}
      title={ui("Approvals")}
    >
      <TeamApprovalSettings />
    </PageShell>
  );
}
