import { expect, test } from "bun:test";
import {
  type PluginsPage,
  pluginKeys,
  pluginsProvider,
} from "@/lib/plugins/queries";

const page = (extra: Partial<PluginsPage>): PluginsPage => ({
  catalogue: [],
  servers: [],
  skills: [],
  botsMayCallBack: false,
  redirectUri: null,
  composioConfigured: true,
  authorizesPerAction: false,
  ...extra,
});

test("a payload with no provider answers composio", () => {
  expect(pluginsProvider(page({}))).toBe("composio");
});

test("a payload that names a provider is believed", () => {
  expect(pluginsProvider(page({ provider: "arcade" }))).toBe("arcade");
  expect(pluginsProvider(page({ provider: "composio" }))).toBe("composio");
});

test("no page yet answers composio", () => {
  expect(pluginsProvider(undefined)).toBe("composio");
});

test("the plugins page uses the shared cache key", () => {
  expect(pluginKeys.page()).toEqual(["plugins", "page"]);
});
