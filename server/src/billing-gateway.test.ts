import { afterAll, describe, expect, test } from "bun:test";
import {
  BillingGatewayClient,
  BillingGatewayError,
  CORRELATION_HEADER,
  CORRELATION_PROP,
  correlationIdForRun,
  IDEMPOTENCY_KEY_HEADER,
  idempotencyKey,
  LEDGER_PATHS,
  newCorrelationId,
  perCallBillingEnabled,
  type ReservationRecord,
} from "./billing-gateway";

/*
 * What is proved here is the seam's own behaviour: the idempotency key, the correlation ID's
 * unguessability and scoping, and the client's contract against a ledger-shaped HTTP endpoint
 * (this test's own, holding no money). That a real ledger honours this contract is ticket #66's
 * delivery and is not claimed here; the end-to-end proof is the run this ticket exists for.
 */

const reserved: ReservationRecord = {
  reservationId: "res_1",
  correlationId: "corr_1",
  idempotencyKey: "run:call:1",
  unitPriceSnapshotId: "price_2026_11",
  maxAmount: 500,
  finalState: "reserved",
};

// A ledger-shaped endpoint: contract-faithful, but this test's own and holding nothing.
const calls: { path: string; key: string | null; body: unknown }[] = [];
let status = 200;
let responseBody: unknown = reserved;
const ledger = Bun.serve({
  port: 0,
  fetch: async (request) => {
    calls.push({
      path: new URL(request.url).pathname,
      key: request.headers.get(IDEMPOTENCY_KEY_HEADER),
      body: await request.json().catch(() => null),
    });
    return Response.json(responseBody, { status });
  },
});
afterAll(() => ledger.stop(true));

const client = () =>
  new BillingGatewayClient({
    baseUrl: ledger.url.origin,
    fetcher: fetch,
  });

const call = { runId: "run-1", callId: "call-1", attempt: 1 };
const actor = {
  ...call,
  ...{ userId: "user-1", paymentAccountId: "acct-1", botId: "bot-1" },
};

describe("idempotency key", () => {
  test("covers run, call and attempt, and no attempt twice shares one", () => {
    expect(idempotencyKey(call)).toBe("run-1:call-1:1");
    expect(idempotencyKey({ ...call, attempt: 2 })).toBe("run-1:call-1:2");
    expect(idempotencyKey({ ...call, callId: "call-2" })).not.toBe(
      idempotencyKey(call),
    );
    expect(idempotencyKey({ ...call, runId: "run-2" })).not.toBe(
      idempotencyKey(call),
    );
  });

  test("every ledger call carries it on the header", async () => {
    calls.length = 0;
    await client().reserve({
      ...actor,
      correlationId: "corr_1",
      unitPriceSnapshotId: "p",
      maxAmount: 1,
    });
    expect(calls[0]?.key).toBe("run-1:call-1:1");
    await client().verify("corr_1");
    expect(calls[1]?.key).toBe("corr_1");
    await client().settle({
      ...call,
      reservationId: "res_1",
      correlationId: "corr_1",
      actualInputTokens: 10,
      actualOutputTokens: 5,
      amount: 40,
    });
    expect(calls[2]?.key).toBe("run-1:call-1:1");
    await client().release({
      ...call,
      reservationId: "res_1",
      correlationId: "corr_1",
      reason: "unused",
    });
    expect(calls[3]?.key).toBe("run-1:call-1:1");
  });
});

