import { ui, useLocale } from "@/lib/i18n";
import { IconBulb } from "@tabler/icons-react";
import { useQuery } from "@tanstack/react-query";
import {
  ProactiveResearchSettings,
  SuggestionsInbox,
} from "@/components/suggestions/proactive-panel";
import { proactiveSuggestionsQueryOptions } from "@/lib/proactive";
import { useMuse } from "../context";
import { MuseEmpty, MuseScreen } from "../ui";
import { NoBot } from "./activity";

/**
 * Ideas: what the centre Bot's check-ins found, and its check-ins themselves. Both are OpenBot's own
 * sections, so starting, hiding and running a check-in behave as on the Bot's page.
 */
export function IdeasScreen() {
  useLocale();
  const { bot } = useMuse();
  const suggestions = useQuery(proactiveSuggestionsQueryOptions());
  if (!bot) {
    return (
      <MuseScreen title={ui("Ideas")}>
        <NoBot />
      </MuseScreen>
    );
  }
  const none =
    suggestions.data !== undefined &&
    !suggestions.data.some((suggestion) => suggestion.agentId === bot.id);
  return (
    <MuseScreen title={ui("Ideas")}>
      <div className="[&>section:first-child]:mt-0">
        {none ? (
          <MuseEmpty
            detail={ui(
              "When {{value0}}'s check-ins find something that needs you, it shows up here.",
              { value0: String(bot.name) },
            )}
            icon={IconBulb}
            title={ui("Nothing needs you right now")}
          />
        ) : (
          <SuggestionsInbox agentId={bot.id} />
        )}
        <ProactiveResearchSettings agentId={bot.id} />
      </div>
    </MuseScreen>
  );
}
