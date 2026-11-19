import { expect, test } from "bun:test";
import { personalAdminRedirect } from "@/lib/manage-paths";
import { NAVIGATION, navigationFor } from "@/lib/navigation";

test("Admin is in the list for admins only", () => {
  const ids = (role: string | undefined) =>
    navigationFor(role).map((item) => item.id);
  expect(ids("admin")).toEqual(NAVIGATION.map((item) => item.id));
  expect(ids("user")).not.toContain("admin");
  expect(ids(undefined)).not.toContain("admin");
  expect(ids("user")).toEqual([
    "bots",
    "routines",
    "capabilities",
    "connections",
    "settings",
  ]);
});

test("the personal edition has no Admin or Capabilities, and a feature list in Admin's place", () => {
  const personal = navigationFor("admin", "personal");
  expect(
    personal.some((item) => item.kind !== "dialog" && item.to === "/admin"),
  ).toBe(false);
  const dialogs = personal.filter((item) => item.kind === "dialog");
  expect(dialogs.map((item) => item.id)).toEqual(["team-features"]);
  // Skills and Memory open from the Bots page instead.
  expect(personal.map((item) => item.id)).toEqual([
    "bots",
    "routines",
    "connections",
    "team-features",
    "settings",
  ]);
  // The team edition is unchanged.
  expect(navigationFor("admin")).toEqual(navigationFor("admin", "team"));
  expect(navigationFor("admin").map((item) => item.id)).toContain("admin");
});

test.each([
  ["/admin/plugins", "/connections"],
  ["/admin/plugins/notion", "/connections/notion"],
  ["/admin/plugins/notion/tools/search", "/connections/notion/tools/search"],
  ["/admin/plugins/notion/bots/bot-1", "/connections/notion/bots/bot-1"],
  ["/admin/plugins/composio", "/connections/browse/composio"],
  ["/admin/skills", "/settings/skills"],
  ["/admin/credentials", "/settings/credentials"],
  ["/admin/credentials/new", "/settings/credentials/new"],
  ["/admin/computers", "/settings/computer"],
  ["/admin/audit", "/settings/activity"],
  ["/admin/people", "/settings"],
  ["/admin/enterprise", "/settings"],
  ["/admin", "/settings"],
  ["/admin/", "/settings"],
])("the personal Admin redirect maps %s to %s", (from, to) => {
  expect(personalAdminRedirect(from)).toBe(to);
});
