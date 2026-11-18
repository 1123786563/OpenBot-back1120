import { ui, useLocale } from "@/lib/i18n";
import { createFileRoute } from "@tanstack/react-router";
import { CapabilitiesSection } from "@/components/admin/controls/capabilities-section";
import { PageShell } from "@/components/layout/page-shell";

export const Route = createFileRoute("/_authed/admin/permissions")({
  component: PermissionsPage,
});

/** Admin, Permissions: what people may do with Bots, for everybody and per role or group. */
export function PermissionsPage() {
  useLocale();
  return (
    <PageShell
      description={ui(
        "Each switch applies to everybody. A role can override it, and a directory group can get a permission the organization has off. All changes appear in Audit.",
      )}
      title={ui("Permissions")}
    >
      <CapabilitiesSection />
    </PageShell>
  );
}
