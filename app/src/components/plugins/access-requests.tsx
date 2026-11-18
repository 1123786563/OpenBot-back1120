import { ErrorDetails } from "@/lib/i18n/errors";
import { ui, useLocale } from "@/lib/i18n";
import { IconInbox } from "@tabler/icons-react";
import { useMutation, useQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { Fragment } from "react";
import { PageRows, PageSection } from "@/components/layout/page-shell";
import { Button } from "@/components/ui/button";
import {
  Item,
  ItemActions,
  ItemContent,
  ItemDescription,
  ItemFooter,
  ItemMedia,
  ItemTitle,
} from "@/components/ui/item";
import { Separator } from "@/components/ui/separator";
import {
  approveAppAccessRequestMutationOptions,
  dismissAppAccessRequestMutationOptions,
} from "@/lib/app-access/mutations";
import {
  type AppAccessRequest,
  appAccessInboxQueryOptions,
} from "@/lib/app-access/queries";
import { useManagePaths } from "@/lib/manage-paths";
import { relativeTime } from "@/lib/relative-time";
import { queryClient } from "@/query-client";

/**
 * The requests people have filed for an administrator to answer: switch an app on, give it to a
 * Bot, or connect its shared account.
 *
 * ONE SECTION, ON TWO SCREENS. An app's own admin page lists the requests about that app, because
 * that is where an administrator is already deciding about it. The Plugins list carries all of them,
 * because an app nobody has switched on has no page of its own to list them on — a Composio app
 * enabled by approving the request is exactly that case — and because a request nobody sees is a
 * person waiting for nothing.
 *
 * APPROVE DOES THE THING. The server switches the app on and grants it to the Bot in the same press,
 * or refuses with the step only an administrator can take first — a token to paste, a team account
 * to connect — and the request stays pending. That sentence is drawn on the row it is about, because
 * the screen's own banner is a long way from the button that was pressed.
 *
 * A GRANT IS READ-ONLY UNTIL SOMEBODY CHOOSES MORE. One press is not a decision about every action an
 * app offers — Gmail's include sending and deleting mail — so approving gives the Bot the app's
 * read-only actions and nothing else, and an app with none is refused with a sentence pointing at the
 * Bot's page. The row says so before the press, and links to that page where it can.
 *
 * REQUESTS, NOT CONNECTIONS. Each row names who asked, because they asked; nothing here says who has
 * connected what, which stays private to each person (see the note on `admin/plugins/$key.tsx`).
 *
 * Nothing at all while the read is open or when nothing is waiting: an empty section on every app's
 * page would teach an administrator to scroll past the heading.
 */
export function AccessRequestsSection({ app }: { app?: string }) {
  useLocale();
  const inbox = useQuery(appAccessInboxQueryOptions(true, app));
  if (inbox.isPending) return null;
  if (inbox.error)
    return (
      <PageSection title={ui("Requests")}>
        <p className="mt-4 text-destructive text-sm" role="alert">
          {ui("Couldn't load access requests. Reload the page.")}
        </p>
      </PageSection>
    );
  const requests = inbox.data?.requests ?? [];
  if (requests.length === 0) return null;
  return (
    <PageSection
      description={
        app
          ? ui(
              "People asking for this app. Approve does what they asked, right away.",
            )
          : ui(
              "People asking for an app to be turned on, given to a Bot, or connected. Approve does what they asked, right away.",
            )
      }
      title={ui("Requests")}
    >
      <PageRows>
        {requests.map((request, index) => (
          <Fragment key={request.id}>
            {index > 0 ? <Separator /> : null}
            <AccessRequestRow request={request} />
          </Fragment>
        ))}
      </PageRows>
    </PageSection>
  );
}

/** What the request asks for, as the thing an administrator would do. */
export function askedFor(request: AppAccessRequest): string {
  const bot = request.botName ?? "a Bot";
  switch (request.kind) {
    case "enable":
      return ui("Turn on {{value0}} for {{value1}}", {
        value0: String(request.appTitle),
        value1: String(bot),
      });
    case "grant":
      return ui("Give {{value0}} to {{value1}}", {
        value0: String(request.appTitle),
        value1: String(bot),
      });
    case "connect_shared":
      return ui("Connect the shared {{value0}} account", {
        value0: String(request.appTitle),
      });
  }
}

function AccessRequestRow({ request }: { request: AppAccessRequest }) {
  useLocale();
  // One pair per row, so a refusal is drawn under the request it is about and nowhere else.
  const approve = useMutation(
    approveAppAccessRequestMutationOptions(queryClient),
  );
  const dismiss = useMutation(
    dismissAppAccessRequestMutationOptions(queryClient),
  );
  const busy = approve.isPending || dismiss.isPending;
  const error = approve.error ?? dismiss.error;
  const who = request.requesterName ?? request.requesterEmail ?? "Somebody";
  return (
    <Item data-request={request.id} size="sm">
      <ItemMedia variant="icon">
        <IconInbox />
      </ItemMedia>
      <ItemContent>
        <ItemTitle>{askedFor(request)}</ItemTitle>
        <ItemDescription className="line-clamp-none">
          {who} {ui("asked")} {relativeTime(request.createdAt)}
          {request.kind === "connect_shared" && request.botName
            ? ui(", for {{value0}}", { value0: String(request.botName) })
            : ""}
          . <GrantNote request={request} />
        </ItemDescription>
      </ItemContent>
      <ItemActions>
        <Button
          disabled={busy}
          onClick={() => {
            approve.reset();
            dismiss.mutate(request.id);
          }}
          size="sm"
          variant="ghost"
        >
          {dismiss.isPending ? ui("Dismissing…") : ui("Dismiss")}
        </Button>
        <Button
          disabled={busy}
          onClick={() => {
            dismiss.reset();
            approve.mutate({ id: request.id });
          }}
          size="sm"
        >
          {approve.isPending ? ui("Approving…") : ui("Approve")}
        </Button>
      </ItemActions>
      {error ? (
        <ItemFooter>
          <p className="text-destructive text-sm" role="alert">
            {<ErrorDetails error={error} />}
          </p>
        </ItemFooter>
      ) : null}
    </Item>
  );
}

/**
 * What approving gives a Bot, for a request that grants one: the app's read-only actions, with the
 * rest chosen on the Bot's page under the app. Linked there for a grant, whose app is already on
 * and so has that page; an app still to be switched on has none until the press that switches it on.
 */
function GrantNote({ request }: { request: AppAccessRequest }) {
  useLocale();
  const paths = useManagePaths();
  if (request.kind === "connect_shared" || !request.agentId) return null;
  const bot = request.botName ?? "the Bot";
  const where = `the Bot's page under ${request.appTitle}`;
  const page =
    request.kind === "grant" ? (
      <Link {...paths.pluginBot(request.appKey, request.agentId)}>{where}</Link>
    ) : (
      where
    );
  return (
    <>
      {ui("Approving gives")} {bot} {ui("only")} {request.appTitle}
      {ui("'s read-only actions. Choose any others on")} {page}.
    </>
  );
}

/**
 * How many requests are waiting, for a list row that wants to say so: one app's, or all of them.
 * Null while nothing is waiting or nothing has been read, so a row draws nothing rather than "0".
 */
export function usePendingRequestCounts() {
  useLocale();
  const inbox = useQuery(appAccessInboxQueryOptions(true));
  return inbox.data?.counts ?? null;
}
