import { setEdition } from "../../../server/src/edition";
import { personalPluginRoutes } from "../../../server/tests/support/personal-plugin-routes";

const suite = crypto.randomUUID().slice(0, 8);
const clientId = `notion-client-${suite}`;
const plugin = personalPluginRoutes({ suite, apps: ["notion"] });
setEdition("personal");
Object.defineProperty(globalThis, "fetch", {
  value: async (input: RequestInfo | URL, init?: RequestInit) => {
    const request = new Request(input, init);
    const url = new URL(request.url);
    if (
      url.href !== "https://mcp.notion.com/register" ||
      request.method !== "POST"
    ) {
      return Response.json({ error: "not_found" }, { status: 404 });
    }
    return Response.json(
      {
        ...(await request.json()),
        client_id: clientId,
        token_endpoint_auth_method: "none",
        registration_client_uri: `https://mcp.notion.com/register/${clientId}`,
        client_id_issued_at: 1_778_000_000,
      },
      { status: 201 },
    );
  },
});

await plugin.seed();
try {
  if (process.argv.includes("--previously-enabled"))
    await plugin.addApp("notion");
  const fixture = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(request) {
      const { pathname, search } = new URL(request.url);
      if (pathname === "/bot-tools")
        return Response.json(await plugin.botHolds("notion"));
      if (!pathname.startsWith("/api/plugins/"))
        return new Response(null, { status: 404 });
      return plugin.request(pathname + search, {
        method: request.method,
        headers: request.headers,
        body: request.body ? await request.text() : undefined,
      });
    },
  });
  const stopped = new Promise<void>((resolve) => {
    process.once("SIGTERM", () => resolve());
    process.once("SIGINT", () => resolve());
  });
  const ready = JSON.stringify({
    address: `http://127.0.0.1:${fixture.port}`,
    botId: plugin.botId,
    clientId,
  });
  process.stdout.write(`${ready}\n`);
  await stopped;
  await fixture.stop(true);
} finally {
  await plugin.close();
}
