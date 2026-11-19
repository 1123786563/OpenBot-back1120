import { describe, expect, test } from "bun:test";
import type { AgentProfile } from "@/lib/agents/queries";
import type { ChannelSummary } from "@/lib/channels/queries";
import {
  centreBot,
  mainChannel,
  statusLine,
  tabFor,
} from "@/skins/openmuse/model";

const earlier = "2026-11-19T07:00:00.000Z";

function agent(
  overrides: Partial<AgentProfile> & { id: string },
): AgentProfile {
  return {
    avatarSeed: overrides.id,
    builtIn: true,
    canManage: true,
    endpoint: null,
    hasAuth: false,
    hasCallbackToken: false,
    hidden: false,
    pinned: false,
    mine: true,
    name: overrides.id,
    roleDescription: "",
    systemOwned: false,
    title: "",
    visibility: "private",
    isolated: false,
    isolationActive: false,
    isolationOffReason: null,
    ...overrides,
  };
}

function channel(
  overrides: Partial<ChannelSummary> & { id: string; agentIds: string[] },
): ChannelSummary {
  return {
    name: "Conversation",
    threadId: `thread-${overrides.id}`,
    active: true,
    lastMessageAt: earlier,
    summary: null,
    lastMessage: null,
    lastMessageAgentId: null,
    createdAt: earlier,
    pinned: false,
    lastReadAt: earlier,
    ...overrides,
  };
}

const scout = agent({ id: "scout", name: "Scout", title: "Research" });
// OpenBot's default Bot: `defaultAgentProfile` prefers the picked harness over list order.
const muse = agent({
  id: "picked-harness",
  name: "Muse",
  title: "Your helper",
});

const channels = [
  channel({
    id: "c-muse",
    agentIds: [muse.id],
    name: "Muse",
    summary: "Planning the week",
  }),
  channel({
    id: "c-scout",
    agentIds: [scout.id],
    name: "Scout",
    summary: "Competitor notes",
    busy: true,
  }),
  channel({
    id: "g-team",
    agentIds: [muse.id, scout.id],
    name: "Team",
    summary: "Launch plan",
  }),
];

describe("the rules the frame runs on", () => {
  test("the centre follows the conversation, then the choice, then OpenBot's default", () => {
    const agents = [scout, muse];
    expect(centreBot(agents, null, undefined)?.id).toBe(muse.id);
    expect(centreBot(agents, scout.id, undefined)?.id).toBe(scout.id);
    expect(centreBot(agents, muse.id, scout.id)?.id).toBe(scout.id);
    expect(centreBot(agents, "deleted-bot", undefined)?.id).toBe(muse.id);
    expect(centreBot([], null, undefined)).toBeUndefined();
  });

  test("a group is never a Bot's main chat", () => {
    expect(mainChannel(muse.id, channels)?.id).toBe("c-muse");
    expect(mainChannel("nobody", channels)).toBeUndefined();
    expect(
      mainChannel(
        muse.id,
        channels.filter((row) => row.id !== "c-muse"),
      ),
    ).toBeUndefined();
  });

  test("only a tab's own screen lights that tab", () => {
    expect(tabFor("/")).toBe("chat");
    expect(tabFor("/channel/new")).toBe("chat");
    expect(tabFor("/group/g-team")).toBe("chat");
    expect(tabFor("/s/activity")).toBe("activity");
    expect(tabFor("/s/ideas")).toBe("ideas");
    expect(tabFor("/s/goals")).toBe("goals");
    expect(tabFor("/connections")).toBe("apps");
    expect(tabFor("/connections/notion")).toBe("apps");
    expect(tabFor("/routines")).toBeNull();
    expect(tabFor("/settings/approvals")).toBeNull();
    expect(tabFor("/bots/scout/setup")).toBeNull();
    expect(tabFor("/capabilities/skills")).toBeNull();
    expect(tabFor("/s/apps")).toBeNull();
  });

  test("something waiting on the person outranks work in progress", () => {
    const busy = [
      channel({ id: "x", agentIds: ["b"], busy: true, summary: "Report" }),
    ];
    const base = {
      agentId: "b",
      name: "B",
      questions: 0,
      approvals: 0,
      handoffs: 0,
      unread: 0,
      paused: false,
      notify: "all" as const,
      items: 0,
      tasks: { needsInput: 0, ready: 0, failed: 0 },
    };
    expect(
      statusLine({ attention: undefined, channels: busy, agentId: "b" }),
    ).toBe("Working on Report…");
    expect(
      statusLine({
        attention: { ...base, questions: 2 },
        channels: busy,
        agentId: "b",
      }),
    ).toBe("Needs your input · 2 questions");
    expect(
      statusLine({
        attention: { ...base, approvals: 1 },
        channels: busy,
        agentId: "b",
      }),
    ).toBe("Ready to review · 1 approval");
    expect(
      statusLine({
        attention: { ...base, paused: true },
        channels: [],
        agentId: "b",
      }),
    ).toBe("Paused");
    expect(statusLine({ attention: base, channels: [], agentId: "b" })).toBe(
      "Ready when you are",
    );
  });
});
