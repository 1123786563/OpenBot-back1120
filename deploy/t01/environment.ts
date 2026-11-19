import { readFileSync } from "node:fs";

export function serverEnvironment(
  source: Record<string, string | undefined>,
): Record<string, string> {
  if (source.OPENBOT_ORGANIZATION_AUTH_URL?.trim())
    throw new Error("T01 must use its own Casdoor authority");
  // T01 fixes the Okta-compatible entry to reach Casdoor. Report the offending field
  // name only; the dedicated AUTH_MODE=casdoor path needs its own verification matrix.
  for (const key of Object.keys(source)) {
    if (key === "AUTH_MODE" || key.startsWith("CASDOOR_OAUTH_"))
      throw new Error(
        `T01 fixes the Okta-compatible Casdoor mode; unexpected ${key} in environment`,
      );
  }
  const names = [
    ...readFileSync(
      new URL(".env.t01.example", import.meta.url),
      "utf8",
    ).matchAll(/^([A-Z][A-Z_0-9]*)=/gm),
  ].map((m) => m[1]);
  return Object.fromEntries(
    [...names, "PATH", "HOME", "TMPDIR"].flatMap((key) => {
      const value = source[key];
      return value === undefined ? [] : [[key, value]];
    }),
  );
}
export type ProcessRecord = {
  pid: number;
  entry: string;
  executable: string;
  /** Kernel start time (ps lstart) when the host exposes it; empty otherwise. */
  started: string;
  /**
   * Per-launch stdout/stderr file. The process we spawned is the only one that
   * holds this exact file open as fd 1/2, so it identifies the instance even
   * when executable and cwd are shared with unrelated scripts.
   */
  instance: string;
};
export type ProcessObservation = {
  /** ps: "executable entry". lsof fallback: "executable cwd". */
  command: string;
  /** ps lstart; empty when the host does not expose a start time. */
  started: string;
  /** lsof names of the process's fd 1/2 targets, when observable. */
  stdio?: string[];
};
const ENTRIES = ["server/src/production-entry.ts", "worker/src/index.ts"];
export function ownsProcess(
  saved: Omit<ProcessRecord, "pid">,
  current: ProcessObservation,
  root: string,
): boolean {
  if (!ENTRIES.some((f) => saved.entry === `${root}/${f}`)) return false;
  if (current.started && saved.started) {
    // Full argv plus the kernel start time identify the exact instance: a
    // reused PID cannot reproduce both.
    return (
      current.command === `${saved.executable} ${saved.entry}` &&
      current.started === saved.started
    );
  }
  // On hosts where ps is unavailable, lsof only shows the executable and the
  // working directory — identical for server, worker and any unrelated Bun
  // script in the same directory, so they cannot distinguish instances. The
  // per-launch stdout/stderr file can: refuse to signal when either the
  // record or the live process cannot be tied to it.
  if (!saved.instance || !current.stdio?.length) return false;
  return (
    current.command === `${saved.executable} ${root}/server` &&
    current.stdio.includes(saved.instance)
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
