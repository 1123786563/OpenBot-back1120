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
    categories: [{ id: "productivity", name: "productivity" }],
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
    tags: ["createHint"],
    toolkit: { slug: TOOLKIT.slug, name: TOOLKIT.name },
  },
  {
    slug: "T04BOARD_READ_BOARD",
    name: "Read the board",
    description: "Reads the board's messages.",
    input_parameters: { type: "object", properties: {} },
    parameters: { type: "object", properties: {} },
    version: TOOL_VERSION,
    tags: ["readOnlyHint"],
    toolkit: { slug: TOOLKIT.slug, name: TOOLKIT.name },
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

/** The vendor's own state file: its accounts and ledger survive a restart of this process. */
const STATE_FILE = import.meta.dir + "/vendor-state.json";

const authConfigs = new Map<string, AuthConfig>();
const accounts = new Map<string, ConnectedAccount>();
/** Consents handed out, keyed by the state this vendor minted. */
const consents = new Map<string, { account: ConnectedAccount }>();
/** The board, PER ACCOUNT: the vendor scopes what an account reads to what it wrote. */
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
const requests: string[] = [];
const state: Record<string, unknown> = {};

type VendorSnapshot = {
  authConfigs: AuthConfig[];
  accounts: ConnectedAccount[];
  board: { by: string; text: string; at: string }[];
  executions: {
    at: string;
    vendorUserId: string;
    connectedAccountId: string;
    tool: string;
    arguments: unknown;
  }[];
  revocations: { at: string; vendorUserId: string; accountId: string }[];
};

let saveTimer: ReturnType<typeof setTimeout> | undefined;
function saveSoon(): void {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    const snapshot: VendorSnapshot = {
      authConfigs: [...authConfigs.values()],
      accounts: [...accounts.values()],
      board,
      executions,
      revocations,
    };
    void Bun.write(STATE_FILE, JSON.stringify(snapshot)).catch(() => {});
  }, 200);
}

