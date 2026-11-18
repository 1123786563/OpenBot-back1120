import { ui, useLocale } from "@/lib/i18n";
import {
  IconBrain,
  IconBuildingBank,
  IconChecks,
  IconChevronRight,
  IconCode,
  IconDeviceDesktop,
  IconFileText,
  IconKey,
  IconLayoutGrid,
  IconListDetails,
  IconLockAccess,
  IconPuzzle,
  IconRadar,
  IconShieldCheck,
  IconUsers,
  IconZoomQuestion,
} from "@tabler/icons-react";
import {
  createFileRoute,
  Link,
  type LinkOptions,
} from "@tanstack/react-router";
import {
  PageRows,
  PageSection,
  PageShell,
} from "@/components/layout/page-shell";
import { StaggerItem } from "@/components/layout/stagger";
import {
  Item,
  ItemContent,
  ItemDescription,
  ItemMedia,
  ItemTitle,
} from "@/components/ui/item";
import { Separator } from "@/components/ui/separator";

export const Route = createFileRoute("/_authed/admin/")({
  component: RouteComponent,
});

/**
 * Grouped by what the decision is about rather than by how the code is organised.
 *
 * "What Bots can reach" is the group an administrator arrives worrying about, so it goes first.
 * Everything in it either grants a capability or fences one in.
 */
const SECTIONS: {
  title: string;
  description: string;
  items: {
    description: string;
    icon: React.ComponentType<{ className?: string }>;
    linkOptions: LinkOptions;
    title: string;
  }[];
}[] = [
  {
    get title() {
      return ui("What Bots can reach");
    },
    get description() {
      return ui("Control what Bots can access outside OpenBot.");
    },
    items: [
      {
        get title() {
          return ui("Credentials");
        },
        get description() {
          return ui("Manage this deployment’s keys and tokens.");
        },
        icon: IconKey,
        linkOptions: { to: "/admin/credentials" },
      },
      {
        get title() {
          return ui("Boundaries");
        },
        get description() {
          return ui("Define actions that no Bot may take.");
        },
        icon: IconShieldCheck,
        linkOptions: { to: "/admin/boundaries" },
      },
      {
        get title() {
          return ui("Approvals");
        },
        get description() {
          return ui("Choose which actions require approval for members’ Bots.");
        },
        icon: IconChecks,
        linkOptions: { to: "/admin/approvals" },
      },
      {
        get title() {
          return ui("Computers");
        },
        get description() {
          return ui(
            "Manage the computers that run Bot tools, when idle ones stop, and where they can connect.",
          );
        },
        icon: IconDeviceDesktop,
        linkOptions: { to: "/admin/computers" },
      },
    ],
  },
  {
    get title() {
      return ui("What Bots can do");
    },
    get description() {
      return ui(
        "Configure the models, apps, skills, and UI components available to Bots.",
      );
    },
    items: [
      {
        get title() {
          return ui("Plugins");
        },
        get description() {
          return ui(
            "Connect services, choose which Bots can use them, and approve MCP servers.",
          );
        },
        icon: IconPuzzle,
        linkOptions: { to: "/admin/plugins" },
      },
      {
        get title() {
          return ui("Providers");
        },
        get description() {
          return ui(
            "See which provider serves your Bots' models, and choose which models they may use.",
          );
        },
        icon: IconBrain,
        linkOptions: { to: "/admin/providers" },
      },
      {
        get title() {
          return ui("Skills");
        },
        get description() {
          return ui("Create reusable instructions people can run with /.");
        },
        icon: IconFileText,
        linkOptions: { to: "/admin/skills" },
      },
      {
        get title() {
          return ui("Automatic learning");
        },
        get description() {
          return ui(
            "Learn from finished conversations, review the skills it proposes, and choose whether people may share theirs.",
          );
        },
        icon: IconFileText,
        linkOptions: { to: "/admin/learning" },
      },
      {
        get title() {
          return ui("Check-ins");
        },
        get description() {
          return ui(
            "Turn check-ins on or off, limit them, and see how often people start what Bots raise.",
          );
        },
        icon: IconRadar,
        linkOptions: { to: "/admin/proactive" },
      },
      {
        get title() {
          return ui("UI components");
        },
        get description() {
          return ui(
            "Manage custom components that Bots can display in conversations.",
          );
        },
        icon: IconLayoutGrid,
        linkOptions: { to: "/admin/components" },
      },
      {
        get title() {
          return ui("Playground");
        },
        get description() {
          return ui("Write a component and watch it render as you type.");
        },
        icon: IconCode,
        linkOptions: { to: "/admin/playground" },
      },
    ],
  },
  {
    get title() {
      return ui("Who can get in");
    },
    description: "",
    items: [
      {
        get title() {
          return ui("People");
        },
        get description() {
          return ui("Review members, manage admin roles, and remove access.");
        },
        icon: IconUsers,
        linkOptions: { to: "/admin/people" },
      },
      {
        get title() {
          return ui("Permissions");
        },
        get description() {
          return ui(
            "Choose what people may do with Bots, for everybody and per role or group.",
          );
        },
        icon: IconLockAccess,
        linkOptions: { to: "/admin/permissions" },
      },
      {
        get title() {
          return ui("Identity providers");
        },
        get description() {
          return ui(
            "Configure your company’s sign-in provider for each email domain, and require SSO.",
          );
        },
        icon: IconBuildingBank,
        linkOptions: { to: "/admin/identity-providers" },
      },
    ],
  },
  {
    get title() {
      return ui("What happened");
    },
    description: "",
    items: [
      {
        get title() {
          return ui("Audit");
        },
        get description() {
          return ui(
            "Review actions taken in OpenBot and who took them, and record Bots' commands.",
          );
        },
        icon: IconListDetails,
        linkOptions: { to: "/admin/audit" },
      },
      {
        get title() {
          return ui("What would happen");
        },
        get description() {
          return ui(
            "Ask what OpenBot would do if a Bot took an action, and see which control decides.",
          );
        },
        icon: IconZoomQuestion,
        linkOptions: { to: "/admin/what-if" },
      },
    ],
  },
];

function RouteComponent() {
  useLocale();
  return (
    <PageShell
      description={ui(
        "Manage settings that apply to everyone and every Bot in this deployment.",
      )}
      title={ui("Admin")}
    >
      {SECTIONS.map((section) => (
        <PageSection
          description={section.description || undefined}
          key={section.title}
          title={section.title}
        >
          <PageRows>
            {section.items.map((item, index) => (
              <StaggerItem index={index} key={item.title}>
                {/*
                 * The whole row is the link, not a chevron somebody has to aim at: every row here
                 * goes exactly one place, so there is nothing else the row could mean.
                 */}
                <Item
                  render={(props) => <Link {...item.linkOptions} {...props} />}
                  size="sm"
                >
                  <ItemMedia variant="icon">
                    <item.icon />
                  </ItemMedia>
                  <ItemContent>
                    <ItemTitle>{item.title}</ItemTitle>
                    <ItemDescription>{item.description}</ItemDescription>
                  </ItemContent>
                  <IconChevronRight className="size-4 shrink-0 text-muted-foreground" />
                </Item>
                {index !== section.items.length - 1 && <Separator />}
              </StaggerItem>
            ))}
          </PageRows>
        </PageSection>
      ))}
    </PageShell>
  );
}
