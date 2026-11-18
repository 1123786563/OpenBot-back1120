import { ui, useLocale, uiNodes, getLocale } from "@/lib/i18n";
import {
  IconLock,
  IconSearch,
  IconShieldCheck,
  IconUser,
  IconUsers,
} from "@tabler/icons-react";
import { useInfiniteQuery, useMutation, useQuery } from "@tanstack/react-query";
import { createFileRoute } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import {
  PageEmpty,
  PageRows,
  PageSection,
  PageShell,
} from "@/components/layout/page-shell";
import { StaggerItem } from "@/components/layout/stagger";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
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
import { currentUserQueryOptions } from "@/lib/auth/queries";
import { terminateMemberComputersMutationOptions } from "@/lib/enterprise/mutations";
import {
  setPersonAccessMutationOptions,
  setPersonRoleMutationOptions,
} from "@/lib/people/mutations";
import { type Person, peopleListQueryOptions } from "@/lib/people/queries";
import { queryClient } from "@/query-client";

export const Route = createFileRoute("/_authed/admin/people")({
  component: PeoplePage,
});

/** What each provider is called, since the id it registers under is not a name. */
const PROVIDER_NAMES: Record<string, string> = {
  get google() {
    return ui("Google");
  },
  get microsoft() {
    return ui("Microsoft");
  },
  get okta() {
    return ui("Okta");
  },
};

/**
 * The second line of a person's row: how they got here, and when they were last here.
 *
 * The address is the title, so this is everything else worth knowing at a glance while deciding
 * whether somebody should still have access.
 */
function describe(person: Person): string {
  const providers = person.providers
    .map((provider) => PROVIDER_NAMES[provider] ?? provider)
    .join(", ");
  const when = person.lastSignedInAt
    ? ui("last signed in {{value0}}", {
        value0: String(
          new Date(person.lastSignedInAt).toLocaleDateString(getLocale()),
        ),
      })
    : "never signed in";

  if (person.revoked)
    return ui("Access removed · {{value0}} · {{value1}}", {
      value0: String(providers || "no provider"),
      value1: String(when),
    });
  if (person.configuredAdmin) {
    return ui("Admin by configuration · {{value0}}", { value0: String(when) });
  }
  return `${providers || "no provider"} · ${when}`;
}

