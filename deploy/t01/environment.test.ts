import { expect, test } from "bun:test";
import {
  assertSupplement,
  ownsProcess,
  serverEnvironment,
} from "./environment";

test("does not inherit another deployment's authority or arbitrary settings", () => {
  expect(() =>
    serverEnvironment({ OPENBOT_ORGANIZATION_AUTH_URL: "http://another.test" }),
  ).toThrow();
  const env = serverEnvironment({
    PATH: "/bin",
    DATABASE_URL: "test",
    UNKNOWN_PROVIDER_SECRET: "private",
    INTELLIGENCE_API_URL: "http://intelligence.test",
    COPILOTKIT_OPENAI_API: "responses",
  });
  expect(env.UNKNOWN_PROVIDER_SECRET).toBeUndefined();
  expect(env.DATABASE_URL).toBe("test");
  expect(env.INTELLIGENCE_API_URL).toBe("http://intelligence.test");
  expect(env.COPILOTKIT_OPENAI_API).toBe("responses");
});
test("PID reuse or an editor mentioning the entry is not our Bun process", () => {
  const p = {
    entry: "/repo/server/src/production-entry.ts",
    executable: "/bin/bun",
    started: "time1",
  };
  expect(
    ownsProcess(
      p,
      {
        command: "/bin/bun /repo/server/src/production-entry.ts",
        started: "time1",
      },
      "/repo",
    ),
  ).toBe(true);
  expect(
    ownsProcess(
      p,
      { command: "vim /repo/server/src/production-entry.ts", started: "time1" },
      "/repo",
    ),
  ).toBe(false);
  expect(
    ownsProcess(
      p,
      {
        command: "/bin/bun /repo/server/src/production-entry.ts",
        started: "time2",
      },
      "/repo",
    ),
  ).toBe(false);
  expect(
    ownsProcess(
      { ...p, started: "" },
      { command: "/bin/bun /repo/server/src/production-entry.ts", started: "" },
      "/repo",
    ),
  ).toBe(false);
});

test("accepts only the authorized supplement field names", () => {
  expect(() =>
    assertSupplement(
      "INTELLIGENCE_API_URL=http://test\nOPENAI_API_KEY=private\nOPENAI_BASE_URL=http://model\nBOT_MODEL=test\nCOPILOTKIT_OPENAI_API=responses\n",
    ),
  ).not.toThrow();
  expect(() =>
    assertSupplement("BETTER_AUTH_URL=http://another-deployment\n"),
  ).toThrow();
  expect(() =>
    assertSupplement(
      "OPENBOT_ORGANIZATION_AUTH_URL=http://another-deployment\n",
    ),
  ).toThrow();
});
