import base from "./e2e.config.ts";

// Scratch verification config: preserve the suite's Chromium target and zero retries.
export default { ...base, tests: ["tests/e2e/skin-slots.e2e.ts"] };