function PeoplePage() {
  useLocale();
  const [search, setSearch] = useState("");
  /*
   * Debounced, so typing a name is one request rather than one per keystroke against an aggregate
   * over every user in the deployment.
   */
  const [query, setQuery] = useState("");
  useEffect(() => {
    const timer = setTimeout(() => setQuery(search), 250);
    return () => clearTimeout(timer);
  }, [search]);

  const people = useInfiniteQuery(peopleListQueryOptions(query));
  const rows = people.data?.pages.flatMap((page) => page.people) ?? [];
  const currentUser = useQuery(currentUserQueryOptions());
  const setRole = useMutation(setPersonRoleMutationOptions(queryClient));
  const setAccess = useMutation(setPersonAccessMutationOptions(queryClient));
  // Offboarding: stops this person's Bots' computers, keeping their disks. Access is unchanged.
  const terminate = useMutation(terminateMemberComputersMutationOptions());

  // The server refuses these too. Disabling them here is so the screen does not offer something it
  // knows will be refused, not so the rule is enforced in the browser.
  const failure = setRole.error ?? setAccess.error ?? terminate.error;

  return (
    <PageShell
      description={ui(
        "Manage access for people who have signed in. Only admins can access the Admin pages.",
      )}
      title={ui("People")}
    >
      <PageSection
        description={ui(
          "Addresses in INITIAL_ADMIN_EMAILS are always admins. You can't change them here.",
        )}
        title={ui("Who is here")}
      >
        {failure ? (
          <p className="mt-4 text-destructive text-sm" role="alert">
            {failure.message}
          </p>
        ) : null}
        {terminate.data ? (
          <p className="mt-4 text-muted-foreground text-sm" role="status">
            {uiNodes(
              "Stopped {{slot0}} {{slot1}}{{slot2}}. Their disks are kept.",
              [
                terminate.data.stopped.length,
                terminate.data.stopped.length === 1
                  ? ui("computer")
                  : ui("computers"),
                terminate.data.failed.length > 0
                  ? `. ${terminate.data.failed.length} couldn't be stopped`
                  : "",
              ],
            )}
          </p>
        ) : null}
        {/*
          Server-side search. Filtering what already arrived would only search the first page, which
          is the opposite of what somebody looking for a colleague needs.
        */}
        <Input
          aria-label={ui("Search people")}
          className="mt-4"
          onChange={(event) => setSearch(event.target.value)}
          placeholder={ui("Search by name or address")}
          value={search}
        />

        {people.isPending ? null : people.error ? (
          <p className="mt-4 text-destructive text-sm" role="alert">
            {ui("Couldn't load people. Reload the page.")}
          </p>
        ) : rows.length === 0 ? (
          <PageEmpty
            icon={query ? IconSearch : IconUsers}
            title={query ? ui("No matches") : ui("Nobody has signed in yet")}
          >
            {query
              ? ui('Nobody matches "{{value0}}".', { value0: String(query) })
              : ui("People show here once they do.")}
          </PageEmpty>
        ) : (
          <PageRows>
            {rows.map((person, index) => {
              const isSelf = person.id === currentUser.data?.id;
              const busy = setRole.isPending || setAccess.isPending;

              return (
                <StaggerItem index={index} key={person.id}>
                  <Item size="sm">
                    <ItemMedia variant="icon">
                      {person.revoked ? (
                        <IconLock />
                      ) : person.role === "admin" ? (
                        <IconShieldCheck />
                      ) : (
                        <IconUser />
                      )}
                    </ItemMedia>
                    <ItemContent>
                      <ItemTitle>{person.name ?? person.email}</ItemTitle>
                      <ItemDescription>
                        {person.name ? `${person.email} · ` : ""}
                        {describe(person)}
                      </ItemDescription>
                    </ItemContent>
                    <ItemActions>
                      {/*
                       * Removing access is the louder decision, so it is a button rather than a
                       * second switch: two switches on one row invites somebody to flip the wrong
                       * one, and these two do very different things.
                       */}
                      <Button
                        disabled={terminate.isPending}
                        onClick={() => terminate.mutate(person.id)}
                        size="sm"
                        variant="outline"
                      >
                        {ui("Stop computers")}
                      </Button>
                      <Button
                        disabled={busy || isSelf || person.configuredAdmin}
                        onClick={() =>
                          setAccess.mutate({
                            userId: person.id,
                            revoked: !person.revoked,
                          })
                        }
                        size="sm"
                        variant={person.revoked ? "outline" : "destructive"}
                      >
                        {person.revoked ? ui("Restore") : ui("Remove")}
                      </Button>
                      <Switch
                        aria-label={ui("Admin: {{value0}}", {
                          value0: String(person.email),
                        })}
                        checked={person.role === "admin"}
                        disabled={busy || person.configuredAdmin || isSelf}
                        onCheckedChange={(checked) =>
                          setRole.mutate({
                            userId: person.id,
                            role: checked ? "admin" : "user",
                          })
                        }
                      />
                    </ItemActions>
                  </Item>
                  {index !== rows.length - 1 && <Separator />}
                </StaggerItem>
              );
            })}
          </PageRows>
        )}

        {/*
          Only when there is one. A button that says there is more when there is not is worse than
          no button, and this list ends for most deployments on the first page.
        */}
        {people.hasNextPage ? (
          <Button
            className="mt-4"
            disabled={people.isFetchingNextPage}
            onClick={() => people.fetchNextPage()}
            size="sm"
            variant="outline"
          >
            {people.isFetchingNextPage ? ui("Loading…") : ui("Show more")}
          </Button>
        ) : null}
      </PageSection>
    </PageShell>
  );
}
