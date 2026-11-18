import { existsSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { APIError } from "better-auth/api";

/**
 * One-shot initialization faults and a rendezvous barrier, for the T03 verification only.
 *
 * Casdoor T03 has to prove that a concurrent first sign-in, or one that dies halfway through
 * initialization, still converges on exactly one user and one personal workspace. Proving that
 * needs the real server code to fail — not a mocked API — at chosen moments: before the user row
 * is written, after the identity is committed but before the workspace exists, and so on. This
 * module is where those moments live.
 *
 * It is inert unless `OPENBOT_TEST_FAULT_FILE` names a private, readable file that only the test
 * launcher writes. No deployment sets that variable, no request can create or steer a fault, and
 * the file is consumed (never re-fired) after a hit, so a retry is a normal sign-in. What it may
 * ask for:
 *
 *   {"mode":"fault","point":"before-user-insert","remaining":1}
 *   {"mode":"barrier","point":"user-create","parties":2}
 *
 * A `fault` hit throws one retryable `SERVICE_UNAVAILABLE`; the OAuth callback already turns every
 * thrown error into the same safe "sign-in was cancelled or could not finish" page, so the person
 * is told to try again and nothing internal is shown. A `barrier` holds the first arrivals until
 * the requested number has reached the same point in the real code path, then releases them all at
 * once — that is how two genuinely independent clients are made to overlap inside the write, with
 * the overlap visible to the verification in the log lines below.
 */

export type InitializationFaultSpec =
  | { mode: "fault"; point: string; remaining: number }
  | { mode: "barrier"; point: string; parties: number };

/** The points the sign-in path asks about, so a typo in the file fails loudly instead of silently. */
export const INITIALIZATION_FAULT_POINTS = [
  "before-user-insert",
  "user-committed",
  "before-workspace-ensure",
  "workspace-ensured",
  "session-committed",
] as const;
export type InitializationFaultPoint =
  (typeof INITIALIZATION_FAULT_POINTS)[number];

/**
 * Raised for both a fault hit and a barrier timeout: safe to show, safe to retry. The callback
 * route turns any thrown error into the same recoverable sign page, so the message travels only
 * to the log, never to the browser.
 */
export class InitializationRetryableError extends APIError {
  readonly point: string;
  constructor(point: string) {
    super("SERVICE_UNAVAILABLE", {
      message: "AUTH_INITIALIZATION_RETRYABLE",
      code: "AUTH_INITIALIZATION_RETRYABLE",
    });
    this.point = point;
  }
}

function faultFile(): string | undefined {
  const path = process.env.OPENBOT_TEST_FAULT_FILE?.trim();
  return path ? path : undefined;
}

export function initializationFaultControlEnabled(): boolean {
  return faultFile() !== undefined;
}

function readSpec(file: string): InitializationFaultSpec | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(file, "utf8"));
  } catch {
    // Missing or unreadable file: no fault is armed. A malformed file must not take sign-in
    // down with it, so it is reported and ignored.
    return null;
  }
  if (!parsed || typeof parsed !== "object") return null;
  const spec = parsed as Record<string, unknown>;
  const point = typeof spec.point === "string" ? spec.point : undefined;
  if (!point) return null;
  if (spec.mode === "fault") {
    const remaining = typeof spec.remaining === "number" ? spec.remaining : 1;
    return { mode: "fault", point, remaining };
  }
  if (spec.mode === "barrier") {
    const parties = typeof spec.parties === "number" ? spec.parties : 0;
    if (parties < 1) return null;
    return { mode: "barrier", point, parties };
  }
  return null;
}

let barrier: {
  point: string;
  arrived: number;
  release: () => void;
  promise: Promise<void>;
} | null = null;

/**
 * Ask whether the flow at `point` should now fail or wait. Consumes a one-shot fault, so the same
 * spec never fires twice — a retry after it is an ordinary, fault-free sign-in.
 */
export async function initializationFault(point: string): Promise<void> {
  const file = faultFile();
  if (!file) return;
  const spec = readSpec(file);
  if (!spec || spec.point !== point) return;

  if (spec.mode === "barrier") {
    await initializationBarrier(point, spec.parties);
    return;
  }

  if (spec.remaining > 1) {
    writeFileSync(
      file,
      `${JSON.stringify({ mode: "fault", point, remaining: spec.remaining - 1 })}\n`,
      { mode: 0o600 },
    );
    console.log(
      JSON.stringify({
        type: "initialization-fault-armed",
        point,
        remaining: spec.remaining - 1,
      }),
    );
    return;
  }
  try {
    if (existsSync(file)) unlinkSync(file);
  } catch {
    // Already gone: the one-shot consumed itself.
  }
  console.log(
    JSON.stringify({
      type: "initialization-fault-hit",
      point,
      at: new Date().toISOString(),
    }),
  );
  throw new InitializationRetryableError(point);
}

/**
 * Hold arrivals until `parties` requests have reached this point in the same process, then let all
 * of them through together. Thirty seconds alone is a failing scenario, not a hanging server.
 */
export async function initializationBarrier(
  point: string,
  parties: number,
): Promise<void> {
  const arrivedAt = new Date().toISOString();
  if (parties <= 1) {
    console.log(
      JSON.stringify({ type: "initialization-barrier-single", point, arrivedAt }),
    );
    return;
  }
  if (!barrier || barrier.point !== point) {
    let release: () => void = () => {};
    const promise = new Promise<void>((resolve) => {
      release = resolve;
    });
    barrier = { point, arrived: 1, release, promise };
    console.log(
      JSON.stringify({
        type: "initialization-barrier-waiting",
        point,
        parties,
        arrivedAt,
      }),
    );
    await waitWithTimeout(promise, point, parties);
    return;
  }
  barrier.arrived += 1;
  console.log(
    JSON.stringify({
      type: "initialization-barrier-arrived",
      point,
      arrived: barrier.arrived,
      parties,
      arrivedAt,
    }),
  );
  if (barrier.arrived >= parties) {
    console.log(
      JSON.stringify({
        type: "initialization-barrier-open",
        point,
        parties,
        at: new Date().toISOString(),
      }),
    );
    const open = barrier;
    barrier = null;
    open.release();
    return;
  }
  await waitWithTimeout(barrier.promise, point, parties);
}

async function waitWithTimeout(
  promise: Promise<void>,
  point: string,
  parties: number,
) {
  const timeout = new Promise<never>((_, reject) => {
    setTimeout(
      () => reject(new InitializationRetryableError(`${point}-barrier-timeout`)),
      30_000,
    ).unref();
  });
  try {
    await Promise.race([promise, timeout]);
  } catch (error) {
    // Nobody else arrived: let this caller fail safely and drop the barrier so the next
    // sign-in is not held by a rendezvous that will never complete.
    if (barrier?.point === point) {
      barrier.release();
      barrier = null;
    }
    console.log(
      JSON.stringify({
        type: "initialization-barrier-expired",
        point,
        parties,
        at: new Date().toISOString(),
      }),
    );
    throw error;
  }
}
