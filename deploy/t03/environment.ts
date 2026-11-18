import { readFileSync } from "node:fs";
import { parseEnv } from "node:util";

/**
 * The isolated T03 environment, checked before any command runs against it.
 *
 * The same shape as T02's guard: a command given the wrong file, port or database must fail here
 * rather than quietly act on somebody else's deployment. T03 additionally owns the fault-control
 * file path — the launcher passes it to the server, and `run.ts fault` writes it — so both halves
 * read the same constant.
 */
export const FAULT_FILE = "deploy/t03/.runtime/fault.json";

export function serverEnvironment(
  source: Record<string, string | undefined>,
): Record<string, string> {
  const env = parseEnv(readFileSync("deploy/t03/.env.t03", "utf8"));
  if (
    env.DEPLOYMENT_ID !== "openbot-t03" ||
    env.AUTH_MODE !== "casdoor" ||
    env.CASDOOR_OAUTH_ISSUER !== "http://localhost:19001" ||
    env.OPENBOT_LISTEN_HOSTNAME !== "127.0.0.1" ||
    env.PORT !== "14002"
  )
    throw new Error("Not the isolated T03 environment");
  for (const key of ["DATABASE_URL", "TEST_DATABASE_URL"]) {
    const address = new URL(env[key] ?? "");
    if (
      address.hostname !== "127.0.0.1" ||
      address.port !== "56433" ||
      address.pathname !==
        (key === "DATABASE_URL" ? "/openbot_t03" : "/openbot_t03_unit")
    )
      throw new Error("T03 database isolation mismatch");
  }
  for (const key of ["PATH", "HOME", "TMPDIR"])
    if (source[key]) env[key] = source[key];
  return env;
}
