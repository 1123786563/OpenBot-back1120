/**
 * The T04 preset fixture for the shared-account evidence: enabling the stand-in vendor's app out
 * of the broker's catalogue, which on this deployment is an ADMINISTRATOR'S ACT — and the T02/T03
 * design deliberately gives a Casdoor business actor no platform role, so there is no HTTP-reachable
 * administrator to ask. The act is therefore performed here, against the same real code the route
 * runs (`enableComposioApp` → `store.addBrokeredApp` → the real broker → the real vendor over HTTP),
 * on the deployment's own database, from the deployment's own environment. Nothing about A or B is
 * touched: this presets the shared app exactly as the review's evidence asks ("共享账户由测试管理员
 * 预置"), and every per-person act after it goes through the real routes with real sessions.
 *
 * Run from the server directory with the T04 environment (DATABASE_URL, KEY_ENCRYPTION_KEY and the
 * COMPOSIO_* pair pointing at the stand-in vendor). Sanitized output only.
 */
import { createDatabase } from "../../../server/src/db/client";
import { createAuditStore } from "../../../server/src/audit";
import { createCredentialStore } from "../../../server/src/credentials";
import { createPluginStore } from "../../../server/src/plugins/store";
import { createComposioClient } from "../../../server/src/plugins/composio-adapter";

const slug = process.argv[2] ?? "t04board";

const database = createDatabase(process.env.DATABASE_URL!, { max: 2 });
const credentialStore = createCredentialStore(database);
process.env.COMPOSIO_API_KEY = process.env.COMPOSIO_API_KEY ?? "t04-stand-in-key";
process.env.COMPOSIO_BASE_URL = process.env.COMPOSIO_BASE_URL ?? "http://127.0.0.1:19610";
const composio = createComposioClient(process.env.COMPOSIO_API_KEY!);
// The actions seam the listing paths read: the same module-global the server installs at boot
// (`useComposioClient`), so the refresh here lists through the same real adapter.
const { useComposioClient } = await import("../../../server/src/plugins/composio");
useComposioClient(composio.actions);
const store = createPluginStore({
  database,
  deploymentId: "openbot-t04",
  auditStore: createAuditStore(database),
  credentials: credentialStore,
  encryptionKey: process.env.OPENBOT_KEY_ENCRYPTION_KEY ?? process.env.KEY_ENCRYPTION_KEY ?? "",
  policy: () => ({ allow: true } as never),
  brokerProvider: "composio",
  // The same broker the deployment runs, so the enable writes the row the routes read.
  broker: composio.broker,
});

const { enableComposioApp } = await import(
  "../../../server/src/plugins/route-groups/composio-apps"
);
const outcome = await enableComposioApp(
  { store, composio, activeProvider: "composio", activeVendor: "Composio" },
  slug,
  "t04-fixture-admin",
);
if (!outcome.ok) {
  console.log(JSON.stringify({ enabled: false, error: outcome.error }));
  process.exit(1);
}
// The enable refreshes before it answers; make sure the actions are recorded (idempotent read).
const tools = await store.refreshTools(outcome.server.id, "t04-fixture-admin");
console.log(
  JSON.stringify({
    enabled: true,
    server: {
      id: outcome.server.id,
      url: outcome.server.url,
      title: outcome.server.title,
    },
    tools: tools.tools,
  }),
);
process.exit(0);
