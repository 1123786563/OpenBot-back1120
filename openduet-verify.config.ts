import { web } from "@e2e-dev/web";
import type { E2EConfig } from "e2e";

/*
 * Verification-only config for the OpenDuet skin migration: the repo's e2e.config.ts is off limits
 * for this change, and the runner selects positional file arguments from the config's test list.
 * Same target and guarantees as the suite config; only the test list differs.
 */
const suite = process.env.OPENBOT_E2E_SUITE;
if (
  suite !== "guest" &&
  suite !== "navigation" &&
  suite !== "personal" &&
  suite !== "authenticated" &&
  suite !== "live"
) {
  throw new Error(
    "OPENBOT_E2E_SUITE must be guest, navigation, personal, authenticated, or live",
  );
}

export default {
  targets: [
    {
      name: "chromium",
      engine: web({ browser: "chromium", locale: "en-US" }),
      app: { url: process.env.OPENBOT_WEB_URL ?? "http://localhost:3010" },
    },
  ],
  tests: ["tests/e2e/skins-openduet.e2e.ts"],
  workers: 1,
  retries: 0,
  assertionTimeout: 15_000,
  trace: "retain-on-failure",
  reporters: ["list", "junit"],
} satisfies E2EConfig;
