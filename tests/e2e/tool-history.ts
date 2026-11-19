import { configureChatStream } from "./chat-stream";
import { createConversation } from "./conversations";
import { createBot } from "./signed-in";

export type ToolHistoryCall = {
  id: string;
  name: string;
  args: object;
  result: string;
};

export function toolHistory(
  question: string,
  calls: readonly ToolHistoryCall[],
) {
  return [
    { id: "fixture-question", role: "user", content: question },
    {
      id: "fixture-call-parent",
      role: "assistant",
      toolCalls: calls.map(({ id, name, args }) => ({
        id,
        type: "function",
        function: { name, arguments: JSON.stringify(args) },
      })),
    },
    ...calls.map(({ id, result }) => ({
      id: `result-${id}`,
      role: "tool",
      toolCallId: id,
      content: result,
    })),
  ];
}

type Fixtures = Parameters<typeof createBot>[0];

export async function openToolHistory(
  fixtures: Fixtures,
  stored: readonly object[],
) {
  const { app, browser, screen } = fixtures;
  const bot = await createBot(fixtures);
  const channel = await createConversation(browser, bot.id);
  await configureChatStream(browser, stored, async () => stored);
  await app.open(`/channel/${channel}`);
  return screen.getByRole("region", "Messages", { exact: true });
}
