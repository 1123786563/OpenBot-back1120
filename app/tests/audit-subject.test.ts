import { expect, test } from "bun:test";
import {
  type AuditEvent,
  botText,
  subjectText,
} from "@/components/audit/audit-cells";

test("a row about a Bot names it under Bot, not under On", () => {
  const routed = {
    id: "e4",
    actorUserId: null,
    initiatorKind: "person",
    initiatorId: null,
    eventType: "channel.routed",
    createdAt: "2026-10-27T11:00:00Z",
    targetType: "agent",
    targetId: "general-assistant",
    payload: {
      chosen: "general-assistant",
      reason: "named by the person asking",
    },
  } satisfies AuditEvent;
  const nameFor = (id: string) =>
    id === "general-assistant" ? "General Assistant" : id;
  expect(botText(routed, nameFor)).toBe("General Assistant");
  expect(subjectText(routed)).toBe("");
});
