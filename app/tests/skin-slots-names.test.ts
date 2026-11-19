import { expect, test } from "bun:test";

/*
 * The one check from the skin-slot DOM suite a browser cannot answer: the app-level `data-slot`
 * hooks are names no primitive in `components/ui` gives itself, so a skin rule aimed at
 * `composer` can never land on, say, a button. Pure source scanning, no DOM; the hooks
 * themselves are held to their elements by tests/e2e/skin-slots.e2e.ts.
 */

test("no app-level hook reuses a name the ui primitives give themselves", async () => {
  const { readdirSync, readFileSync } = await import("node:fs");
  const dir = new URL("../src/components/ui/", import.meta.url);
  const primitives = new Set<string>();
  for (const file of readdirSync(dir)) {
    const source = readFileSync(new URL(file, dir), "utf8");
    for (const match of source.matchAll(/data-slot="([\w-]+)"/g)) {
      primitives.add(match[1] as string);
    }
  }
  expect(primitives.size).toBeGreaterThan(50);
  const hooks = [
    "composer",
    "composer-input",
    "composer-attach",
    "composer-send",
    "composer-stop",
    "composer-dictate",
    "composer-dictate-cancel",
    "composer-dictate-stop",
    "composer-column",
    "conversation-header",
    "detail-pane",
    "detail-pane-header",
    "detail-pane-title",
    "page-header",
    "page-title",
  ];
  expect(hooks.filter((hook) => primitives.has(hook))).toEqual([]);
});