async function loadSaved(): Promise<void> {
  try {
    const file = Bun.file(STATE_FILE);
    if (!(await file.exists())) return;
    const saved = (await file.json()) as VendorSnapshot;
    for (const config of saved.authConfigs ?? []) authConfigs.set(config.id, config);
    for (const account of saved.accounts ?? []) accounts.set(account.id, account);
    board.push(...(saved.board ?? []));
    executions.push(...(saved.executions ?? []));
    revocations.push(...(saved.revocations ?? []));
  } catch {
    // A state file that cannot be read is a fresh vendor, not a fault.
  }
}
await loadSaved();

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
    const line = `${method} ${path}${url.search}`;
    requests.push(line);

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
      saveSoon();
      // Straight back to the address the link was given, which is OpenBot's own callback carrying
      // its sealed state — the same leg the real vendor runs.
      return Response.redirect(back, 302);
    }

    // The evidence read-out: sanitized at the caller, not here.
    if (path === "/__ledger" && method === "GET") {
      saveSoon();
      return json({ executions, revocations, board, accounts: [...accounts.values()] });
    }
    if (path === "/__unanswered" && method === "GET") {
      return json({ unanswered });
    }
    if (path === "/__requests" && method === "GET") {
      return json({ requests: requests.slice(-25) });
    }
    // The verification harness's state (sanitized ids plus the fixture credentials it needs to
    // re-sign people in across acts). Loopback only, never logged, never in the evidence.
    if (path === "/__state") {
      if (method === "GET") return json(state);
      if (method === "POST") {
        const body = await readBody(request);
        if (body.reset) {
          for (const key of Object.keys(state)) delete state[key];
          return json({ reset: true });
        }
        Object.assign(state, body);
        return json({ saved: Object.keys(body).length });
      }
    }

    if ((path === "/api/v3/toolkits" || path === "/api/v3.1/toolkits") && method === "GET") {
      return json({ items: [TOOLKIT], next_cursor: null, total_pages: 1 });
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

    if (path === "/api/v3/auth_configs" || path === "/api/v3.1/auth_configs") {
      if (method === "GET") {
        const toolkit =
          url.searchParams.get("toolkits") ??
          url.searchParams.get("toolkit_slug") ??
          url.searchParams.get("toolkit");
        const rows = [...authConfigs.values()].filter((config) =>
          toolkit ? config.toolkit.slug === toolkit : true,
        );
        return json({
          items: rows.map((config) => ({
            ...config,
            toolkit: { slug: config.toolkit.slug, logo: `http://127.0.0.1:${PORT}/logo.png` },
          })),
          next_cursor: null,
          total_pages: 1,
          total_items: rows.length,
        });
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
          name: `${slug} ${id.slice(-6)} (OpenBot)`,
          status: "ENABLED",
          no_of_connections: 0,
          toolkit: { slug: slug || TOOLKIT.slug },
          created_at: new Date().toISOString(),
        };
        authConfigs.set(id, created);
        saveSoon();
        // The create response the SDK parses strictly: {id, authScheme, isComposioManaged, toolkit}.
        return json(
          {
            id,
            authScheme: "OAUTH2",
            isComposioManaged: true,
            toolkit: created.toolkit.slug,
            // The wrapper shape the broker reads the new config's id from.
            auth_config: { id, status: "ENABLED" },
          },
          201,
        );
      }
    }
    if (path.startsWith("/api/v3/auth_configs/") && method === "DELETE") {
      const id = path.split("/").pop() ?? "";
      const removed = authConfigs.get(id);
      authConfigs.delete(id);
      return json({ id, deleted: Boolean(removed) });
    }

    if ((path === "/api/v3/connected_accounts" || path === "/api/v3.1/connected_accounts") && method === "GET") {
      // The link preflight filters by user, config and status — and the vendor must answer with
      // the filtered set, exactly the contract the real API keeps: the SDK trusts this answer.
      const userIds = url.searchParams.get("user_ids")?.split(",").filter(Boolean);
      const authConfigIds = url.searchParams.get("auth_config_ids")?.split(",").filter(Boolean);
      const statuses = url.searchParams.get("statuses")?.split(",").filter(Boolean);
      const rows = [...accounts.values()].filter(
        (account) =>
          (!userIds || userIds.includes(account.user_uuid)) &&
          (!authConfigIds || authConfigIds.includes(account.auth_config_id)) &&
          (!statuses || statuses.includes(account.status)),
      );
      return json({
        total_pages: 1,
        total_items: rows.length,
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
    if ((path === "/api/v3/connected_accounts/link" || path === "/api/v3.1/connected_accounts/link") && method === "POST") {
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
      saveSoon();
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
    if (
      (path.startsWith("/api/v3/connected_accounts/") ||
        path.startsWith("/api/v3.1/connected_accounts/")) &&
      !path.endsWith("/link")
    ) {
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
        saveSoon();
        return json({ success: true });
      }
    }

    if ((path === "/api/v3/tools" || path === "/api/v3.1/tools") && method === "GET") {
      return json({ items: TOOLS, next_cursor: null, total_pages: 1 });
    }
    if ((path.startsWith("/api/v3/tools/") || path.startsWith("/api/v3.1/tools/")) && method === "GET" && !path.includes("execute")) {
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
      const connectedAccountId = String(body.connected_account_id ?? body.connectedAccountId ?? "");
      // A call may pin the account by id, or name only the user it runs for, which is how the
      // real vendor resolves an unpinned call: the account held for that user.
      const account =
        accounts.get(connectedAccountId) ??
        [...accounts.values()].find(
          (candidate) =>
            candidate.user_uuid === String(body.user_id ?? "") &&
            candidate.status === "ACTIVE",
        );
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
      saveSoon();
      if (slug === "T04BOARD_READ_BOARD") {
        // The vendor enforces the account boundary on reads too: an account sees its own words.
        return json({
          successful: true,
          data: {
            messages: board
              .filter((entry) => entry.by === account.user_uuid)
              .map((entry) => ({ by: entry.by, text: entry.text })),
          },
        });
      }
      const message = String(text ?? "");
      board.push({ by: account.user_uuid, text: message, at: new Date().toISOString() });
      saveSoon();
      return json({ successful: true, data: { posted: message } });
    }

    unanswered.push(line);
    await Bun.write(import.meta.dir + "/unanswered.log", `${line}\n`, {
      append: true,
    });
    return json({ message: `not taught: ${line}` }, 404);
  },
});

console.log(`vendor stand-in on http://127.0.0.1:${server.port}`);
