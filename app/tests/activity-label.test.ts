import { expect, test } from "bun:test";
import { settingsSidebarItems } from "@/components/settings/settings-sidebar";
import { managePaths } from "@/lib/manage-paths";

test("pages that send a person to the trail call it what the trail is called", () => {
  expect(managePaths("personal").auditLabel).toBe("Activity");
  expect(
    settingsSidebarItems("personal").some(
      (item) => item.title === managePaths("personal").auditLabel,
    ),
  ).toBe(true);
});
