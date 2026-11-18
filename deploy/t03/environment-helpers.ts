import { execFileSync } from "node:child_process";
import { FAULT_FILE, serverEnvironment } from "./environment";

export { FAULT_FILE, serverEnvironment };

export type ProcessRecord = {
  pid: number;
  entry: string;
  executable: string;
  /** The port this process was listening on when tracked, if it serves one. */
  port?: string;
};

/**
 * The executable paths behind a live PID.
 *
 * The kill-and-restart scenario signals real processes by number, so the check is load-bearing:
 * before signalling anything the launcher compares the executables the process is actually running
 * against what it recorded at spawn time. This host offers no `ps`, so the text sections of the
 * process's open files — the executable among them — are read with `lsof` instead.
 */
export function processExecutables(pid: number): string[] {
  try {
    const output = execFileSync(
      "lsof",
      ["-a", "-w", "-p", String(pid), "-d", "txt", "-Fn"],
      { encoding: "utf8" },
    );
    return output
      .split("\n")
      .filter((line) => line.startsWith("n/"))
      .map((line) => line.slice(1));
  } catch {
    return [];
  }
}

/**
 * Whether a saved PID still is the process this launcher started: the executable it is running
 * must be the interpreter this launcher used. A recycled PID whose executable differs refuses to
 * be signalled; a process that has already exited matches nothing and is skipped.
 */
export function ownsProcess(
  saved: Omit<ProcessRecord, "pid">,
  pid: number,
): boolean {
  return processExecutables(pid).includes(saved.executable);
}
