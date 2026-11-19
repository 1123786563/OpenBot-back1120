import { expect, test } from "bun:test";
import { chipText, withFilters } from "@/components/audit/audit-filters";
import { withBot } from "@/components/manage/audit-page";
import {
  COMPUTER_ACTION_EVENT_TYPES,
  DID_NOT_HAPPEN_EVENT_TYPES,
  eventTypeFilter,
  REFUSED_EVENT_TYPES,
} from "@/lib/audit/outcome";

test("chips narrow a saved view, and two sets with nothing in common ask for a value no row has", () => {
  const blocked = eventTypeFilter(REFUSED_EVENT_TYPES);
  const narrowed = new URLSearchParams(
    withFilters(blocked, {
      eventType: ["mcp.call_succeeded", "mcp.call_rejected"],
      app: ["gmail"],
    }),
  );
  expect(narrowed.get("eventType")).toBe("mcp.call_rejected");
  expect(narrowed.get("app")).toBe("gmail");

  expect(
    new URLSearchParams(
      withFilters(blocked, { eventType: ["mcp.call_succeeded"] }),
    ).get("eventType"),
  ).toBe("none");
  expect(
    new URLSearchParams(withFilters("?bot=inbox", { bot: "research" })).get(
      "bot",
    ),
  ).toBe("none");
  // No chips, no change: every saved view keeps the query it always had.
  expect(withFilters(blocked, {})).toBe(blocked);
  expect(withFilters("", {})).toBe("");
});

test("Outcome and several Bots are asked of the server, as the views and the Bot filter ask them", () => {
  const blocked = new URLSearchParams(
    withFilters("", { outcome: ["refused"] }),
  );
  expect(blocked.get("eventType")).toBe(REFUSED_EVENT_TYPES.join(","));
  // Allowed is everything that is neither blocked nor didn't happen.
  const allowed = new URLSearchParams(
    withFilters("", { outcome: ["allowed", "refused"] }),
  );
  expect(allowed.get("eventType")).toBeNull();
  expect(allowed.get("excludeEventType")).toBe(
    DID_NOT_HAPPEN_EVENT_TYPES.join(","),
  );
  // All three is no filter at all.
  expect(
    withFilters("", { outcome: ["allowed", "refused", "did-not-happen"] }),
  ).toBe("");
  expect(
    new URLSearchParams(withFilters("", { bot: "inbox,research" })).get("bot"),
  ).toBe("inbox,research");
});

/*
 * FOUND IN THE COMBINED STACK'S REVIEW: "What did the social media rule block today?" drew the chip
 * "Type: Use the computer, blocked", the words a single row says for itself, where the Audit page's
 * views say "Computer actions".
 */
test("a type chip names its rows in the words of the Audit page's views", () => {
  const filters = {
    eventType: ["computer.action_refused"],
    rule: 'intent == "navigate" && contains(page.host, "facebook")',
    from: "2026-11-09T08:00:00.000Z",
    to: "2026-11-09T22:00:00.000Z",
  };
  const names = {
    labels: {
      bots: {},
      people: {},
      apps: {},
      rules: { [filters.rule]: "Bots may not visit social media sites" },
    },
    vocabulary: undefined,
    nameFor: () => "",
  };
  const chip = chipText("eventType", filters, names);
  expect(chip).toBe("Type: Computer actions, blocked");
  expect(chip).not.toContain("Use the computer");
  expect(chip).not.toMatch(/\bBot\b/);
  expect(chipText("rule", filters, names)).toBe(
    "Rule: Bots may not visit social media sites",
  );
});

test("the Blocked view asks for the denied write, and Computer actions for every outcome", () => {
  expect(eventTypeFilter(REFUSED_EVENT_TYPES)).toContain(
    "computer.action_refused",
  );
  expect(eventTypeFilter(COMPUTER_ACTION_EVENT_TYPES)).toBe(
    "?eventType=computer.action_allowed,computer.action_refused,computer.action_failed,computer.action_stopped",
  );
});

test("a Bot filter narrows a saved audit view", () => {
  expect(withBot("", "bot-claude")).toBe("?bot=bot-claude");
  expect(
    withBot(
      "?eventType=computer.action_refused,mcp.call_rejected",
      "bot-claude",
    ),
  ).toBe(
    "?eventType=computer.action_refused%2Cmcp.call_rejected&bot=bot-claude",
  );
});
