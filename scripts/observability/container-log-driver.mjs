/**
 * Run a process outside Docker but give it Docker's json-file log stream.
 *
 * Docker writes each container's stdout/stderr to
 * `/var/lib/docker/containers/<id>/<id>-json.log`, one JSON object per line:
 *
 *   {"log":"line\n","stream":"stdout","time":"2026-11-17T12:00:00.000000000Z"}
 *
 * `docker/observability/otel-collector.yaml` parses exactly that envelope. In a deployment
 * without a Docker daemon — the reproducible verification in
 * `scripts/observability/verify-openobserve.sh`, or a host running the server and worker as bare
 * processes — this script produces the same envelope for a real process, so the collector's
 * parsing, attribution and redaction run unchanged. It is verification plumbing, not part of any
 * runtime deployment: under Compose, Docker writes the envelope itself.
 *
 * Usage: bun scripts/observability/container-log-driver.mjs <log-file> <command> [args...]
 * The child's exit code is this process's exit code. Both streams are line-buffered the way the
 * json-file driver buffers them; a final line without its newline still lands.
 */
import { spawn } from "node:child_process";
import { createWriteStream, mkdirSync } from "node:fs";
import { dirname } from "node:path";

const [, , logFile, command, ...args] = process.argv;
if (!logFile || !command) {
  console.error(
    "usage: container-log-driver.mjs <log-file> <command> [args...]",
  );
  process.exit(2);
}

mkdirSync(dirname(logFile), { recursive: true });
const sink = createWriteStream(logFile, { flags: "a" });

function emit(line, streamName) {
  sink.write(
    `${JSON.stringify({
      log: `${line}\n`,
      stream: streamName,
      time: new Date().toISOString(),
    })}\n`,
  );
}

/** Split a chunked stream into lines the way Docker does before writing its envelope. */
function pipe(source, streamName) {
  let buffer = "";
  source.setEncoding("utf8");
  source.on("data", (chunk) => {
    buffer += chunk;
    let newline = buffer.indexOf("\n");
    while (newline >= 0) {
      emit(buffer.slice(0, newline), streamName);
      buffer = buffer.slice(newline + 1);
      newline = buffer.indexOf("\n");
    }
  });
  source.on("end", () => {
    if (buffer !== "") emit(buffer, streamName);
  });
}

const child = spawn(command, args, {
  stdio: ["ignore", "pipe", "pipe"],
  env: process.env,
});
pipe(child.stdout, "stdout");
pipe(child.stderr, "stderr");
child.on("exit", (code, signal) => {
  sink.end();
  process.exitCode = signal ? 1 : (code ?? 0);
});
