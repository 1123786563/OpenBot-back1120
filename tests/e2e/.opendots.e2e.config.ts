/*
 * A throwaway config for self-verifying skins-opendots.e2e.ts without touching the repository's
 * e2e.config.ts, whose suite lists a file argument only narrows. The config's directory is the
 * project root for its globs, so this lives beside the file it runs. Same shape as the real one:
 * one chromium target, serial, no retries.
 */
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
  tests: ["skins-opendots.e2e.ts"],
  workers: 1,
  retries: 0,
  assertionTimeout: 15_000,
  trace: "retain-on-failure",
  reporters: ["list", "junit"],
} satisfies E2EConfig;
