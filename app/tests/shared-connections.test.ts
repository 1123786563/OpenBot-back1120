import { expect, test } from "bun:test";
import {
  brokeredAccountsListedOn,
  serversListedFor,
  sharedAccountsListedOn,
} from "@/lib/plugins/listed";
import type { PluginServer } from "@/lib/plugins/queries";
import { brokeredFor } from "@/routes/_authed/_app/connections.$key";

const personal = {
  id: "person",
  provenance: "composio",
  authScheme: "OAUTH2",
  accountMode: "personal",
} as PluginServer;
const shared = {
  ...personal,
  id: "shared",
  accountMode: "shared",
} satisfies PluginServer;

test("personal and shared accounts are listed separately", () => {
  const servers = [personal, shared];
  expect(brokeredAccountsListedOn(servers)).toEqual([personal]);
  expect(sharedAccountsListedOn(servers)).toEqual([shared]);
});

test("the Connections account page only treats the personal account as the reader's to confirm", () => {
  expect(brokeredFor(personal)).toBe(true);
  expect(brokeredFor(shared)).toBe(false);
});

test("the Connections list filters unconfigured Composio Apps and retains other providers", () => {
  const drive = {
    ...personal,
    id: "google-drive",
    provenance: "catalogue",
  } satisfies PluginServer;
  const servers = [personal, drive];
  expect(serversListedFor({ servers, composioConfigured: false })).toEqual([
    drive,
  ]);
  expect(serversListedFor({ servers, composioConfigured: true })).toEqual(
    servers,
  );
});
