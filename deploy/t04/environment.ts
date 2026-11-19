import { readFileSync } from "node:fs";
import { parseEnv } from "node:util";

/**
 * The isolated T04 environment, checked before any command runs against it.
 *
 * The same shape as T02's guard: a command given the wrong file, port or database must fail here
 * rather than quietly act on somebody else's deployment. T04 additionally owns the fault-control
 * file path — the launcher passes it to the server, and `run.ts fault` writes it — so both halves
 * read the same constant.
 */
export const FAULT_FILE = "deploy/t04/.runtime/fault.json";

export function serverEnvironment(
  source: Record<string, string | undefined>,
): Record<string, string> {
  const env = parseEnv(readFileSync("deploy/t04/.env.t04", "utf8"));
  if (
    env.DEPLOYMENT_ID !== "openbot-t04" ||
    env.AUTH_MODE !== "casdoor" ||
    env.CASDOOR_OAUTH_ISSUER !== "http://localhost:19002" ||
    env.OPENBOT_LISTEN_HOSTNAME !== "127.0.0.1" ||
    env.PORT !== "14003"
  )
    throw new Error("Not the isolated T04 environment");
  for (const key of ["DATABASE_URL", "TEST_DATABASE_URL"]) {
    const address = new URL(env[key] ?? "");
    if (
      address.hostname !== "127.0.0.1" ||
      address.port !== "56434" ||
      address.pathname !==
        (key === "DATABASE_URL" ? "/openbot_t04" : "/openbot_t04_unit")
    )
      throw new Error("T04 database isolation mismatch");
  }
  for (const key of ["PATH", "HOME", "TMPDIR"])
    if (source[key]) env[key] = source[key];
  return env;
}
