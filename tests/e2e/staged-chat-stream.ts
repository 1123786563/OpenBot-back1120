import type { Browser } from "@e2e-dev/web";
import { chatRunPath, readChatRun } from "./chat-stream";

type ChatRun = ReturnType<typeof readChatRun>;

export async function stageChatRun(
  browser: Browser,
  first: (run: ChatRun) => object[],
  final: (run: ChatRun) => object[],
  path = chatRunPath,
) {
  const finish = Promise.withResolvers<void>();
  const encoder = new TextEncoder();
  const stub = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    idleTimeout: 0,
    async fetch(request) {
      const run = readChatRun(await request.text());
      const stream = new ReadableStream<Uint8Array>({
        start(controller) {
          const send = (events: object[]) => {
            for (const event of events) {
              controller.enqueue(
                encoder.encode(`data: ${JSON.stringify(event)}\n\n`),
              );
            }
          };
          send(first(run));
          void finish.promise
            .then(() => {
              send(final(run));
              controller.close();
            })
            .catch(() => {
              // Chromium can cancel the request when a failed assertion closes the page.
            });
        },
      });
      return new Response(stream, {
        headers: {
          "content-type": "text/event-stream",
          "access-control-allow-origin": "*",
        },
      });
    },
  });
  try {
    await browser.route(path, (route) =>
      route.continue({
        url: stub.url.href,
        headers: { "content-type": "application/json" },
      }),
    );
  } catch (error) {
    stub.stop(true);
    throw error;
  }
  return {
    finish: () => finish.resolve(),
    [Symbol.dispose]() {
      finish.resolve();
      stub.stop(true);
    },
  };
}
