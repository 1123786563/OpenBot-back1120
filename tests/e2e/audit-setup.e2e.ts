import { test } from "@e2e-dev/web";
import { expect } from "e2e";
import { readAuditRows } from "./audit-rows";
import { createBot } from "./signed-in";

const personal = process.env.OPENBOT_E2E_SUITE === "personal";
const BOT = "fixture-bot";

function row(
  id: string,
  minute: number,
  fields: {
    eventType: string;
    targetType: string;
    targetId?: string | null;
    initiatorKind?: string;
    payload: Record<string, unknown>;
  },
) {
  return {
    id,
    actorUserId: "dev-local-user",
    initiatorKind: "person",
    initiatorId: null,
    targetId: null,
    ...fields,
    createdAt: `2026-11-07T19:${String(minute).padStart(2, "0")}:00Z`,
  };
}

/** OpenBot's own working, as the server records it: what Activity no longer asks for. */
const ROUTED = row("routed", 30, {
  eventType: "channel.routed",
  targetType: "agent",
  targetId: BOT,
  payload: {
    chosen: BOT,
    reason: "fallback: one-candidate",
    fallback: true,
    undecided: "one-candidate",
  },
});
const PUBLISHED = row("published", 20, {
  eventType: "component.published",
  targetType: "component",
  targetId: "showTable",
  initiatorKind: "deployment",
  payload: {
    note: "First seen in a build, published and available to every Bot.",
  },
});
const BOUNDARY = row("boundary", 10, {
  eventType: "computer.policy_loaded",
  targetType: "policy",
  initiatorKind: "deployment",
  payload: { allow: ["true"], deny: [], mode: "enforce" },
});

/** Rows a person keeps, each recorded with an id where a person reads words. */
const KEPT = [
  row("refused", 29, {
    eventType: "component.function_refused",
    targetType: "component",
    targetId: "showActivityReport",
    payload: {
      bot: BOT,
      function: "botActivity",
      reason:
        "showActivityReport can't use the function botActivity. An admin has to give it to this component.",
    },
  }),
  row("not-shown", 28, {
    eventType: "component.refused",
    targetType: "component",
    targetId: "showTable",
    payload: {
      bot: BOT,
      reason:
        "Data table has been withheld from this Bot in this deployment, though other Bots may use it. Answer in prose instead.",
    },
  }),
  row("key", 27, {
    eventType: "credential.created",
    targetType: "credential",
    targetId: "9869ac62-2f72-4ffc-b39d-8faf84702828",
    payload: { kind: "model", provider: "Anthropic", keyId: "personal" },
  }),
  row("key-gone", 26, {
    eventType: "credential.revoked",
    targetType: "credential",
    targetId: "9869ac62-2f72-4ffc-b39d-8faf84702828",
    payload: {},
  }),
  row("blocked", 25, {
    eventType: "computer.action_refused",
    targetType: "computer",
    targetId: BOT,
    payload: {
      bot: BOT,
      action: "computer_navigate",
      page: "https://example.com/",
      reason: "Local computer access is off for you.",
      decision: {
        allowed: false,
        mode: "enforce",
        source: "deny",
        rule: "capability:localComputer",
      },
    },
  }),
  row("skill", 9, {
    eventType: "configuration.changed",
    targetType: "skill",
    targetId: "find-a-document",
    initiatorKind: "deployment",
    payload: {
      actor: "openbot:personal-defaults",
      change: "plugin_granted",
      kind: "skill",
      ref: "find-a-document",
      bot: BOT,
    },
  }),
  row("learning", 8, {
    eventType: "configuration.changed",
    targetType: "learning",
    initiatorKind: "deployment",
    payload: {
      change: "default_container_assigned_automatically",
      defaultContainerId: "openbot",
    },
  }),
];

