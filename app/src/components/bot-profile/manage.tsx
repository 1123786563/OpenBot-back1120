import { ErrorDetails } from "@/lib/i18n/errors";
import { ui, useLocale, uiNodes } from "@/lib/i18n";
import {
  IconChevronRight,
  IconCopy,
  IconEyeOff,
  IconPin,
  IconRefresh,
  IconTrash,
} from "@tabler/icons-react";
import { useMutation, useQuery } from "@tanstack/react-query";
import { useState } from "react";
import { PageRows, PageSection } from "@/components/layout/page-shell";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogBody,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  Item,
  ItemActions,
  ItemContent,
  ItemDescription,
  ItemMedia,
  ItemTitle,
} from "@/components/ui/item";
import { Separator } from "@/components/ui/separator";
import { Switch } from "@/components/ui/switch";
import {
  deleteAgentMutationOptions,
  duplicateAgentMutationOptions,
  setAgentHiddenMutationOptions,
  setAgentPinnedMutationOptions,
} from "@/lib/agents/mutations";
import type { AgentProfile } from "@/lib/agents/queries";
import { resetBotMutationOptions } from "@/lib/bot-lifecycle/mutations";
import {
  botResetPlanQueryOptions,
  type ResetPlan,
} from "@/lib/bot-lifecycle/queries";
import {
  deploymentCapabilitiesQueryOptions,
  useOffersMemory,
} from "@/lib/deployment/queries";
import { queryClient } from "@/query-client";

/**
 * Whether this is the personal edition, where one person uses OpenBot. Nobody else has a Bots list
 * or a conversation with a Bot there, so the rows below say nothing about other people.
 */
function usePersonal(): boolean {
  useLocale();
  return (
    useQuery(deploymentCapabilitiesQueryOptions()).data?.edition === "personal"
  );
}

/** Each count the notice lists, in the words the person reads, skipping the kinds with nothing. */
function resetLines(plan: ResetPlan): string[] {
  const lines: [number, string, string][] = [
    [plan.conversations, "conversation", "conversations"],
    [plan.memorySources, "memory source", "memory sources"],
    [plan.memories, "imported memory", "imported memories"],
    [plan.routines, "routine", "routines"],
    [plan.responsibilities, "goal", "goals"],
    [plan.followUps, "scheduled follow-up", "scheduled follow-ups"],
    [plan.formedMemories, "memory it formed", "memories it formed"],
    [plan.backgroundResearch, "background research", "background research"],
    [plan.standingApprovals, "standing permission", "standing permissions"],
  ];
  return lines
    .filter(([count]) => count > 0)
    .map(([count, one, many]) => `${count} ${count === 1 ? one : many}`);
}

