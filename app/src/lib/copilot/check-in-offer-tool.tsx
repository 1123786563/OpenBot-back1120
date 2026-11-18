import { ErrorDetails } from "@/lib/i18n/errors";
import { ui, useLocale, uiNodes } from "@/lib/i18n";
import { useRenderTool } from "@copilotkit/react-core/v2";
import { OFFER_CHECK_IN_TOOL } from "@openbot/shared/check-in-offer";
import { IconRadar } from "@tabler/icons-react";
import { useMutation, useQuery } from "@tanstack/react-query";
import { useParams } from "@tanstack/react-router";
import { useState } from "react";
import { z } from "zod";
import { Button } from "@/components/ui/button";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { agentQueryOptions } from "@/lib/agents/queries";
import { useDeclaredBotId } from "@/lib/copilot/active-bot";
import {
  createProactiveSettingMutationOptions,
  proactiveAllowedQueryOptions,
  proactiveSettingsQueryOptions,
} from "@/lib/proactive";
import { queryClient } from "@/query-client";

/**
 * A Bot offering to keep an eye on one thing for the person: the card `offer_check_in` draws.
 *
 * RENDER ONLY. The tool runs on the server and writes nothing (server/src/proactive/offer-tool.ts);
 * Turn on here creates the check-in as the person, through the route the Bot's check-ins page uses.
 * Daily unless they pick more often, since once a day is what keeping an eye on something means to
 * most people. Not now is remembered for this card, in this browser, so a reload doesn't ask again.
 */
const parameters = z.object({
  subject: z.string().optional(),
  focus: z.string().optional(),
  link: z.string().optional(),
});

const INTERVALS = [
  {
    minutes: 1440,
    get label() {
      return ui("Once a day");
    },
  },
  {
    minutes: 720,
    get label() {
      return ui("Twice a day");
    },
  },
  {
    minutes: 240,
    get label() {
      return ui("Every 4 hours");
    },
  },
  {
    minutes: 60,
    get label() {
      return ui("Every hour");
    },
  },
];
const INTERVAL_ITEMS = INTERVALS.map((interval) => ({
  value: interval.minutes,
  label: interval.label,
}));

const DECLINED = "openbot:check-in-declined:";

function declinedBefore(toolCallId: string): boolean {
  try {
    return window.localStorage.getItem(DECLINED + toolCallId) !== null;
  } catch {
    return false;
  }
}

function rememberDeclined(toolCallId: string) {
  try {
    window.localStorage.setItem(DECLINED + toolCallId, "1");
  } catch {
    // A browser that refuses storage asks again after a reload, which is all it costs.
  }
}

export function CheckInOfferTool() {
  useLocale();
  useRenderTool({
    name: OFFER_CHECK_IN_TOOL,
    parameters,
    render: ({ parameters: given, status, toolCallId }) =>
      status === "complete" && given?.subject ? (
        <CheckInOfferCard
          focus={given.focus}
          link={given.link}
          subject={given.subject}
          toolCallId={toolCallId}
        />
      ) : null,
  });
  return null;
}

export function CheckInOfferCard({
  subject,
  focus,
  link,
  toolCallId,
}: {
  subject: string;
  focus?: string;
  link?: string;
  toolCallId: string;
}) {
  useLocale();
  const agentId = useDeclaredBotId();
  const channelId = useParams({ strict: false }).channelId;
  const bot = useQuery({
    ...agentQueryOptions(agentId ?? ""),
    enabled: Boolean(agentId),
  }).data?.name;
  const allowed = useQuery(proactiveAllowedQueryOptions()).data;
  const settings = useQuery(proactiveSettingsQueryOptions());
  const create = useMutation(
    createProactiveSettingMutationOptions(queryClient),
  );
  const [minutes, setMinutes] = useState(1440);
  const [declined, setDeclined] = useState(() => declinedBefore(toolCallId));

  // Nothing to offer where check-ins are off for this person, or before the answer is in.
  if (allowed !== true || !agentId || !settings.data) return null;
  const watching = settings.data.find(
    (setting) =>
      setting.agentId === agentId &&
      setting.enabled &&
      (link
        ? setting.sourceLink === link
        : (setting.subject ?? "").toLowerCase() === subject.toLowerCase()),
  );
  const who = bot ?? "This Bot";

  if (watching)
    return (
      <p className="my-2 flex items-center gap-2 text-muted-foreground text-sm">
        {uiNodes(
          "{{slot0}}{{slot1}}checks {{slot2}} {{slot3}}. Change it on {{slot4}}'s check-ins.",
          [
            <IconRadar key="slot0" aria-hidden className="size-4 shrink-0" />,
            who,
            subject,
            INTERVALS.find(
              (interval) => interval.minutes === watching.intervalMinutes,
            )?.label.toLowerCase() ?? ui("regularly"),
            who,
          ],
        )}
      </p>
    );
  if (declined)
    return (
      <p className="my-2 flex items-center gap-2 text-muted-foreground text-sm">
        {uiNodes(
          "{{slot0}}No check-in on {{slot1}}. You can add one from {{slot2}}'s check-ins.",
          [
            <IconRadar key="slot0" aria-hidden className="size-4 shrink-0" />,
            subject,
            who,
          ],
        )}
      </p>
    );

  return (
    <div
      className="my-2 flex w-full max-w-2xl flex-col gap-3 rounded-xl border border-border p-4"
      data-check-in-offer={toolCallId}
    >
      <div className="flex items-start gap-3">
        <div className="flex size-8 shrink-0 items-center justify-center rounded-md border border-border">
          <IconRadar aria-hidden className="size-4" />
        </div>
        <div className="flex min-w-0 flex-1 flex-col gap-1">
          <p className="font-medium text-sm">
            {ui("Keep an eye on")} {subject}?
          </p>
          <p className="text-muted-foreground text-sm">
            {uiNodes(
              "{{slot0}}reads it and tells you when something there needs you. It only reads, and never changes anything.",
              [who],
            )}
          </p>
        </div>
      </div>
      {create.error ? (
        <p className="text-destructive text-sm" role="alert">
          {<ErrorDetails error={create.error} />}
        </p>
      ) : null}
      {channelId ? null : (
        <p className="text-muted-foreground text-sm">
          {uiNodes("Open this in a conversation with {{slot0}}to turn it on.", [
            who,
          ])}
        </p>
      )}
      <div className="flex flex-wrap items-center justify-end gap-2">
        <Select
          disabled={create.isPending}
          items={INTERVAL_ITEMS}
          onValueChange={(value) => {
            if (value !== null) setMinutes(value);
          }}
          value={minutes}
        >
          <SelectTrigger
            aria-label={ui("How often")}
            className="w-36"
            size="sm"
          >
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {INTERVALS.map((interval) => (
              <SelectItem key={interval.minutes} value={interval.minutes}>
                {interval.label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <Button
          disabled={create.isPending}
          onClick={() => {
            rememberDeclined(toolCallId);
            setDeclined(true);
          }}
          size="sm"
          variant="ghost"
        >
          {ui("Not now")}
        </Button>
        <Button
          disabled={create.isPending || !channelId}
          onClick={() =>
            channelId &&
            create.mutate({
              agentId,
              channelId,
              subject,
              focus: focus ?? "",
              ...(link && /^https?:\/\//.test(link)
                ? { sourceLink: link }
                : {}),
              intervalMinutes: minutes,
            })
          }
          size="sm"
        >
          {create.isPending ? ui("Turning on…") : ui("Turn on")}
        </Button>
      </div>
    </div>
  );
}
