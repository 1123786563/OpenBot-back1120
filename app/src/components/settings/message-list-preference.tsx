import { ErrorDetails } from "@/lib/i18n/errors";
import { ui, useLocale } from "@/lib/i18n";
import { IconLayoutSidebar } from "@tabler/icons-react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { ChannelItemContent } from "@/components/app-sidebar/channel-item-content";
import { PageRows } from "@/components/layout/page-shell";
import { Button } from "@/components/ui/button";
import {
  Item,
  ItemActions,
  ItemContent,
  ItemDescription,
  ItemMedia,
  ItemTitle,
} from "@/components/ui/item";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  saveUserPreferencesMutationOptions,
  useUserPreferences,
} from "@/lib/settings/message-list";

export function MessageListPreference() {
  useLocale();
  const preferences = useUserPreferences();
  const queryClient = useQueryClient();
  const save = useMutation(
    saveUserPreferencesMutationOptions(queryClient, preferences.userId),
  );
  const emphasis =
    (save.isPending ? save.variables?.messageListEmphasis : undefined) ??
    preferences.data?.messageListEmphasis;

  return (
    <PageRows>
      <Item size="sm">
        <ItemMedia variant="icon">
          <IconLayoutSidebar />
        </ItemMedia>
        <ItemContent>
          <ItemTitle>{ui("Message list emphasis")}</ItemTitle>
          <ItemDescription>
            {ui("Choose which line stands out in the sidebar.")}
          </ItemDescription>
        </ItemContent>
        <ItemActions>
          <Select
            value={emphasis ?? null}
            disabled={!preferences.data || save.isPending}
            onValueChange={(value) => {
              if (value === "agent" || value === "thread") {
                save.mutate({ messageListEmphasis: value });
              }
            }}
          >
            <SelectTrigger aria-label={ui("Message list emphasis")}>
              <SelectValue>
                {emphasis
                  ? emphasis === "agent"
                    ? ui("Bot name")
                    : ui("Conversation title")
                  : ui("Loading…")}
              </SelectValue>
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="thread">{ui("Conversation title")}</SelectItem>
              <SelectItem value="agent">{ui("Bot name")}</SelectItem>
            </SelectContent>
          </Select>
        </ItemActions>
      </Item>
      {preferences.isError ? (
        <div className="px-3 pb-3">
          <p role="alert" className="text-sm text-destructive">
            {<ErrorDetails error={preferences.error} />}
          </p>
          <Button
            variant="ghost"
            size="sm"
            onClick={() => void preferences.refetch()}
          >
            {ui("Try again")}
          </Button>
        </div>
      ) : null}
      {save.isError ? (
        <p role="alert" className="px-3 pb-3 text-sm text-destructive">
          {<ErrorDetails error={save.error} />}
        </p>
      ) : null}
      {save.isPending ? (
        <p role="status" className="px-3 text-sm text-muted-foreground">
          {ui("Saving…")}
        </p>
      ) : null}
      {emphasis ? (
        <div className="flex justify-center px-6 pt-3 pb-6">
          <figure
            aria-label={ui("Message list preview")}
            className="flex h-16 w-full max-w-xs items-center rounded-lg border border-border bg-sidebar px-3"
          >
            <ChannelItemContent
              participantIds={["message-list-preview"]}
              name="General Assistant"
              title={ui("Plan next week")}
              lastMessageAt={ui("2h")}
              emphasis={emphasis}
            />
          </figure>
        </div>
      ) : null}
    </PageRows>
  );
}
