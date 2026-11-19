import type { Browser } from "@e2e-dev/web";

export function readChatRun(postData: string | undefined) {
  const input: unknown = JSON.parse(postData ?? "null");
  if (
    typeof input !== "object" ||
    input === null ||
    !("threadId" in input) ||
    typeof input.threadId !== "string" ||
    !("runId" in input) ||
    typeof input.runId !== "string" ||
    !("messages" in input) ||
    !Array.isArray(input.messages)
  ) {
    throw new Error("The chat sent an invalid run request");
  }
  const messages: unknown[] = input.messages;
  return { runId: input.runId, threadId: input.threadId, messages };
}

export const chatRunPath = /\/api\/copilotkit\/agent\/[^/]+\/run$/;

export async function configureChatStream(
  browser: Browser,
  opening?: string | readonly object[] | (() => readonly object[]),
  readArchive?: () => Promise<readonly object[]>,
  openingOutcome?: { type: "interrupt"; interrupts: readonly object[] },
) {
  if (readArchive || (opening !== undefined && typeof opening !== "string")) {
    await browser.route(
      /\/api\/copilotkit\/threads\/[^/]+\/messages\?/,
      async (route) =>
        route.fulfill({
          contentType: "application/json",
          body: JSON.stringify({ messages: (await readArchive?.()) ?? [] }),
        }),
    );
  }
  await browser.route(/\/api\/copilotkit\/info$/, async (route) => {
    const response = await route.fetch();
    const info = await response.json<Record<string, unknown>>();
    await route.fulfill({ json: { ...info, mode: "sse" } });
  });
  await browser.route(
    /\/api\/copilotkit\/agent\/[^/]+\/connect$/,
    async (route) => {
      const { threadId } = readChatRun(route.request.postData ?? undefined);
      const events = [
        { type: "RUN_STARTED", threadId, runId: "opening" },
        {
          type: "MESSAGES_SNAPSHOT",
          messages:
            typeof opening === "string"
              ? opening
                ? [{ id: "opening", role: "assistant", content: opening }]
                : []
              : typeof opening === "function"
                ? opening()
                : (opening ?? []),
        },
        {
          type: "RUN_FINISHED",
          threadId,
          runId: "opening",
          ...(openingOutcome ? { outcome: openingOutcome } : {}),
        },
      ];
      await route.fulfill({
        status: 200,
        contentType: "text/event-stream",
        body: events
          .map((event) => `data: ${JSON.stringify(event)}\n\n`)
          .join(""),
      });
    },
  );
}

export const chatEventStream = (events: readonly object[]) => ({
  contentType: "text/event-stream",
  body: events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join(""),
});
