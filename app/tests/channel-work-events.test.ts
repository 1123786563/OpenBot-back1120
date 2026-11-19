import { expect, test } from "bun:test";
import type { AgentChannel, ChannelWork } from "@/lib/channels/queries";
import { applyChannelWork } from "@/lib/channels/use-channel-events";

const work: ChannelWork = {
  kind: "handoff",
  key: "hop-1",
  botId: "ana",
  botName: "Ana",
  since: "2026-10-26T10:00:00.000Z",
};

test("an event with no list leaves the conversation's list alone", () => {
  const channel: AgentChannel = {
    id: "channel-1",
    name: "Assistant",
    agentIds: [],
    threadId: "thread-1",
    active: true,
    lastMessageAt: null,
    work: [work],
  };

  expect(
    applyChannelWork(channel, {
      channelId: "channel-1",
      lastMessage: null,
      lastMessageAt: null,
      lastMessageAgentId: null,
      busy: true,
    }),
  ).toBe(channel);
  // And the same list again changes nothing either, so nothing re-renders.
  expect(
    applyChannelWork(channel, {
      channelId: "channel-1",
      lastMessage: null,
      lastMessageAt: null,
      lastMessageAgentId: null,
      work: [work],
    }),
  ).toBe(channel);
});
