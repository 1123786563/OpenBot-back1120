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
    started: "Mon Nov 18 19:00:00 2026",
    instance: "/repo/deploy/t01/.runtime/server-1-abc.log",
  };
  expect(
    ownsProcess(
      p,
      {
        command: "/bin/bun /repo/server/src/production-entry.ts",
        started: "Mon Nov 18 19:00:00 2026",
      },
      "/repo",
    ),
  ).toBe(true);
  expect(
    ownsProcess(
      p,
      {
        command: "vim /repo/server/src/production-entry.ts",
        started: "Mon Nov 18 19:00:00 2026",
      },
      "/repo",
    ),
  ).toBe(false);
  expect(
    ownsProcess(
      p,
      {
        command: "/bin/bun /repo/server/src/production-entry.ts",
        started: "Mon Nov 18 19:00:01 2026",
      },
      "/repo",
    ),
  ).toBe(false);
});

test("lsof fallback refuses a same-executable same-cwd different instance", () => {
  const p = {
    entry: "/repo/server/src/production-entry.ts",
    executable: "/bin/bun",
    started: "",
    instance: "/repo/deploy/t01/.runtime/server-1-abc.log",
  };
  // Our own instance: fd 1/2 still point at the per-launch log file.
  expect(
    ownsProcess(
      p,
      {
        command: "/bin/bun /repo/server",
        started: "",
        stdio: [
          "/repo/deploy/t01/.runtime/server-1-abc.log",
          "/repo/deploy/t01/.runtime/server-1-abc.log",
        ],
      },
      "/repo",
    ),
  ).toBe(true);
  // A reused PID running a different Bun script with the same executable and
  // the same working directory (e.g. another deploy/t01 helper): its stdio is
  // not our per-launch file, so it must be refused even though executable and
  // cwd match exactly.
  expect(
    ownsProcess(
      p,
      {
        command: "/bin/bun /repo/server",
        started: "",
        stdio: ["/repo/other-script.log", "/repo/other-script.log"],
      },
      "/repo",
    ),
  ).toBe(false);
  // No stdio observable: fail closed rather than guess.
  expect(
    ownsProcess(
      p,
      { command: "/bin/bun /repo/server", started: "", stdio: [] },
      "/repo",
    ),
  ).toBe(false);
  expect(
    ownsProcess(p, { command: "/bin/bun /repo/server", started: "" }, "/repo"),
  ).toBe(false);
  // Legacy record without an instance file (pre-fix launch.ts): refuse.
  expect(
    ownsProcess(
      { ...p, instance: "" },
      {
        command: "/bin/bun /repo/server",
        started: "",
        stdio: ["/repo/deploy/t01/.runtime/server-1-abc.log"],
      },
      "/repo",
    ),
  ).toBe(false);
  // Right file but a different executable in the same directory.
  expect(
    ownsProcess(
      p,
      {
        command: "/bin/tail /repo/server",
        started: "",
        stdio: ["/repo/deploy/t01/.runtime/server-1-abc.log"],
      },
      "/repo",
    ),
  ).toBe(false);
  // Instance file must be held as fd 1/2, not merely open somewhere.
  expect(
    ownsProcess(
      p,
      { command: "/bin/bun /repo", started: "", stdio: [p.instance] },
      "/repo",
    ),
  ).toBe(false);
  expect(
    ownsProcess(
      { ...p, entry: "/repo/server/src/other.ts" },
      {
        command: "/bin/bun /repo/server",
        started: "",
        stdio: [p.instance],
      },
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
