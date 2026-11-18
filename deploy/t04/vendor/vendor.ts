/**
 * The T04 vendor stand-in: a small real HTTP service answering the slice of the Composio API the
 * broker adapter uses, so a two-person authorization and execution can run END TO END — real
 * browser, real redirect to a vendor consent page, real callback, real tool execution, real
 * revocation — against a vendor that is not Composio's SaaS, because no test tenant credentials
 * for it exist in this environment.
 *
 * A STAND-IN IN EXACTLY ONE SENSE: it is not the vendor's hosted service. Everything else is real:
 * the adapter talks to it over HTTP through `@composio/core`, the consent screen is a real page a
 * real browser visits, the redirect back carries the same return address the real vendor would be
 * given, and every action execution is recorded HERE with the vendor identity that performed it —
 * which is the evidence this file exists to produce. The ledger is the vendor side of the story;
 * OpenBot's own database is the other side, and the two are checked against each other.
 *
 * Learned shape notes (from what the adapter and SDK actually ask — `unanswered.log` records
 * anything this has not been taught yet):
 * - toolkits: GET /api/v3/toolkits — rows {slug, name, meta{description,categories,logo,tools_count},
 *   no_auth, auth_schemes, composio_managed_auth_schemes}. OAUTH2 in the managed list is what makes
 *   the app a "consent" app (composio-vendor.ts connectionOf).
 * - auth configs: GET /api/v3/auth_configs?toolkits=...&show_disabled=...; POST /api/v3/auth_configs
 *   with body {toolkit:{slug}, auth_config:{type:"use_composio_managed_auth", name}}. Rows carry
 *   id, name, status ENABLED, toolkit{slug}.
 * - connected accounts: GET /api/v3/connected_accounts (query filters), POST
 *   /api/v3/connected_accounts/link {auth_config_id, user_id, callback_url} →
 *   {connected_account_id, redirect_url}; GET /api/v3/connected_accounts/:id; DELETE with
 *   revoke_on_delete.
 * - tools: GET /api/v3/tools?toolkit_slug=...&toolkit_versions=latest → {items} of
 *   {slug, name, description, input_parameters, parameters, version, toolkit{slug}}.
 *   GET /api/v3/tools/:slug (resolve before run); POST execute path per the SDK.
 */

const PORT = Number(process.env.VENDOR_PORT ?? 19610);

/** The one app this tenant publishes. */
const TOOLKIT = {
  slug: "t04board",
  name: "T04 Board",
  meta: {
    description: "The stand-in vendor's message board.",
    categories: ["productivity"],
    logo: null,
    tools_count: 2,
  },
  no_auth: false,
  auth_schemes: ["OAUTH2"],
  composio_managed_auth_schemes: ["OAUTH2"],
};

const TOOL_VERSION = "2026-11-19";

const TOOLS = [
  {
    slug: "T04BOARD_POST_MESSAGE",
    name: "Post a message",
    description: "Posts a message to the board.",
    input_parameters: {
      type: "object",
      properties: { text: { type: "string", description: "The message." } },
      required: ["text"],
    },
    parameters: {
      type: "object",
      properties: { text: { type: "string", description: "The message." } },
      required: ["text"],
    },
    version: TOOL_VERSION,
    toolkit: { slug: TOOLKIT.slug },
  },
  {
    slug: "T04BOARD_READ_BOARD",
    name: "Read the board",
    description: "Reads the board's messages.",
    input_parameters: { type: "object", properties: {} },
    parameters: { type: "object", properties: {} },
    version: TOOL_VERSION,
    toolkit: { slug: TOOLKIT.slug },
  },
];

type ConnectedAccount = {
  id: string;
  auth_config_id: string;
  user_uuid: string;
  status: "ACTIVE" | "INITIATED" | "FAILED";
  created_at: string;
};

type AuthConfig = {
  id: string;
  name: string;
  status: "ENABLED";
  toolkit: { slug: string };
  created_at: string;
};

const authConfigs = new Map<string, AuthConfig>();
const accounts = new Map<string, ConnectedAccount>();
/** Consents handed out, keyed by the state this vendor minted. */
const consents = new Map<string, { account: ConnectedAccount }>();
/** The board: what executions wrote, read back by the read action. */
const board: { by: string; text: string; at: string }[] = [];
/** THE LEDGER: every executed action with the vendor identity that performed it. */
const executions: {
  at: string;
  vendorUserId: string;
  connectedAccountId: string;
  tool: string;
  arguments: unknown;
}[] = [];
/** Every revocation, with the identity whose access was withdrawn. */
const revocations: { at: string; vendorUserId: string; accountId: string }[] =
  [];
