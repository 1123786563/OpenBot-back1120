import { test } from "@e2e-dev/web";
import { expect } from "e2e";
import { DECLINED_BY_PERSON } from "../../shared/approval-outcomes";

const BOT = "bot-claude";
const policy = {
  allowed: true,
  mode: "enforce",
  source: "allow",
  rule: "true",
  carriedOut: true,
};
const asked = {
  behaviour: "ask",
  source: "default",
  reason: "You asked to review changes before they happen.",
};

let clock = 0;
function row(
  eventType: string,
  targetType: string,
  payload: Record<
    string,
    string | boolean | null | Record<string, string | boolean>
  >,
) {
  clock += 1;
  return {
    id: `e${clock}`,
    actorUserId: "person",
    initiatorKind: "person",
    initiatorId: null,
    eventType,
    targetType,
    targetId: targetType === "approval" ? `approval-${clock}` : BOT,
    payload: { bot: BOT, ...payload },
    createdAt: new Date(Date.UTC(2026, 10, 6, 9, 0, clock)).toISOString(),
  };
}

const file = (path: string) => ({
  action: path.startsWith("missing")
    ? "computer_read_file"
    : "computer_write_file",
  file: path,
  page: "about:blank",
  ref: null,
});

const ROWS = [
  // Denied.
  row("approval.evaluated", "approval", {
    decidedBy: "policy",
    tool: "computer_write_file",
    effect: "write",
    scope: "workspace",
    file: "refused.txt",
    outcome: asked,
  }),
  row("approval.person_decided", "approval", {
    decidedBy: "person",
    decision: "deny",
    tool: "computer_write_file",
    scope: "workspace",
    file: "refused.txt",
  }),
  row("computer.action_refused", "computer", {
    ...file("refused.txt"),
    refusal: "person_declined",
    reason: DECLINED_BY_PERSON,
    decision: { ...policy, carriedOut: false },
  }),
  // Allowed.
  row("approval.evaluated", "approval", {
    decidedBy: "policy",
    tool: "computer_write_file",
    effect: "write",
    scope: "workspace",
    file: "allowed.txt",
    outcome: asked,
  }),
  row("approval.person_decided", "approval", {
    decidedBy: "person",
    decision: "allow_once",
    tool: "computer_write_file",
    scope: "workspace",
    file: "allowed.txt",
  }),
  row("computer.action_allowed", "computer", {
    ...file("allowed.txt"),
    attempt: "attempt-allowed",
    decision: policy,
  }),
  // Failed.
  row("computer.action_allowed", "computer", {
    ...file("missing-report.txt"),
    attempt: "attempt-missing",
    decision: policy,
  }),
  row("computer.action_failed", "computer", {
    ...file("missing-report.txt"),
    attempt: "attempt-missing",
    failure: "missing-report.txt does not exist in the workspace.",
    decision: policy,
  }),
];

test("Activity distinguishes already asked, denied, allowed and failed file actions", async ({
  app,
  browser,
}) => {
  await browser.route(/\/api\/admin\/audit-events(?:\?|$)/, (route) =>
    route.fulfill({ json: { events: ROWS } }),
  );
  await app.open("/settings/activity");
  await expect(browser.locator("tbody tr")).toHaveCount(7);
  const entries = await browser.evaluate(() =>
    Array.from(document.querySelectorAll("tbody tr"), (row) => {
      const [what = "", ...on] = Array.from(
        row.querySelectorAll('[data-column="what"] > div'),
        (line) => line.textContent ?? "",
      );
      return {
        what,
        on: on.join(""),
        decision:
          row.querySelector('[data-column="decision"]')?.textContent ?? "",
        outcome: row.getAttribute("data-outcome"),
      };
    }),
  );
  const askedFirst =
    "Asked a person firstYou asked to review changes before they happen.";
  expect(entries.filter(({ on }) => on === "refused.txt")).toEqual([
    {
      what: "Save a file",
      on: "refused.txt",
      decision: "BlockedA person denied it when asked.",
      outcome: "refused",
    },
    {
      what: "Save a file",
      on: "refused.txt",
      decision: "Denied by a person",
      outcome: "refused",
    },
    {
      what: "Save a file",
      on: "refused.txt",
      decision: askedFirst,
      outcome: "allowed",
    },
  ]);
  expect(
    entries
      .filter(({ on }) => on === "allowed.txt")
      .map(({ decision }) => decision),
  ).toEqual(["Allowed", "Allowed once by a person", askedFirst]);
  expect(entries.filter(({ on }) => on === "missing-report.txt")).toEqual([
    {
      what: "Read a file",
      on: "missing-report.txt",
      decision:
        "Did not happenmissing-report.txt does not exist in the workspace.",
      outcome: "did-not-happen",
    },
  ]);
});
