import { type Browser, test } from "@e2e-dev/web";
import { expect } from "e2e";
import {
  CAPABILITY_LABELS,
  type CapabilityRow,
  DEFAULT_CAPABILITIES,
} from "../../server/src/admin/capabilities";
import {
  applyCapabilityChanges,
  type CapabilityChange,
  changesWarning,
  checkCapabilityChanges,
  type PreviewMember,
  previewCapabilityChanges,
} from "../../server/src/admin/capability-changes";
import type { AuditEvent, AuditReader } from "../../server/src/audit";
import recorded from "../../server/tests/fixtures/who-can-recorded.json";

const person = (
  key: string,
  name: string,
  groups: string[],
  role: "admin" | "user" = "user",
): PreviewMember => ({
  id: `user-${key}`,
  email: `${key}@acme.test`,
  name,
  groups,
  role,
});
const PEOPLE = [
  person("ada", "Ada Admin", [], "admin"),
  person("cam", "Cam Contractor", ["Contractors"]),
  person("cy", "Cy Contractor", ["Contractors", "Engineering"]),
  person("eve", "Eve Engineer", ["Engineering"]),
  person("lee", "Lee Field", ["Field Sales (EMEA)"]),
  person("nora", "Nora Nogroup", []),
  person("sam", "Sam Sales", ["Sales"]),
];
const GROUPS = ["Contractors", "Engineering", "Field Sales (EMEA)", "Sales"];

/** Cam's own computer, used once this month: what the trail's reader answers for them. */
const CAM_ROW: AuditEvent = {
  id: "audit-cam-1",
  actorUserId: "user-cam",
  initiatorKind: "person",
  initiatorId: null,
  eventType: "computer.action_allowed",
  targetType: "host_access",
  targetId: "grant-projects",
  payload: {
    action: "host/run_command",
    bot: "bot-research",
    actor: "user-cam",
    folder: "Projects",
    command: "ls -la",
  },
  createdAt: "2026-11-08T15:04:05.000Z",
};
const reader: AuditReader = {
  list: async (query) => ({
    events:
      query.actorUserId === "user-cam" && query.targetType === "host_access"
        ? [CAM_ROW]
        : [],
  }),
};

const TEXT = recorded.trap.text;
const reading = JSON.parse(recorded.trap.reader);

/** What the translate route answers for the recording: the writer's changes, checked, and the reading. */
const SETTING = { on: true, off: false, inherit: null } as const;
const WRITTEN: CapabilityChange[] = (
  JSON.parse(recorded.trap.writer[0] as string) as {
    changes: (Omit<CapabilityChange, "allowed"> & {
      setting: keyof typeof SETTING;
    })[];
  }
).changes.map(({ setting, ...change }) => ({
  ...change,
  allowed: SETTING[setting],
}));
const TRANSLATION = {
  changes: WRITTEN,
  summary: reading.summary,
  explanation: reading.explanation,
  check: checkCapabilityChanges(WRITTEN, GROUPS),
  warning: changesWarning(applyCapabilityChanges([], WRITTEN), WRITTEN, GROUPS),
};

const permissions = "/admin/permissions";
const losesThree =
  "3 people lose access and 4 people keep it through a different switch.";
const losesFour =
  "4 people lose access and 3 people keep it through a different switch.";
const removedNotice =
  "You've removed a change since they were written. The check and the reading above are for the written changes, not your edit.";
const expectedChanges = [
  {
    scopeKind: "organization",
    scopeId: "",
    capability: "localComputer",
    allowed: false,
  },
  {
    scopeKind: "group",
    scopeId: "Engineering",
    capability: "localComputer",
    allowed: true,
  },
  {
    scopeKind: "group",
    scopeId: "Field Sales (EMEA)",
    capability: "localComputer",
    allowed: true,
  },
  {
    scopeKind: "group",
    scopeId: "Sales",
    capability: "localComputer",
    allowed: true,
  },
] satisfies CapabilityChange[];

async function servePermissions(browser: Browser) {
  let rows: CapabilityRow[] = [];
  const translates: unknown[] = [];
  const previews: unknown[] = [];
  const writes: unknown[] = [];
  await browser.route(/\/api\/admin\/enterprise$/, (route) => {
    const local = rows.filter(
      ({ capability }) => capability === "localComputer",
    );
    return route.fulfill({
      json: {
        settings: {},
        capabilities: [
          {
            capability: "localComputer",
            ...CAPABILITY_LABELS.localComputer,
            default: DEFAULT_CAPABILITIES.localComputer,
            organization:
              local.find(({ scopeKind }) => scopeKind === "organization")
                ?.allowed ?? null,
            roles: {},
            groups: Object.fromEntries(
              local
                .filter(({ scopeKind }) => scopeKind === "group")
                .map(({ scopeId, allowed }) => [scopeId, allowed]),
            ),
          },
        ],
        groups: GROUPS,
      },
    });
  });
  await browser.route(/\/api\/agents(?:\?|$)/, (route) =>
    route.fulfill({
      json: { agents: [{ id: "bot-research", name: "Research" }] },
    }),
  );
  await browser.route(
    /\/api\/admin\/enterprise\/capabilities\/translate$/,
    (route) => {
      translates.push({
        method: route.request.method,
        body: JSON.parse(route.request.postData ?? "null"),
      });
      return route.fulfill({ json: TRANSLATION });
    },
  );
  await browser.route(
    /\/api\/admin\/enterprise\/capabilities\/preview$/,
    async (route) => {
      const body: { changes: CapabilityChange[] } = JSON.parse(
        route.request.postData ?? "null",
      );
      previews.push({ method: route.request.method, body });
      const result = await previewCapabilityChanges({
        changes: body.changes,
        rows,
        members: PEOPLE,
        groups: GROUPS,
        reader,
        now: new Date("2026-11-09T12:00:00.000Z"),
      });
      return route.fulfill({
        contentType: "application/json",
        body: JSON.stringify(result),
      });
    },
  );
  await browser.route(
    /\/api\/admin\/enterprise\/capabilities\/batch$/,
    (route) => {
      const body: { changes: CapabilityChange[] } = JSON.parse(
        route.request.postData ?? "null",
      );
      writes.push({ method: route.request.method, body });
      rows = applyCapabilityChanges(rows, body.changes);
      return route.fulfill({ json: { saved: body.changes } });
    },
  );
  return { translates, previews, writes };
}

