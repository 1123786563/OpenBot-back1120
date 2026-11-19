/**
 * Drives the real adapter against the stand-in vendor, printing every HTTP request the SDK makes,
 * so the vendor's surface can be taught from what actually arrives.
 */

const base = process.env.VENDOR_BASE_URL ?? "http://127.0.0.1:19610";
process.env.COMPOSIO_API_KEY = process.env.COMPOSIO_API_KEY ?? "t04-stand-in-key";
process.env.COMPOSIO_BASE_URL = base;

const { createComposioClient } = await import(
  "../../../server/src/plugins/composio-adapter"
);

const vendor = createComposioClient("t04-stand-in-key");

console.log("== authConfigs.list ==");
console.log(JSON.stringify(await vendor.authConfigs.list({ showActiveOnly: true } as never)).slice(0, 300));

console.log("== authConfigs.create ==");
const created = await vendor.authConfigs.create(" slack" as never, {} as never);
console.log(JSON.stringify(created).slice(0, 300));

console.log("== connectedAccounts.link ==");
const linked = await vendor.connectedAccounts.link(
  "vendor-user-A",
  (created as { id: string }).id,
  {} as never,
);
console.log(JSON.stringify(linked).slice(0, 600));
