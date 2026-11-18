import { ErrorDetails } from "@/lib/i18n/errors";
import { ui, useLocale } from "@/lib/i18n";
import {
  IconChecklist,
  IconChevronRight,
  IconCreditCard,
  IconEyeCheck,
  IconKey,
  IconLock,
  IconNotes,
  IconSend,
  IconShare,
  IconSparkles,
  IconSpeakerphone,
  IconTerminal2,
  IconTrash,
  IconUserCog,
} from "@tabler/icons-react";
import { useMutation, useQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { Fragment } from "react";
import {
  PageEmpty,
  PageRows,
  PageSection,
} from "@/components/layout/page-shell";
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
  type ActionKind,
  type ActionKindPolicy,
  approvalInboxOptions,
  createTeamApprovalRuleMutationOptions,
  revokeTeamApprovalRuleMutationOptions,
  teamApprovalSettingsMutationOptions,
  updateTeamApprovalRuleMutationOptions,
} from "@/lib/approvals";
import { reviewerGuidanceQueryOptions } from "@/lib/reviewer-guidance/queries";
import { queryClient } from "@/query-client";
import { HOST_LABELS, LabelSelect, RuleForm, RuleRow } from "./rules";
import { SharedUseRequests } from "./shared-use-requests";

/** The kinds of action Bots ask about by name, in the order members meet them. */
const ACTION_KIND_ROWS: {
  kind: ActionKind;
  title: string;
  icon: typeof IconSend;
}[] = [
  {
    kind: "sending",
    get title() {
      return ui("Sending to other people");
    },
    icon: IconSend,
  },
  {
    kind: "deleting",
    get title() {
      return ui("Deleting");
    },
    icon: IconTrash,
  },
  {
    kind: "sharing",
    get title() {
      return ui("Sharing");
    },
    icon: IconShare,
  },
  {
    kind: "publishing",
    get title() {
      return ui("Posting and publishing");
    },
    icon: IconSpeakerphone,
  },
  {
    kind: "payments",
    get title() {
      return ui("Paying and buying");
    },
    icon: IconCreditCard,
  },
  {
    kind: "security_settings",
    get title() {
      return ui("Security and access settings");
    },
    icon: IconLock,
  },
  {
    kind: "credentials",
    get title() {
      return ui("Passwords and sign-in details");
    },
    icon: IconKey,
  },
];

/** What members can do about one kind of action. Open unless the admin closes it. */
const ACTION_KIND_LABELS: Record<ActionKindPolicy, string> = {
  get open() {
    return ui("Members choose");
  },
  get ask() {
    return ui("Ask every time");
  },
  get hand_off() {
    return ui("Members do it themselves");
  },
};

/**
 * What every member's Bots must do, set by an administrator: the team-wide controls, the rules that
 * apply to everyone, and requests to use a shared account. Members read the team rules, locked, in
 * Settings → Approvals.
 */
