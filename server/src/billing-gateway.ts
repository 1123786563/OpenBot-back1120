/**
 * The seam between a run and the billing ledger, and the correlation ID that ties one model call
 * to its reservation.
 *
 * Two things live here, deliberately apart from any ledger implementation:
 *
 * - The correlation ID. Generated on the server per `agent/run`, unguessable, sent to the picked
 *   harness as `forwardedProps.openbotCorrelationId`, and turned by the harness into the
 *   `x-openbot-correlation-id` header of every model request it makes. The gateway checks a
 *   reservation by it before the request reaches a provider; a caller who cannot present one is
 *   refused at the gateway, before any provider is asked for anything.
 *
 * - The client for the ledger's reservation contract: reserve, verify, settle, release, and the
 *   lookup a crash or a timeout recovers with. The contract's shape is fixed here so the ledger
 *   behind it can be swapped in without touching the run path. Today nothing in this deployment
 *   serves it — the production ledger is ticket #66's delivery, and the trusted payment account
 *   it reserves against is #67's — so every method below failing closed is the correct behaviour
 *   until that ledger exists.
 *
 * Its own module with no imports, so the run path and the tests pay nothing for the rest of the
 * server, and so a test can point it at any ledger-shaped HTTP endpoint.
 */

/**
 * Who pays and who acts, carried on every ledger call. `userId` is who is operating;
 * `paymentAccountId` is who the money leaves. They are resolved on this side from the trusted
 * session and payment context — never taken from a request body — and are kept apart so an audit
 * row can name both.
 */
export type BillingActor = {
  userId: string;
  paymentAccountId: string;
  botId: string;
};

/** One attempt at one model call inside one run. `attempt` starts at 1 and counts every retry. */
export type BillingCall = {
  runId: string;
  callId: string;
  attempt: number;
};

/** The idempotency key every ledger call for one attempt carries. */
export function idempotencyKey(call: BillingCall): string {
  return `${call.runId}:${call.callId}:${call.attempt}`;
}

/**
 * The correlation ID a run is given: a UUIDv4 from the platform's own source. Unguessable is the
 * requirement — a reservation is confirmed by presenting it, so an enumerable ID would let a
 * caller spend somebody else's reservation.
 */
export function newCorrelationId(): string {
  return crypto.randomUUID();
}

/** What a reservation locks in: who, what call, and the largest amount it may settle. */
export type ReservationRequest = BillingActor &
  BillingCall & {
    correlationId: string;
    /** The pricing version the settlement is charged on, locked at reserve time. */
    unitPriceSnapshotId: string;
    /** The most the reservation may settle, in the ledger's smallest currency unit. */
    maxAmount: number;
  };

/** A reservation as the ledger holds it. `finalState` is what a recovery lookup asks for. */
export type ReservationRecord = {
  reservationId: string;
  correlationId: string;
  idempotencyKey: string;
  unitPriceSnapshotId: string;
  maxAmount: number;
  settledAmount?: number;
  finalState: "reserved" | "settled" | "released" | "expired";
};

/** The ledger endpoint paths this client speaks, in one place so both sides move together. */
export const LEDGER_PATHS = {
  reserve: "/api/internal/billing/reservations/reserve",
  verify: "/api/internal/billing/reservations/verify",
  settle: "/api/internal/billing/reservations/settle",
  release: "/api/internal/billing/reservations/release",
} as const;

/** The header an idempotent ledger call carries its key on. */
export const IDEMPOTENCY_KEY_HEADER = "idempotency-key";

/**
 * Where the ledger is found, from this deployment's environment. Empty means this deployment has
 * no ledger: the run path must then behave as it does today, and the gateway must refuse every
 * model request, rather than both letting one through ungoverned.
 */
export function ledgerBaseUrl(
  environment: Record<string, string | undefined> = process.env,
): string {
  return environment.OPENBOT_LEDGER_URL?.trim().replace(/\/+$/, "") ?? "";
}

/**
 * Whether per-call verification is switched on for this deployment: only when a ledger is named.
 * Kept as its own switch so the harness and gateway can be rehearsed against a ledger without the
 * run path's other behaviour moving.
 */
export function perCallBillingEnabled(
  environment: Record<string, string | undefined> = process.env,
): boolean {
  return ledgerBaseUrl(environment) !== "";
}

/**
 * The client for the reservation contract. Every call is a POST (or GET for the lookup) with an
 * idempotency key, and every failure is an exception whose message says what the ledger said and
 * nothing else — no credential, no request body — so a log line can be shown to a person.
 */
export class BillingGatewayClient {
  private readonly base: string;
  private readonly timeoutMs: number;
  private readonly fetcher: typeof fetch;

