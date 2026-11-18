import { ErrorDetails } from "@/lib/i18n/errors";
import { ui, useLocale, uiNodes } from "@/lib/i18n";
import {
  IconChevronRight,
  IconListSearch,
  IconPlus,
  IconShieldX,
} from "@tabler/icons-react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { createFileRoute, Link } from "@tanstack/react-router";
import {
  PageEmpty,
  PageRows,
  PageSection,
  PageShell,
} from "@/components/layout/page-shell";
import { StaggerItem } from "@/components/layout/stagger";
import { Button } from "@/components/ui/button";
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
import { ruleLabel } from "@/lib/boundaries/rules";
import { saveActionPolicyMutationOptions } from "@/lib/computers/mutations";
import { actionPolicyQueryOptions } from "@/lib/computers/queries";

export const Route = createFileRoute("/_authed/admin/boundaries")({
  component: BoundariesPage,
});

const DESCRIPTION =
  "Define actions that Bots must never take. OpenBot checks these rules before a Bot acts on its computer or in a connected app.";

/**
 * The deployment's boundaries, read as a list of things Bots may never do.
 *
 * It used to be one screen that was also the editor: the rule language explained in a paragraph of
 * attribute names, rules shown as raw CEL, and ready-made rules drawn as buttons. Nobody could tell
 * from it what the page was for. Now each rule is a row with a name, adding one is its own screen
 * (`boundaries_.new.tsx`) and a rule opens to what it has stopped (`boundaries_.$index.tsx`).
 */
function BoundariesPage() {
  useLocale();
  const queryClient = useQueryClient();
  const stored = useQuery(actionPolicyQueryOptions());
  const savePolicy = useMutation(saveActionPolicyMutationOptions(queryClient));
  /* What the server stored wins once a save lands: it normalises what it keeps. */
  const policy = savePolicy.data ?? stored.data ?? null;

  const addRule = (
    <Button
      render={(props) => <Link {...props} to="/admin/boundaries/new" />}
      size="sm"
      variant="ghost"
    >
      {uiNodes("{{slot0}}Add rule", [<IconPlus key="slot0" />])}
    </Button>
  );

  if (!policy) {
    return (
      <PageShell description={ui(DESCRIPTION)} title={ui("Boundaries")}>
        {/* Nothing until the policy is known: a rule list that guesses is worse than a blank. */}
        {stored.error ? (
          <p className="text-destructive text-sm" role="alert">
            {<ErrorDetails error={stored.error} />}
          </p>
        ) : null}
      </PageShell>
    );
  }

  const trial = policy.mode === "dry-run";
  const allowsEverythingElse =
    policy.allow.length === 1 && policy.allow[0] === "true";

  return (
    <PageShell
      action={addRule}
      description={ui(DESCRIPTION)}
      title={ui("Boundaries")}
    >
      <PageSection title={ui("Bots may never")}>
        {policy.deny.length === 0 ? (
          <PageEmpty
            action={
              <Button
                render={(props) => (
                  <Link {...props} to="/admin/boundaries/new" />
                )}
                size="sm"
                variant="outline"
              >
                {uiNodes("{{slot0}}Add rule", [<IconPlus key="slot0" />])}
              </Button>
            }
            icon={IconShieldX}
            title={ui("No rules yet")}
          >
            {ui("Bots can do anything their own permissions allow.")}
          </PageEmpty>
        ) : (
          <PageRows>
            {policy.deny.map((rule, index) => {
              const label = ruleLabel(policy, rule);
              return (
                <StaggerItem index={index} key={rule}>
                  <Item
                    render={(props) => (
                      <Link
                        {...props}
                        params={{ index: String(index) }}
                        to="/admin/boundaries/$index"
                      />
                    )}
                    size="sm"
                  >
                    <ItemMedia variant="icon">
                      <IconShieldX />
                    </ItemMedia>
                    <ItemContent className="min-w-0">
                      <ItemTitle>{label.name}</ItemTitle>
                      {label.description ? (
                        <ItemDescription>{label.description}</ItemDescription>
                      ) : (
                        // A rule nobody named is still told apart from the next by what it says.
                        <ItemDescription className="line-clamp-1 font-mono">
                          {rule}
                        </ItemDescription>
                      )}
                    </ItemContent>
                    <IconChevronRight className="size-4 shrink-0 text-muted-foreground" />
                  </Item>
                  {index !== policy.deny.length - 1 && <Separator />}
                </StaggerItem>
              );
            })}
          </PageRows>
        )}
      </PageSection>

      <PageSection title={ui("How rules apply")}>
        <PageRows>
          <Item size="sm">
            <ItemContent>
              <ItemTitle>{ui("Trial mode")}</ItemTitle>
              <ItemDescription>
                {trial
                  ? ui(
                      "On. A matching action goes ahead and is recorded in Audit, so you can see what a rule catches before it stops anything.",
                    )
                  : ui(
                      "Off. A matching action is stopped, and the Bot is told which rule stopped it.",
                    )}
              </ItemDescription>
            </ItemContent>
            <ItemActions>
              <Switch
                aria-label={ui("Trial mode")}
                checked={trial}
                disabled={savePolicy.isPending}
                onCheckedChange={(checked) =>
                  savePolicy.mutate({
                    ...policy,
                    mode: checked ? "dry-run" : "enforce",
                  })
                }
              />
            </ItemActions>
          </Item>
          <Separator />
          <Item
            render={(props) => <Link {...props} to="/admin/audit" />}
            size="sm"
          >
            <ItemMedia variant="icon">
              <IconListSearch />
            </ItemMedia>
            <ItemContent>
              <ItemTitle>{ui("Stopped actions")}</ItemTitle>
              <ItemDescription>
                {ui(
                  "In Audit, choose Blocked to see every action a rule stopped and which rule it was.",
                )}
              </ItemDescription>
            </ItemContent>
            <IconChevronRight className="size-4 shrink-0 text-muted-foreground" />
          </Item>
          <Separator />
          {/*
           * Read-only, and only interesting when it is not the default. Allow rules are checked after
           * the list above and an empty list refuses everything, so a deployment that narrowed them
           * in configuration needs to see that here rather than wonder why every action is refused.
           */}
          <Item size="sm">
            <ItemContent className="min-w-0">
              <ItemTitle>{ui("Everything else")}</ItemTitle>
              <ItemDescription
                className={allowsEverythingElse ? undefined : "font-mono"}
              >
                {allowsEverythingElse
                  ? ui(
                      "Allowed. A Bot can do anything no rule above stops, within its own permissions.",
                    )
                  : policy.allow.length === 0
                    ? ui("Nothing else is allowed. Every action is refused.")
                    : ui("Only what these allow: {{value0}}", {
                        value0: String(policy.allow.join(" · ")),
                      })}
              </ItemDescription>
            </ItemContent>
          </Item>
        </PageRows>
        {savePolicy.error ? (
          <p className="mt-3 text-destructive text-sm" role="alert">
            {<ErrorDetails error={savePolicy.error} />}
          </p>
        ) : null}
      </PageSection>
    </PageShell>
  );
}
