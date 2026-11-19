import { describe, expect, test } from "bun:test";
import { channelHistoryNotice } from "@/components/channels/channel-chat";

describe("channel history notice", () => {
  test("failed history retrieval does not claim the CopilotKit project changed", () => {
    const notice = channelHistoryNotice({
      restoring: false,
      messageCount: 0,
      lastMessageAt: "2026-09-08T12:00:00.000Z",
      historyAvailability: "unavailable",
      unreadable: 0,
    });

    expect(notice).toContain("Couldn't load earlier messages");
    expect(notice).not.toContain("different CopilotKit project");
    expect(notice).not.toContain("fresh history");
  });

  test("unreadable empty history reports holes without project-change wording", () => {
    const notice = channelHistoryNotice({
      restoring: false,
      messageCount: 0,
      lastMessageAt: "2026-09-08T12:00:00.000Z",
      historyAvailability: "ready",
      unreadable: 1,
    });

    expect(notice).toContain("One earlier message couldn't be read");
    expect(notice).not.toContain("different CopilotKit project");
  });

  test("a malformed successful history response keeps the unavailable notice visible", () => {
    const notice = channelHistoryNotice({
      restoring: false,
      messageCount: 0,
      lastMessageAt: "2026-09-08T12:00:00.000Z",
      historyAvailability: "unavailable",
      historyReadFailed: true,
      unreadable: 0,
    });

    expect(notice).toContain("Couldn't load earlier messages");
    expect(notice).not.toContain("different CopilotKit project");
  });

  test("valid empty history in a used channel has no project-change notice", () => {
    expect(
      channelHistoryNotice({
        restoring: false,
        messageCount: 0,
        lastMessageAt: "2026-09-08T12:00:00.000Z",
        historyAvailability: "ready",
        unreadable: 0,
      }),
    ).toBeNull();
  });
  test("a failed history read remains visible over an existing transcript", () => {
    expect(
      channelHistoryNotice({
        restoring: false,
        messageCount: 3,
        lastMessageAt: null,
        historyAvailability: "unavailable",
        unreadable: 1,
        historyReadFailed: true,
      }),
    ).toContain("Couldn't load earlier messages");
  });
});
