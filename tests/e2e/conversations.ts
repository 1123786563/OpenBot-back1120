import type { Browser } from "@e2e-dev/web";

export async function createConversation(
  browser: Browser,
  agent: string | string[],
  title?: string,
) {
  return browser.evaluate(
    async ({ agentIds, title }) => {
      const response = await fetch("/api/channels", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ agentIds }),
      });
      if (!response.ok) {
        throw new Error(
          `Cannot create the test conversation: ${response.status}`,
        );
      }
      const data: { channel: { id: string } } = await response.json();
      const { id } = data.channel;
      if (title) {
        const renamed = await fetch(
          `/api/channels/${encodeURIComponent(id)}/title`,
          {
            method: "PUT",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ title }),
          },
        );
        if (!renamed.ok) {
          throw new Error(
            `Cannot name the test conversation: ${renamed.status}`,
          );
        }
      }
      return id;
    },
    {
      agentIds: typeof agent === "string" ? [agent] : agent,
      title: title ?? null,
    },
  );
}

export async function readThreadId(browser: Browser, channelId: string) {
  return browser.evaluate(async (id) => {
    const response = await fetch(`/api/channels/${encodeURIComponent(id)}`);
    if (!response.ok)
      throw new Error(`Cannot read the conversation: ${response.status}`);
    const data: { channel: { threadId: string } } = await response.json();
    return data.channel.threadId;
  }, channelId);
}
