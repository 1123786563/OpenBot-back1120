import { readFileSync } from "node:fs";
import { parseEnv } from "node:util";

export function serverEnvironment(
  source: Record<string, string | undefined>,
): Record<string, string> {
  const env = parseEnv(readFileSync("deploy/t02/.env.t02", "utf8"));
  if (
    env.DEPLOYMENT_ID !== "openbot-t02" ||
    env.AUTH_MODE !== "casdoor" ||
    env.CASDOOR_OAUTH_ISSUER !== "http://localhost:19000" ||
    env.OPENBOT_LISTEN_HOSTNAME !== "127.0.0.1" ||
    env.PORT !== "14001"
  )
    throw new Error("Not the isolated T02 environment");
  for (const key of ["DATABASE_URL", "TEST_DATABASE_URL"]) {
    const address = new URL(env[key] ?? "");
    if (
      address.hostname !== "127.0.0.1" ||
      address.port !== "56432" ||
      address.pathname !==
        (key === "DATABASE_URL" ? "/openbot_t02" : "/openbot_t02_unit")
    )
      throw new Error("T02 database isolation mismatch");
  }
  for (const key of ["PATH", "HOME", "TMPDIR"])
    if (source[key]) env[key] = source[key];
  return env;
}
export type ProcessRecord = {
  pid: number;
  entry: string;
  executable: string;
  started: string;
};
export function ownsProcess(
  saved: Omit<ProcessRecord, "pid">,
  current: { command: string; started: string },
  root: string,
): boolean {
  return (
    !!saved.started &&
    saved.started === current.started &&
    ["server/src/production-entry.ts", "worker/src/index.ts"].some(
      (f) => saved.entry === `${root}/${f}`,
    ) &&
    current.command === `${saved.executable} ${saved.entry}`
  );
}

export function assertSupplement(text: string): void {
  const allowed = new Set([
    "INTELLIGENCE_API_URL",
    "INTELLIGENCE_GATEWAY_WS_URL",
    "CPK_INTELLIGENCE_API_KEY",
    "OPENAI_API_KEY",
    "OPENAI_BASE_URL",
    "BOT_MODEL",
    // Which OpenAI protocol the CopilotKit runtime speaks (chat or responses); not a credential.
    "COPILOTKIT_OPENAI_API",
  ]);
  for (const line of text.split("\n")) {
    if (!line.trim() || line.trim().startsWith("#")) continue;
    const name = /^\s*(?:export\s+)?([A-Z_][A-Z_0-9]*)=/.exec(line)?.[1];
    if (!name || !allowed.has(name))
      throw new Error(
        "Supplement may contain only the authorized Intelligence/model fields",
      );
  }
}
