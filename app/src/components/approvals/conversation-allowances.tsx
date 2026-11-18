import { ErrorDetails } from "@/lib/i18n/errors";
import { ui, useLocale, uiNodes } from "@/lib/i18n";
import { approvalPhrase } from "@openbot/shared/tool-name";
import { IconCircleCheck } from "@tabler/icons-react";
import { useMutation, useQuery } from "@tanstack/react-query";
import { Button } from "@/components/ui/button";
import {
  type ActionKind,
  approvalInboxOptions,
  type ConversationGrant,
  revokeConversationGrantMutationOptions,
} from "@/lib/approvals";
import { queryClient } from "@/query-client";

/** A kind of action, as the start of a sentence about where it is allowed. */
const KIND_WORDS: Record<ActionKind, string> = {
  get deleting() {
    return ui("Deleting");
  },
  get sending() {
    return ui("Sending to other people");
  },
  get sharing() {
    return ui("Sharing");
  },
  get publishing() {
    return ui("Posting");
  },
  get payments() {
    return ui("Paying");
  },
  get credentials() {
    return ui("Changing sign-in details");
  },
  get security_settings() {
    return ui("Changing security settings");
  },
};

/**
 * What a conversation answer allows, as its line says it. An app's tool by its name, "Send message
 * on Slack". A step on a website covers that kind of step there, whichever button it presses, so it
 * says the kind: "Sending to other people on chat.example.com". A plain "Click on …" would read as
 * every click.
 */
function allowedWords(grant: ConversationGrant): string {
  if (grant.toolRef.startsWith("computer_") && grant.kind)
    return ui("{{value0}} on {{value1}}", {
      value0: String(KIND_WORDS[grant.kind]),
      value1: String(grant.scope),
    });
  const phrase = approvalPhrase(grant, ui);
  return phrase.charAt(0).toUpperCase() + phrase.slice(1);
}

/**
 * What the person allowed for this conversation, above its composer: one line per action, each with
 * Turn off. Read from the same inbox the approval cards are, so a card answered with "Allow for this
 * conversation" shows its line here as soon as the inbox is read again.
 *
 * Turned off, the next such action in this conversation asks again. Nothing at all when nothing is
 * allowed here.
 */
export function ConversationAllowances({ threadId }: { threadId: string }) {
  useLocale();
  const inbox = useQuery(approvalInboxOptions());
  const revoke = useMutation(
    revokeConversationGrantMutationOptions(queryClient),
  );
  const grants = (inbox.data?.conversationGrants ?? []).filter(
    (grant) => grant.threadId === threadId,
  );
  if (grants.length === 0) return null;
  return (
    <section
      aria-label={ui("Allowed in this conversation")}
      className="flex flex-col gap-1 pb-2"
    >
      {grants.map((grant) => {
        const action = allowedWords(grant);
        return (
          <div
            className="flex min-w-0 items-center gap-2 rounded-lg border bg-muted/40 py-1 pr-1 pl-2.5 text-sm"
            key={grant.id}
          >
            <IconCircleCheck
              aria-hidden
              className="size-4 shrink-0 text-muted-foreground"
            />
            <p className="min-w-0 flex-1 truncate text-muted-foreground">
              {uiNodes("{{slot0}}is allowed in this conversation.", [
                <span key="slot0" className="font-medium text-foreground">
                  {action}
                </span>,
              ])}
            </p>
            <Button
              aria-label={ui("Turn off: {{value0}}", {
                value0: String(action),
              })}
              className="shrink-0"
              disabled={revoke.isPending}
              onClick={() => revoke.mutate(grant.id)}
              size="xs"
              variant="ghost"
            >
              {ui("Turn off")}
            </Button>
          </div>
        );
      })}
      {revoke.error ? (
        <p className="text-destructive text-sm" role="alert">
          {<ErrorDetails error={revoke.error} />}
        </p>
      ) : null}
    </section>
  );
}