function ResetDialog({
  agent,
  onOpenChange,
  open,
}: {
  agent: AgentProfile;
  onOpenChange: (open: boolean) => void;
  open: boolean;
}) {
  useLocale();
  const plan = useQuery({
    ...botResetPlanQueryOptions(agent.id),
    enabled: open,
  });
  const reset = useMutation(resetBotMutationOptions(queryClient));
  const memory = useOffersMemory();
  const personal = usePersonal();
  const lines = plan.data ? resetLines(plan.data) : [];
  return (
    <Dialog onOpenChange={onOpenChange} open={open}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>
            {ui("Reset")} {agent.name}?
          </DialogTitle>
          <DialogDescription>
            {personal
              ? ui(
                  "This deletes what {{value0}} has with you. You can't undo this.",
                  { value0: String(agent.name) },
                )
              : ui(
                  "This deletes what {{value0}} has with you. Other people's conversations and data stay. You can't undo this.",
                  { value0: String(agent.name) },
                )}
          </DialogDescription>
        </DialogHeader>
        <DialogBody className="mt-4 overflow-y-auto">
          {plan.isPending ? null : plan.error ? (
            <p className="text-destructive text-sm" role="alert">
              {ui("Couldn't check what a reset would delete. Try again.")}
            </p>
          ) : reset.isSuccess ? (
            <p className="text-sm">
              {uiNodes("Done. {{slot0}}starts fresh with you.", [agent.name])}
            </p>
          ) : (
            <div className="grid gap-2 text-sm">
              {lines.length === 0 ? (
                <p>{ui("There's nothing of yours to delete.")}</p>
              ) : (
                <>
                  <p>{ui("This will delete:")}</p>
                  <ul className="list-disc pl-5">
                    {lines.map((line) => (
                      <li key={line}>{line}</li>
                    ))}
                  </ul>
                </>
              )}
              {plan.data.sharedConversationsKept > 0 ? (
                <p className="text-muted-foreground">
                  {uiNodes(
                    "{{slot0}}conversation{{slot1}} shared with other people or Bots and will be kept.",
                    [
                      plan.data.sharedConversationsKept,
                      plan.data.sharedConversationsKept === 1
                        ? ui(" is")
                        : ui("s are"),
                    ],
                  )}
                </p>
              ) : null}
              {/* Where memory isn't offered there are no memories to keep (see `offersMemory`). */}
              {memory ? (
                <p className="text-muted-foreground">
                  {ui("Memories you told a Bot yourself are kept.")}
                </p>
              ) : null}
            </div>
          )}
          {reset.error ? (
            <p className="mt-2 text-destructive text-sm" role="alert">
              {<ErrorDetails error={reset.error} />}
            </p>
          ) : null}
        </DialogBody>
        <DialogFooter className="mt-4">
          <Button
            onClick={() => onOpenChange(false)}
            size="sm"
            variant="outline"
          >
            {reset.isSuccess ? ui("Close") : ui("Cancel")}
          </Button>
          {reset.isSuccess ? null : (
            <Button
              disabled={!plan.data || lines.length === 0 || reset.isPending}
              onClick={() => reset.mutate(agent.id)}
              size="sm"
              variant="destructive"
            >
              {reset.isPending ? ui("Resetting…") : ui("Delete and reset")}
            </Button>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/**
 * What can be done to a Bot: pin and hide (the person's own list only), duplicate, reset what it
 * has with this person, and, for whoever may manage it, delete it. The personal edition has one
 * person, so there the rows don't mention anybody else's list or conversations.
 *
 * Navigation is the caller's: hiding and deleting leave the page, duplicating opens the copy.
 */
export function ManageSection({
  agent,
  onHidden,
  onDuplicated,
  onDeleted,
}: {
  agent: AgentProfile;
  onHidden: () => void;
  onDuplicated: (copyId: string) => void;
  onDeleted: () => void;
}) {
  useLocale();
  const setPinned = useMutation(setAgentPinnedMutationOptions(queryClient));
  const setHidden = useMutation(setAgentHiddenMutationOptions(queryClient));
  const duplicate = useMutation(duplicateAgentMutationOptions(queryClient));
  const remove = useMutation(deleteAgentMutationOptions(queryClient));
  const [resetOpen, setResetOpen] = useState(false);
  const [deleteOpen, setDeleteOpen] = useState(false);
  const memory = useOffersMemory();
  const personal = usePersonal();
  // Said only where somebody else has a list of their own.
  const onlyYours = personal ? "" : " Only your list changes.";
  const error = setPinned.error ?? setHidden.error ?? duplicate.error;
  // An administrator put it in this person's list; it stays pinned and cannot be hidden.
  const assigned = agent.assignedToMe === true;

  return (
    <PageSection title={ui("Manage")}>
      {error ? (
        <p className="mt-4 text-destructive text-sm" role="alert">
          {<ErrorDetails error={error} />}
        </p>
      ) : null}
      <PageRows>
        <Item size="sm">
          <ItemMedia variant="icon">
            <IconPin />
          </ItemMedia>
          <ItemContent>
            <ItemTitle>{ui("Pinned")}</ItemTitle>
            <ItemDescription>
              {assigned
                ? ui(
                    "An admin assigned it to you. It stays at the top of your Bots list.",
                  )
                : agent.pinned
                  ? ui("At the top of your Bots list.{{value0}}", {
                      value0: String(onlyYours),
                    })
                  : ui("Keep it at the top of your Bots list.{{value0}}", {
                      value0: String(onlyYours),
                    })}
            </ItemDescription>
          </ItemContent>
          <ItemActions>
            <Switch
              aria-label={ui("Pinned")}
              checked={agent.pinned || assigned}
              disabled={assigned || setPinned.isPending}
              onCheckedChange={(pinned) =>
                setPinned.mutate({ agentId: agent.id, pinned })
              }
            />
          </ItemActions>
        </Item>
        <Separator />
        <Item size="sm">
          <ItemMedia variant="icon">
            <IconEyeOff />
          </ItemMedia>
          <ItemContent>
            <ItemTitle>{ui("Hidden")}</ItemTitle>
            <ItemDescription>
              {assigned
                ? ui("An admin assigned it to you. You can't hide it.")
                : agent.hidden
                  ? ui("Under Hidden on your Bots list.{{value0}}", {
                      value0: String(onlyYours),
                    })
                  : ui("Take it off your Bots list.{{value0}}", {
                      value0: String(onlyYours),
                    })}
            </ItemDescription>
          </ItemContent>
          <ItemActions>
            <Switch
              aria-label={ui("Hidden")}
              checked={agent.hidden}
              disabled={assigned || setHidden.isPending}
              onCheckedChange={async (hidden) => {
                await setHidden.mutateAsync({ agentId: agent.id, hidden });
                if (hidden) onHidden();
              }}
            />
          </ItemActions>
        </Item>
        <Separator />
        <Item
          render={
            <button
              disabled={duplicate.isPending}
              onClick={async () =>
                onDuplicated((await duplicate.mutateAsync(agent.id)).id)
              }
              type="button"
            />
          }
          size="sm"
        >
          <ItemMedia variant="icon">
            <IconCopy />
          </ItemMedia>
          <ItemContent>
            <ItemTitle>{ui("Duplicate")}</ItemTitle>
            <ItemDescription>
              {ui(
                "Make your own copy. Its conversations and keys aren't copied.",
              )}
            </ItemDescription>
          </ItemContent>
        </Item>
        <Separator />
        <Item
          render={<button onClick={() => setResetOpen(true)} type="button" />}
          size="sm"
        >
          <ItemMedia variant="icon">
            <IconRefresh />
          </ItemMedia>
          <ItemContent>
            <ItemTitle>{ui("Reset")} </ItemTitle>
            <ItemDescription>
              {/* Where memory isn't offered a Bot remembers nothing to delete (see `offersMemory`). */}
              {memory
                ? ui(
                    "Delete your conversations with it, what it remembers for you, and its scheduled work. You'll see the list first.",
                  )
                : ui(
                    "Delete your conversations with it and its scheduled work. You'll see the list first.",
                  )}
            </ItemDescription>
          </ItemContent>
          <ItemActions>
            <IconChevronRight className="size-4 text-muted-foreground" />
          </ItemActions>
        </Item>
        {agent.canManage ? (
          <>
            <Separator />
            <Item
              render={
                <button onClick={() => setDeleteOpen(true)} type="button" />
              }
              size="sm"
            >
              <ItemMedia variant="icon">
                <IconTrash />
              </ItemMedia>
              <ItemContent>
                <ItemTitle>{ui("Delete")} </ItemTitle>
                <ItemDescription>
                  {/* A deleted Bot's conversations stay readable (channel-chat.tsx says so there). */}
                  {personal
                    ? ui(
                        "Deletes it. You can still read your conversations with it. You can't undo this.",
                      )
                    : ui("Deletes it for everyone. You can't undo this.")}
                </ItemDescription>
              </ItemContent>
              <ItemActions>
                <IconChevronRight className="size-4 text-muted-foreground" />
              </ItemActions>
            </Item>
          </>
        ) : null}
      </PageRows>
      <ResetDialog agent={agent} onOpenChange={setResetOpen} open={resetOpen} />
      <Dialog onOpenChange={setDeleteOpen} open={deleteOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>
              {ui("Delete")} {agent.name}?
            </DialogTitle>
            <DialogDescription>
              {personal
                ? ui(
                    "You can still read your conversations with it, but it can't reply. You can't undo this.",
                  )
                : ui("It's deleted for everyone. You can't undo this.")}
            </DialogDescription>
          </DialogHeader>
          {remove.error ? (
            <DialogBody className="mt-4">
              <p className="text-destructive text-sm" role="alert">
                {<ErrorDetails error={remove.error} />}
              </p>
            </DialogBody>
          ) : null}
          <DialogFooter className="mt-4">
            <Button
              onClick={() => setDeleteOpen(false)}
              size="sm"
              variant="outline"
            >
              {ui("Cancel")}
            </Button>
            <Button
              disabled={remove.isPending}
              onClick={async () => {
                await remove.mutateAsync(agent.id);
                onDeleted();
              }}
              size="sm"
              variant="destructive"
            >
              {remove.isPending ? ui("Deleting…") : ui("Delete")}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </PageSection>
  );
}
