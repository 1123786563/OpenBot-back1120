import { ui, useLocale } from "@/lib/i18n";
import { IconChevronRight, IconClock } from "@tabler/icons-react";
import { useQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import {
  PageRows,
  PageSection,
  PageShell,
} from "@/components/layout/page-shell";
import {
  Item,
  ItemActions,
  ItemContent,
  ItemDescription,
  ItemMedia,
  ItemTitle,
} from "@/components/ui/item";
import { routinesQueryOptions } from "@/lib/routines/queries";
import { NewRoutineButton } from "./new-routine-button";

/** "No routines yet", "1 routine, on", "3 routines, 2 on". */
function routinesSummary(
  routines: { enabled: boolean }[] | undefined,
): string | null {
  if (!routines) return null;
  if (routines.length === 0) return ui("No routines yet.");
  const on = routines.filter((routine) => routine.enabled).length;
  const count = `${routines.length} routine${routines.length === 1 ? "" : "s"}`;
  if (routines.length === 1) return `${count}, ${on === 1 ? "on" : "off"}.`;
  return ui("{{value0}}, {{value1}} on.", {
    value0: String(count),
    value1: String(on),
  });
}

/**
 * Connections > Routines: what Routines is, and the way to the Routines page.
 *
 * Routines is listed among the apps because it is one to a Bot: the tools a Bot calls to set up,
 * change and stop a routine. There is nothing to connect or switch, since every Bot has it in every
 * edition, so a person who opens it wants their routines, and this page sends them there.
 */
export function RoutinesConnectionPage() {
  useLocale();
  const routines = useQuery(routinesQueryOptions());
  const summary = routinesSummary(routines.data?.routines);
  return (
    <PageShell
      action={<NewRoutineButton />}
      backButton={{
        label: ui("Connections"),
        linkProps: { to: "/connections" },
      }}
      description={ui(
        "Routines are work your Bots do on a schedule. Every Bot can set one up for you.",
      )}
      title={ui("Routines")}
    >
      {/* One destination, so no heading: it would only repeat the row's own title. */}
      <PageSection>
        <PageRows className="mt-0">
          <Item render={<Link to="/routines" />} size="sm">
            <ItemMedia variant="icon">
              <IconClock />
            </ItemMedia>
            <ItemContent>
              <ItemTitle>{ui("Your routines")}</ItemTitle>
              <ItemDescription>
                {routines.error
                  ? ui("Open Routines to see them.")
                  : (summary ?? ui("Open Routines to see them."))}
              </ItemDescription>
            </ItemContent>
            <ItemActions>
              <IconChevronRight className="size-4 text-muted-foreground" />
            </ItemActions>
          </Item>
        </PageRows>
      </PageSection>
    </PageShell>
  );
}
