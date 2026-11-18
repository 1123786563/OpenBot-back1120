import { readFileSync } from "node:fs";

export function serverEnvironment(
  source: Record<string, string | undefined>,
): Record<string, string> {
  if (source.OPENBOT_ORGANIZATION_AUTH_URL?.trim())
    throw new Error("T01 must use its own Casdoor authority");
  const names = [
    ...readFileSync(
      new URL(".env.t01.example", import.meta.url),
      "utf8",
    ).matchAll(/^([A-Z][A-Z_0-9]*)=/gm),
  ].map((m) => m[1]);
  return Object.fromEntries(
    [...names, "PATH", "HOME", "TMPDIR"]
      .filter((k) => source[k] !== undefined)
      .map((k) => [k, source[k]!]),
  );
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