  constructor(
    options: {
      baseUrl?: string;
      timeoutMs?: number;
      fetcher?: typeof fetch;
    } = {},
  ) {
    this.base = (options.baseUrl ?? ledgerBaseUrl()).replace(/\/+$/, "");
    this.timeoutMs = options.timeoutMs ?? 5_000;
    this.fetcher = options.fetcher ?? fetch;
  }

  /** Reserve before the first model request of one attempt. */
  async reserve(request: ReservationRequest): Promise<ReservationRecord> {
    return this.post(LEDGER_PATHS.reserve, request, idempotencyKey(request));
  }

  /**
   * Confirm a reservation is still live, by correlation ID alone. This is what the gateway calls
   * before every provider request; a reservation already settled, released or expired refuses
   * here, and the provider is never asked.
   */
  async verify(correlationId: string): Promise<{ reservationId: string }> {
    return this.post(LEDGER_PATHS.verify, { correlationId }, correlationId);
  }

  /** Settle what one attempt actually used, on the price the reservation locked. */
  async settle(
    input: { reservationId: string; correlationId: string } & BillingCall & {
        actualInputTokens: number;
        actualOutputTokens: number;
        amount: number;
      },
  ): Promise<ReservationRecord> {
    return this.post(LEDGER_PATHS.settle, input, idempotencyKey(input));
  }

  /** Give back what an attempt did not use. Released is final: a later verify refuses. */
  async release(
    input: {
      reservationId: string;
      correlationId: string;
      reason: string;
    } & BillingCall,
  ): Promise<ReservationRecord> {
    return this.post(LEDGER_PATHS.release, input, idempotencyKey(input));
  }

  /**
   * What became of a reservation, for the crash or timeout that leaves one's end unknown. The
   * lookup is what a restart runs before deciding whether a settle is still owed.
   */
  async getReservation(reservationId: string): Promise<ReservationRecord> {
    if (!this.base) {
      throw new BillingGatewayError(
        "no billing ledger is configured for this deployment",
      );
    }
    const response = await this.fetcher(
      `${this.base}${LEDGER_PATHS.reserve}/${encodeURIComponent(reservationId)}`,
      {
        signal: AbortSignal.timeout(this.timeoutMs),
      },
    );
    return this.read(response, `lookup ${reservationId}`);
  }

  private async post(
    path: string,
    body: unknown,
    key: string,
  ): Promise<ReservationRecord> {
    if (!this.base) {
      // No ledger configured: refuse, rather than let a call through as if it had been reserved.
      throw new BillingGatewayError(
        "no billing ledger is configured for this deployment",
      );
    }
    let response: Response;
    try {
      response = await this.fetcher(`${this.base}${path}`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          [IDEMPOTENCY_KEY_HEADER]: key,
        },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(this.timeoutMs),
      });
    } catch (error) {
      throw new BillingGatewayError(
        `the billing ledger did not answer (${error instanceof Error ? error.name : "unknown error"})`,
      );
    }
    return this.read(response, `${path} ${key}`);
  }

  /** The ledger's own record, or an error that carries its status and nothing of ours. */
  private async read(
    response: Response,
    what: string,
  ): Promise<ReservationRecord> {
    const text = await response.text().catch(() => "");
    if (!response.ok) {
      throw new BillingGatewayError(
        `the billing ledger refused ${what} with ${response.status}`,
        response.status,
      );
    }
    try {
      const parsed = JSON.parse(text) as ReservationRecord;
      if (
        !parsed ||
        typeof parsed.reservationId !== "string" ||
        !parsed.finalState
      ) {
        throw new Error("not a reservation record");
      }
      return parsed;
    } catch {
      throw new BillingGatewayError(
        `the billing ledger answered ${what} with a body that is not a reservation record`,
        response.status,
      );
    }
  }
}

/** What the run path and the gateway both see when the ledger will not have a call. */
export class BillingGatewayError extends Error {
  constructor(
    message: string,
    readonly status?: number,
  ) {
    super(message);
    this.name = "BillingGatewayError";
  }
}

/**
 * The correlation ID this run is sent to the picked harness under, or none: only when per-call
 * billing is on for this deployment and the endpoint is the picked harness that takes the
 * deployment's model choice. Anything else is untouched, so a deployment without a gateway runs
 * exactly as it does today.
 */
export function correlationIdForRun(
  endpoint: string | null | undefined,
  environment: Record<string, string | undefined> = process.env,
): string | undefined {
  if (!perCallBillingEnabled(environment)) return undefined;
  if (!endpoint?.trim()) return undefined;
  const picked = environment.PICKED_HARNESS_URL?.trim();
  if (
    !picked ||
    endpoint.trim().replace(/\/+$/, "") !== picked.replace(/\/+$/, "")
  ) {
    return undefined;
  }
  return newCorrelationId();
}

/** The forwardedProps key the correlation ID travels under, and the header the harness makes of it. */
export const CORRELATION_PROP = "openbotCorrelationId";
export const CORRELATION_HEADER = "x-openbot-correlation-id";
