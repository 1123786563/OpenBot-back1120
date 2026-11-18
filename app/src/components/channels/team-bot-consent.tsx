import { ErrorDetails } from "@/lib/i18n/errors";
import { ui, useLocale } from "@/lib/i18n";
import { useMutation } from "@tanstack/react-query";
import { useState } from "react";
import { Button } from "@/components/ui/button";
import {
  type TeamBotConsentDecision,
  teamBotConsentMutationOptions,
} from "@/lib/team-bots";

/**
 * A Team Bot asking to use this person's own account on one server, where its owner has not
 * connected one. Allow once covers the next call, Always allow covers this Bot (or every Team Bot)
 * until cleared in Team Bots, Skip leaves it using nothing of theirs. The Bot is then asked again by the person.
 */
export function TeamBotConsentCard({
  botId,
  serverId,
  message,
}: {
  botId: string;
  serverId: string;
  message: string;
}) {
  useLocale();
  const answer = useMutation(teamBotConsentMutationOptions());
  const [chosen, setChosen] = useState<TeamBotConsentDecision | null>(null);
  const choose = (decision: TeamBotConsentDecision) =>
    answer.mutate(
      { botId, serverId, decision },
      { onSuccess: () => setChosen(decision) },
    );
  return (
    <div
      className="flex flex-col gap-2 rounded-lg border border-border p-3 text-sm"
      data-team-bot-consent={serverId}
    >
      <p>{message}</p>
      {chosen ? (
        <p className="text-muted-foreground" role="status">
          {chosen === "skip"
            ? ui("Skipped. Nothing of yours was used.")
            : chosen === "allow_once"
              ? ui("Allowed once. Ask the Bot to try again.")
              : chosen === "allow_all_team_bots"
                ? ui("Always allowed for every Team Bot. Ask it to try again.")
                : ui("Always allowed for this Bot. Ask it to try again.")}
        </p>
      ) : (
        <div className="flex flex-wrap gap-2">
          <Button
            disabled={answer.isPending}
            onClick={() => choose("allow_once")}
            size="sm"
          >
            {ui("Allow once")}
          </Button>
          <Button
            disabled={answer.isPending}
            onClick={() => choose("allow_always")}
            size="sm"
            variant="outline"
          >
            {ui("Always allow for this Bot")}
          </Button>
          <Button
            disabled={answer.isPending}
            onClick={() => choose("allow_all_team_bots")}
            size="sm"
            variant="outline"
          >
            {ui("Always allow for all Team Bots")}
          </Button>
          <Button
            disabled={answer.isPending}
            onClick={() => choose("skip")}
            size="sm"
            variant="ghost"
          >
            {ui("Skip")}
          </Button>
        </div>
      )}
      {answer.error ? (
        <p className="text-destructive" role="alert">
          {<ErrorDetails error={answer.error} />}
        </p>
      ) : null}
    </div>
  );
}
