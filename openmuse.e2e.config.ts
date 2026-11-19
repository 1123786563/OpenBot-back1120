// Self-verification config: runs only the new OpenMuse suite file. e2e.config.ts is
// off-limits to this migration, so this scratch copy stands in for one suite run.
import { web } from "@e2e-dev/web";
import type { E2EConfig } from "e2e";

export default {
  targets: [
    {
      name: "chromium",
      engine: web({ browser: "chromium", locale: "en-US" }),
      app: { url: process.env.OPENBOT_WEB_URL ?? "http://localhost:3010" },
    },
  ],
  tests: ["tests/e2e/skins-openmuse.e2e.ts"],
  workers: 1,
  retries: 0,
  assertionTimeout: 15_000,
  trace: "retain-on-failure",
  reporters: ["list", "junit"],
} satisfies E2EConfig;