export function TeamApprovalSettings() {
  useLocale();
  const inbox = useQuery(approvalInboxOptions());
  const guidance = useQuery(reviewerGuidanceQueryOptions());
  const team = useMutation(teamApprovalSettingsMutationOptions(queryClient));
  const addTeamRule = useMutation(
    createTeamApprovalRuleMutationOptions(queryClient),
  );
  const changeTeamRule = useMutation(
    updateTeamApprovalRuleMutationOptions(queryClient),
  );
  const revokeTeam = useMutation(
    revokeTeamApprovalRuleMutationOptions(queryClient),
  );
  const error =
    inbox.error ?? team.error ?? changeTeamRule.error ?? revokeTeam.error;
  if (inbox.isPending && !error) return null;
  const settings = inbox.data?.team;
  const teamRules = inbox.data?.teamRules ?? [];

  return (
    <>
      {error ? (
        <p className="mt-6 text-destructive text-sm" role="alert">
          {<ErrorDetails error={error} />}
        </p>
      ) : null}
      {settings ? (
        <PageSection title={ui("Team settings")}>
          <PageRows>
            <Item size="sm">
              <ItemMedia variant="icon">
                <IconEyeCheck />
              </ItemMedia>
              <ItemContent>
                <ItemTitle id="enforce-auto-review-title">
                  {ui("Require auto-review for everyone")}
                </ItemTitle>
              </ItemContent>
              <ItemActions>
                <Switch
                  aria-labelledby="enforce-auto-review-title"
                  checked={settings.enforceAutoReview}
                  disabled={team.isPending}
                  onCheckedChange={(enforceAutoReview) =>
                    team.mutate({ enforceAutoReview })
                  }
                />
              </ItemActions>
            </Item>
            <Separator />
            <Item render={<Link to="/admin/approvals/guidance" />} size="sm">
              <ItemMedia variant="icon">
                <IconNotes />
              </ItemMedia>
              <ItemContent>
                <ItemTitle>{ui("Guidance for auto-review")}</ItemTitle>
                <ItemDescription>
                  {guidance.isPending
                    ? null
                    : guidance.error
                      ? ui("Couldn't load the guidance.")
                      : (guidance.data ??
                        ui(
                          "None. Tell the reviewer what your organization needs a person for.",
                        ))}
                </ItemDescription>
              </ItemContent>
              <ItemActions>
                <IconChevronRight className="size-4 text-muted-foreground" />
              </ItemActions>
            </Item>
            <Separator />
            <Item size="sm">
              <ItemMedia variant="icon">
                <IconUserCog />
              </ItemMedia>
              <ItemContent>
                <ItemTitle id="custom-rules-title">
                  {ui("Let members set personal rules")}
                </ItemTitle>
              </ItemContent>
              <ItemActions>
                <Switch
                  aria-labelledby="custom-rules-title"
                  checked={settings.customRulesEnabled}
                  disabled={team.isPending}
                  onCheckedChange={(customRulesEnabled) =>
                    team.mutate({ customRulesEnabled })
                  }
                />
              </ItemActions>
            </Item>
            <Separator />
            <Item size="sm">
              <ItemMedia variant="icon">
                <IconTerminal2 />
              </ItemMedia>
              <ItemContent>
                <ItemTitle>
                  {ui("Commands on members' computers, at most")}
                </ItemTitle>
                <ItemDescription>
                  {ui("A member's own stricter setting still applies.")}
                </ItemDescription>
              </ItemContent>
              <ItemActions>
                <LabelSelect
                  disabled={team.isPending}
                  label={ui("Commands on members' computers, at most")}
                  labels={HOST_LABELS}
                  onChange={(hostCommandsCap) =>
                    team.mutate({ hostCommandsCap })
                  }
                  value={settings.hostCommandsCap}
                />
              </ItemActions>
            </Item>
          </PageRows>
        </PageSection>
      ) : null}
      {settings ? (
        <PageSection
          description={ui(
            "Bots ask before these. With Members choose, a member can allow one once, for a conversation, or always. Ask every time leaves only Allow once and Deny.",
          )}
          title={ui("Actions that ask first")}
        >
          <PageRows>
            {ACTION_KIND_ROWS.map(({ kind, title, icon: Icon }, index) => (
              <Fragment key={kind}>
                {index > 0 ? <Separator /> : null}
                <Item size="sm">
                  <ItemMedia variant="icon">
                    <Icon />
                  </ItemMedia>
                  <ItemContent>
                    <ItemTitle>{title}</ItemTitle>
                  </ItemContent>
                  <ItemActions>
                    <LabelSelect
                      disabled={team.isPending}
                      label={title}
                      labels={ACTION_KIND_LABELS}
                      onChange={(policy) =>
                        team.mutate({ actionKinds: { [kind]: policy } })
                      }
                      value={settings.actionKinds?.[kind] ?? "open"}
                    />
                  </ItemActions>
                </Item>
              </Fragment>
            ))}
          </PageRows>
        </PageSection>
      ) : null}
      <PageSection
        description={ui(
          "These apply to every member's Bots. Members can't change them.",
        )}
        title={ui("Team rules")}
      >
        {teamRules.length === 0 ? (
          <PageEmpty icon={IconChecklist} title={ui("No team rules")} />
        ) : null}
        <PageRows>
          {teamRules.map((rule) => (
            <Fragment key={rule.id}>
              <RuleRow
                disabled={revokeTeam.isPending || changeTeamRule.isPending}
                onChange={(behaviour) =>
                  changeTeamRule.mutate({ id: rule.id, behaviour })
                }
                onRevoke={() => revokeTeam.mutate(rule.id)}
                rule={rule}
                team
              />
              <Separator />
            </Fragment>
          ))}
          <Item render={<Link to="/admin/approvals/describe" />} size="sm">
            <ItemMedia variant="icon">
              <IconSparkles />
            </ItemMedia>
            <ItemContent>
              <ItemTitle>{ui("Describe it in words")}</ItemTitle>
              <ItemDescription>
                {ui(
                  "Say what Bots should do, and your model writes the rules.",
                )}
              </ItemDescription>
            </ItemContent>
            <ItemActions>
              <IconChevronRight className="size-4 text-muted-foreground" />
            </ItemActions>
          </Item>
          <Separator />
          <RuleForm label={ui("Add a team rule")} save={addTeamRule} />
        </PageRows>
      </PageSection>
      <SharedUseRequests />
    </>
  );
}