test("describing permissions previews individual impact and saves changes only after confirmation", async ({
  app,
  browser,
  screen,
}) => {
  const { translates, previews, writes } = await servePermissions(browser);
  await app.open(permissions);
  const local = screen.getByRole("switch", "Local computer access", {
    exact: true,
  });
  await expect(local).toHaveAttribute("aria-checked", "true");
  await screen.getByRole("link", /^Describe it in words/).click();
  await expect(browser).toHaveURL(`${permissions}/describe`);

  const save = screen.getByRole("button", "Save changes", { exact: true });
  await expect(save).toBeDisabled();
  await screen.getByLabel("Describe the change", { exact: true }).fill(TEXT);
  await screen.getByRole("button", "Write changes", { exact: true }).click();

  for (const text of [
    reading.explanation,
    "Checks. Every change names a permission, role or group this OpenBot has.",
    "Everybody",
    "Off",
    "Group: Field Sales (EMEA)",
    losesThree,
    "Cam Contractor",
    "Member in Contractors",
    "Admin, in no group",
    "1 in the last 30 days: actions on their own computer.",
    "Would be blocked",
    "Cam Contractor, Local computer access",
  ]) {
    await expect(screen.getByText(text, { exact: true })).toBeVisible();
  }
  for (const { text, count, exact } of [
    { text: "Local computer access", count: 4, exact: true },
    { text: "Grant", count: 3, exact: true },
    { text: "Loses access", count: 3, exact: true },
    { text: "Keeps access", count: 4, exact: true },
    {
      text: "Now on by default. After this, off for everybody.",
      count: 3,
      exact: false,
    },
    {
      text: "Now on by default. After this, on through Engineering.",
      count: 2,
      exact: false,
    },
    { text: "Not used in the last 30 days.", count: 2, exact: true },
  ]) {
    await expect(screen.getByText(text, { exact })).toHaveCount(count);
  }
  expect(translates).toEqual([{ method: "POST", body: { text: TEXT } }]);
  expect(previews).toEqual([
    { method: "POST", body: { changes: expectedChanges } },
  ]);
  expect(writes).toEqual([]);

  await expect(save).toBeEnabled();
  await save.click();
  await expect(browser).toHaveURL(permissions);
  expect(writes).toEqual([
    {
      method: "POST",
      body: {
        changes: expectedChanges,
        authoring: { source: "english", text: TEXT },
      },
    },
  ]);
  const overrides = screen.getByRole(
    "button",
    /^Role and group overrides.*3 set/,
  );
  const dialog = screen.getByRole("dialog", "Role and group overrides");
  const scope = dialog.getByRole("combobox", "Scope", { exact: true });
  for (const group of ["Engineering", "Field Sales (EMEA)", "Sales"]) {
    await browser.reload();
    await expect(local).toHaveAttribute("aria-checked", "false");
    await overrides.click();
    await scope.click();
    const name = `Group: ${group}`;
    await screen.getByRole("option", name, { exact: true }).click();
    const access = dialog.getByRole(
      "combobox",
      `Local computer access for ${name}`,
      { exact: true },
    );
    await access.click();
    await expect(
      screen.getByRole("option", "Grant", { exact: true }),
    ).toHaveAttribute("aria-selected", "true");
  }
});

test("removing a generated permission change previews only the remaining switches", async ({
  app,
  browser,
  screen,
}) => {
  const { previews, writes } = await servePermissions(browser);
  await app.open(`${permissions}/describe`);
  await screen.getByLabel("Describe the change", { exact: true }).fill(TEXT);
  await screen.getByRole("button", "Write changes", { exact: true }).click();
  await expect(screen.getByText(losesThree, { exact: true })).toBeVisible();
  const notice = screen.getByText(removedNotice, { exact: true });
  await expect(notice).toHaveCount(0);

  await screen.getByRole("button", "Remove change 4", { exact: true }).click();
  await expect(notice).toBeVisible();
  await expect(screen.getByText(losesFour, { exact: true })).toBeVisible();
  await expect(screen.getByText("Loses access", { exact: true })).toHaveCount(
    4,
  );
  await expect(screen.getByText("Keeps access", { exact: true })).toHaveCount(
    3,
  );
  expect(previews).toEqual([
    { method: "POST", body: { changes: expectedChanges } },
    { method: "POST", body: { changes: expectedChanges.slice(0, 3) } },
  ]);
  expect(writes).toEqual([]);
});