const unanswered: string[] = [];

function json(data: unknown, status = 200): Response {
  return Response.json(data as never, { status });
}

function randomId(prefix: string): string {
  return `${prefix}_${crypto.randomUUID().replace(/-/g, "").slice(0, 20)}`;
}

async function readBody(request: Request): Promise<Record<string, unknown>> {
  try {
    return (await request.json()) as Record<string, unknown>;
  } catch {
    return {};
  }
}

const server = Bun.serve({
  hostname: "127.0.0.1",
  port: PORT,
  async fetch(request) {
    const url = new URL(request.url);
    const path = url.pathname;
    const method = request.method;

    // The consent screen, and the approval that sends the browser back to OpenBot's callback.
    if (path === "/consent" && method === "GET") {
      const state = url.searchParams.get("state") ?? "";
      const user = url.searchParams.get("vendor_user") ?? "";
      const back = url.searchParams.get("back") ?? "";
      return new Response(
        `<!doctype html><html><head><title>T04 vendor consent</title></head>
<body><h1>T04 vendor stand-in — consent</h1>
<p>Attach an account for vendor user <strong>${user}</strong> (state ${state}).</p>
<form method="post" action="/consent/approve">
<input type="hidden" name="state" value="${state}">
<input type="hidden" name="back" value="${back}">
<button type="submit">Approve</button>
</form></body></html>`,
        { headers: { "content-type": "text/html" } },
      );
    }
    if (path === "/consent/approve" && method === "POST") {
      const form = new URLSearchParams(await request.text());
      const state = form.get("state") ?? "";
      const back = form.get("back") ?? "";
      const consent = consents.get(state);
      if (consent) consent.account.status = "ACTIVE";
      // Straight back to the address the link was given, which is OpenBot's own callback carrying
      // its sealed state — the same leg the real vendor runs.
      return Response.redirect(back, 302);
    }

    // The evidence read-out: sanitized at the caller, not here.
    if (path === "/__ledger" && method === "GET") {
      return json({ executions, revocations, board, accounts: [...accounts.values()] });
    }
    if (path === "/__unanswered" && method === "GET") {
      return json({ unanswered });
    }

    if (path === "/api/v3/toolkits" && method === "GET") {
      return json({ items: [TOOLKIT], next_cursor: null });
    }
    if (path === `/api/v3/toolkits/${TOOLKIT.slug}` && method === "GET") {
      return json({
        ...TOOLKIT,
        auth_config_details: [
          {
            scheme: "OAUTH2",
            name: "OAuth 2.0",
            is_composio_managed: true,
            fields: [],
          },
        ],
        auth_guide_url: "http://127.0.0.1:19610/guide",
      });
    }

    if (path === "/api/v3/auth_configs") {
      if (method === "GET") {
        const toolkit = url.searchParams.get("toolkits") ?? url.searchParams.get("toolkit");
        const rows = [...authConfigs.values()].filter((config) =>
          toolkit ? config.toolkit.slug === toolkit : true,
        );
        return json({ items: rows, next_cursor: null });
      }
      if (method === "POST") {
        const body = await readBody(request);
        const slug = String(
          (body.toolkit as { slug?: unknown } | undefined)?.slug ??
            url.searchParams.get("toolkit") ??
            "",
        );
        const id = randomId("acfg");
        const created: AuthConfig = {
          id,
          name: `${slug} OpenBot ${id.slice(-6)}`,
          status: "ENABLED",
          toolkit: { slug: slug || TOOLKIT.slug },
          created_at: new Date().toISOString(),
        };
        authConfigs.set(id, created);
        return json(created, 201);
      }
    }
    if (path.startsWith("/api/v3/auth_configs/") && method === "DELETE") {
      const id = path.split("/").pop() ?? "";
      const removed = authConfigs.get(id);
      authConfigs.delete(id);
      return json({ id, deleted: Boolean(removed) });
    }

    if (path === "/api/v3/connected_accounts" && method === "GET") {
      const rows = [...accounts.values()];
      return json({
        items: rows.map((account) => ({
          id: account.id,
          status: account.status,
          user_uuid: account.user_uuid,
          created_at: account.created_at,
          auth_config: {
            id: account.auth_config_id,
            toolkit: { slug: TOOLKIT.slug },
          },
          data: {},
        })),
        next_cursor: null,
      });
    }
    if (path === "/api/v3/connected_accounts/link" && method === "POST") {
      const body = await readBody(request);
      const authConfigId = String(body.auth_config ?? body.auth_config_id ?? "");
      const userId = String(body.user_id ?? "unknown");
      const callbackUrl = String(body.callback_url ?? "");
      const config = authConfigs.get(authConfigId) ?? {
        id: authConfigId,
        name: "unheard config",
        status: "ENABLED" as const,
        toolkit: { slug: TOOLKIT.slug },
        created_at: new Date().toISOString(),
      };
      const account: ConnectedAccount = {
        id: randomId("ca"),
        auth_config_id: config.id,
        user_uuid: userId,
        status: "INITIATED",
        created_at: new Date().toISOString(),
      };
      accounts.set(account.id, account);
      const state = randomId("st");
      consents.set(state, { account });
      const back = callbackUrl || "http://localhost:14003/api/plugins/oauth/callback";
      return json(
        {
          connected_account_id: account.id,
          redirect_url: `http://127.0.0.1:${server.port}/consent?state=${state}&vendor_user=${encodeURIComponent(userId)}&back=${encodeURIComponent(back)}`,
          status: "INITIATED",
        },
        201,
      );
    }
    if (path.startsWith("/api/v3/connected_accounts/") && path !== "/api/v3/connected_accounts/link") {
      const id = path.split("/").pop() ?? "";
      const account = accounts.get(id);
      if (!account) return json({ message: "Connected account not found" }, 404);
      if (method === "GET") {
        return json({
          id: account.id,
          status: account.status,
          user_uuid: account.user_uuid,
          created_at: account.created_at,
          auth_config: {
            id: account.auth_config_id,
            toolkit: { slug: TOOLKIT.slug },
          },
          data: {},
        });
      }
      if (method === "DELETE") {
        accounts.delete(id);
        revocations.push({
          at: new Date().toISOString(),
          vendorUserId: account.user_uuid,
          accountId: account.id,
        });
        return json({ success: true });
      }
    }

    if (path === "/api/v3/tools" && method === "GET") {
      return json({ items: TOOLS, next_cursor: null });
    }
    if (path.startsWith("/api/v3/tools/") && method === "GET") {
      const slug = decodeURIComponent(path.split("/").pop() ?? "");
      const tool = TOOLS.find((candidate) => candidate.slug === slug);
      if (!tool) return json({ message: "Tool not found" }, 404);
      return json(tool);
    }
    if (path.includes("execute") && method === "POST") {
      const slug = decodeURIComponent(
        path.split("/").pop()?.replace(/^execute[/_]/, "") ?? "",
      );
      const body = await readBody(request);
      const vendorUserId = String(body.user_id ?? "unknown");
      const connectedAccountId = String(body.connected_account_id ?? body.connectedAccountId ?? "");
      const account = accounts.get(connectedAccountId);
      const text = (body.arguments as { text?: unknown } | undefined)?.text;
      // THE VENDOR-SIDE RULE THAT MAKES THE EVIDENCE MEAN SOMETHING: an action runs as the
      // connected account the call names, and the ledger records exactly that identity. An
      // execution naming an account that does not exist here is refused — the vendor does not run
      // actions for accounts it does not hold.
      if (!account) {
        return json(
          { message: `No connected account ${connectedAccountId} at this vendor` },
          404,
        );
      }
      executions.push({
        at: new Date().toISOString(),
        vendorUserId: account.user_uuid,
        connectedAccountId: account.id,
        tool: slug,
        arguments: body.arguments,
      });
      if (slug === "T04BOARD_READ_BOARD") {
        return json({
          successful: true,
          data: {
            messages: board.map((entry) => ({ by: entry.by, text: entry.text })),
            original: String(text ?? ""),
          },
        });
      }
      const message = String(text ?? "");
      board.push({ by: account.user_uuid, text: message, at: new Date().toISOString() });
      return json({ successful: true, data: { posted: message } });
    }

    const line = `${method} ${path}${url.search}`;
    unanswered.push(line);
    await Bun.write(import.meta.dir + "/unanswered.log", `${line}\n`, {
      append: true,
    });
    return json({ message: `not taught: ${line}` }, 404);
  },
});

console.log(`vendor stand-in on http://127.0.0.1:${server.port}`);