describe("correlation id", () => {
  test("is unguessable and never repeats", () => {
    const seen = new Set<string>();
    for (let i = 0; i < 500; i++) {
      const id = newCorrelationId();
      expect(id).toMatch(/^[0-9a-f-]{36}$/);
      expect(seen.has(id)).toBe(false);
      seen.add(id);
    }
  });

  test("only the picked harness on a ledger deployment gets one", () => {
    const env = {
      OPENBOT_LEDGER_URL: "http://ledger.internal",
      PICKED_HARNESS_URL: "http://127.0.0.1:4202",
    };
    const id = correlationIdForRun("http://127.0.0.1:4202", env);
    expect(id).toBeDefined();
    // A trailing slash on either side is the same endpoint.
    expect(correlationIdForRun("http://127.0.0.1:4202/", env)).toBeDefined();
    // Any other endpoint, or a deployment without the ledger, runs as it does today.
    expect(correlationIdForRun("http://127.0.0.1:4212", env)).toBeUndefined();
    expect(correlationIdForRun(undefined, env)).toBeUndefined();
    expect(
      correlationIdForRun("http://127.0.0.1:4202", {
        PICKED_HARNESS_URL: "http://127.0.0.1:4202",
      }),
    ).toBeUndefined();
    expect(perCallBillingEnabled(env)).toBe(true);
    expect(perCallBillingEnabled({})).toBe(false);
  });
});

describe("the reservation contract", () => {
  test("reserve posts the whole reservation, actor apart from caller", async () => {
    calls.length = 0;
    const record = await client().reserve({
      ...actor,
      correlationId: "corr_1",
      unitPriceSnapshotId: "price_2026_11",
      maxAmount: 500,
    });
    expect(record.reservationId).toBe("res_1");
    expect(record.finalState).toBe("reserved");
    expect(calls).toHaveLength(1);
    expect(calls[0]?.path).toBe(LEDGER_PATHS.reserve);
    const body = calls[0]?.body as Record<string, unknown>;
    expect(body.userId).toBe("user-1");
    expect(body.paymentAccountId).toBe("acct-1");
    expect(body.botId).toBe("bot-1");
    expect(body.unitPriceSnapshotId).toBe("price_2026_11");
    expect(body.maxAmount).toBe(500);
  });

  test("verify asks by correlation id, so a released reservation refuses", async () => {
    status = 402;
    responseBody = { error: "no live reservation for this correlation id" };
    try {
      await client().verify("corr_gone");
      throw new Error("verify should have refused");
    } catch (error) {
      expect(error).toBeInstanceOf(BillingGatewayError);
      expect((error as BillingGatewayError).status).toBe(402);
      expect((error as BillingGatewayError).message).toContain("402");
      // The refusal says what the ledger said and nothing of ours: no credential in it.
      expect((error as BillingGatewayError).message).not.toMatch(
        /key|token|secret/i,
      );
    } finally {
      status = 200;
      responseBody = reserved;
    }
  });

  test("a ledger that answers with something else is refused, not trusted", async () => {
    responseBody = { ok: true };
    try {
      await client().verify("corr_1");
      throw new Error("a non-record answer should have been refused");
    } catch (error) {
      expect(error).toBeInstanceOf(BillingGatewayError);
    } finally {
      responseBody = reserved;
    }
  });

  test("a ledger that does not answer fails closed", async () => {
    const dead = new BillingGatewayClient({
      baseUrl: "http://127.0.0.1:1",
      timeoutMs: 300,
    });
    try {
      await dead.verify("corr_1");
      throw new Error("a dead ledger should have failed");
    } catch (error) {
      expect(error).toBeInstanceOf(BillingGatewayError);
      expect((error as BillingGatewayError).message).toContain(
        "did not answer",
      );
    }
  });

  test("no ledger configured fails closed before any request", async () => {
    const none = new BillingGatewayClient({ baseUrl: "" });
    try {
      await none.verify("corr_1");
      throw new Error("an unconfigured ledger should have failed");
    } catch (error) {
      expect(error).toBeInstanceOf(BillingGatewayError);
      expect((error as BillingGatewayError).message).toContain(
        "no billing ledger is configured",
      );
    }
  });

  test("a settled reservation reads back final through the lookup", async () => {
    responseBody = { ...reserved, settledAmount: 40, finalState: "settled" };
    const record = await client().getReservation("res_1");
    expect(record.finalState).toBe("settled");
    expect(record.settledAmount).toBe(40);
    responseBody = reserved;
  });
});

describe("the header the harness makes of it", () => {
  test("is the one the gateway checks, spelled the same on both sides", () => {
    expect(CORRELATION_PROP).toBe("openbotCorrelationId");
    expect(CORRELATION_HEADER).toBe("x-openbot-correlation-id");
  });
});