test(`${personal ? "Activity" : "Admin Audit"} displays the appropriate setup and component records`, async (fixtures) => {
  const { app, browser } = fixtures;
  const { id, name } = await createBot(fixtures);
  const source = personal
    ? [ROUTED, ...KEPT, PUBLISHED, BOUNDARY]
    : [ROUTED, ...KEPT.slice(0, 5), PUBLISHED, BOUNDARY];
  const reads: (string | null)[] = [];
  await browser.route(/\/api\/admin\/audit-events(?:\?|$)/, (route) => {
    const exclude = new URL(route.request.url).searchParams.get(
      "excludeEventType",
    );
    reads.push(exclude);
    const events = source
      .filter((row) => !exclude?.split(",").includes(row.eventType))
      .map((row) => ({
        ...row,
        targetId: row.targetId === BOT ? id : row.targetId,
        payload: {
          ...row.payload,
          ...(row.payload.bot === BOT ? { bot: id } : {}),
          ...(row.payload.chosen === BOT ? { chosen: id } : {}),
        },
      }));
    return route.fulfill({
      contentType: "application/json",
      body: JSON.stringify({ events }),
    });
  });
  await app.open(personal ? "/settings/activity" : "/admin/audit");
  await expect(browser.locator("tbody tr[data-outcome]")).toHaveCount(
    personal ? 7 : 8,
  );
  const rows = (await readAuditRows(browser)).map(
    ({ what, who, decision }) => ({ what, who, decision }),
  );
  if (personal) {
    expect(reads).toEqual([
      "mcp.tools_discovered,channel.routed,component.published,component.description_updated,computer.policy_loaded,computer.isolation_loaded",
    ]);
    const person = "Started by a person";
    const openbot = "Started by OpenBot";
    expect(rows).toEqual([
      {
        what: [
          "Read data for a component",
          "Activity report · your Bots' activity",
        ],
        who: [name, person],
        decision: ["Refused", "It isn't allowed to read that data."],
      },
      {
        what: ["Show a component", "Data table"],
        who: [name, person],
        decision: ["Refused", "This Bot can't show it."],
      },
      {
        what: ["Save a credential", "Anthropic · personal"],
        who: ["-", person],
        decision: ["Credential saved"],
      },
      // A removed key's row keeps nothing but its id, which is never shown.
      {
        what: ["Remove a credential"],
        who: ["-", person],
        decision: ["Allowed"],
      },
      {
        what: ["Open a page", "example.com"],
        who: [name, person],
        decision: ["Blocked", "Local computer access is off for you."],
      },
      {
        what: ["Give a Bot a skill", "Find a document"],
        who: [name, openbot],
        decision: ["Configuration changed"],
      },
      {
        what: ["Set up Learning"],
        who: ["-", openbot],
        decision: ["Configuration changed"],
      },
    ]);
    await expect(browser.locator("tbody")).not.toContainText(
      /showActivityReport|botActivity|showTable|An admin|9869ac62|capability:|find-a-document|Change a setting/,
    );
  } else {
    expect(reads).toEqual([null]);
    expect(rows).toEqual([
      {
        what: ["Choose a Bot for a message"],
        who: [name, "Started by a person"],
        decision: ["Sent to the default Bot", "fallback: one-candidate"],
      },
      {
        what: ["Read data for a component", "showActivityReport · botActivity"],
        who: [name, "Started by a person"],
        decision: [
          "Refused",
          "showActivityReport can't use the function botActivity. An admin has to give it to this component.",
        ],
      },
      {
        what: ["Show a component", "showTable"],
        who: [name, "Started by a person"],
        decision: [
          "Refused",
          "Data table has been withheld from this Bot in this deployment, though other Bots may use it. Answer in prose instead.",
        ],
      },
      {
        what: ["Save a credential", "9869ac62-2f72-4ffc-b39d-8faf84702828"],
        who: ["-", "Started by a person"],
        decision: ["Credential saved"],
      },
      {
        what: ["Remove a credential", "9869ac62-2f72-4ffc-b39d-8faf84702828"],
        who: ["-", "Started by a person"],
        decision: ["Allowed"],
      },
      {
        what: ["Open a page", "example.com"],
        who: [name, "Started by a person"],
        decision: [
          "Blocked",
          "Local computer access is off for you.",
          "capability:localComputer",
          // Admin asks the controls about the row: see what-if/why-button.tsx.
          "Why?",
        ],
      },
      {
        what: ["Publish a component", "showTable"],
        who: ["-", "Started by this deployment"],
        decision: ["Published. Every Bot can use it"],
      },
      {
        what: ["Start the computer"],
        who: ["-", "Started by this deployment"],
        decision: ["Boundary at start-up"],
      },
    ]);
  }
});
