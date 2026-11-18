/**
 * #64 isolated internal HTTP entry — the contract's /internal/v1/billing
 * paths, mounted ONLY by `isolated-main.ts` inside the dedicated compose
 * environment (no published host port, dedicated network). The production
 * server does NOT mount these routes in this ticket; formal identity
 * mounting belongs to #67.
 *
 * Every write requires ServiceCredentialAuth + Idempotency-Key; every error
 * is problem+json with a closed error code; unknown request fields are
 * rejected (contract additionalProperties: false).
 */
import { Hono } from "hono";
import { randomUUID } from "node:crypto";
import { CredentialResolver } from "./auth.js";
import {
  BillingLedger,
  decodeCursor,
  ERROR_STATUS,
  ID_RE,
  LedgerError,
  SCHEMA_VERSION,
  UUID_RE,
} from "./service.js";

const CAPABILITY_BY_OPERATION: Record<string, string> = {
  registerBillingAccount: "billing:register-account",
  createCreditGrant: "billing:grant",
  createAdjustment: "billing:adjust",
};

/** Exactly the contract's fields, nothing else: unknown fields are rejected. */
const REQUEST_FIELDS: Record<string, { required: string[]; nullable: Set<string>; known: string[] }> = {
  registerBillingAccount: {
    required: ["organization_id", "owner_subject_id", "personal_workspace_id"],
    nullable: new Set(),
    known: ["organization_id", "owner_subject_id", "personal_workspace_id"],
  },
  createCreditGrant: {
    required: [
      "billing_account_id",
      "source_event_id",
      "source_type",
      "granted_microcredits",
      "valid_from_us",
      "actor_subject_id",
    ],
    nullable: new Set(["source_period_id", "expires_at_us", "original_event_id"]),
    known: [
      "billing_account_id",
      "source_event_id",
      "source_type",
      "source_period_id",
      "granted_microcredits",
      "valid_from_us",
      "expires_at_us",
      "original_event_id",
      "actor_subject_id",
    ],
  },
  createAdjustment: {
    required: [
      "billing_account_id",
      "original_event_id",
      "adjustment_type",
      "source_event_id",
      "signed_delta_microcredits",
      "reason",
      "actor_subject_id",
      "effective_at_us",
    ],
    nullable: new Set(["original_period_id"]),
    known: [
      "billing_account_id",
      "original_event_id",
      "adjustment_type",
      "source_event_id",
      "signed_delta_microcredits",
      "reason",
      "actor_subject_id",
      "original_period_id",
      "effective_at_us",
    ],
  },
};

function problem(code: LedgerError["code"], detail: string, retryAfter?: number) {
  const status = ERROR_STATUS[code];
  const headers: Record<string, string> = { "Content-Type": "application/problem+json" };
  if (code === "idempotency_in_progress") {
    headers["Retry-After"] = String(retryAfter ?? 1);
  }
  return new Response(
    JSON.stringify({
      type: `https://billing.openbot.invalid/problems/${code}`,
      title: code,
      status,
      detail,
      request_id: randomUUID(),
    }),
    { status, headers },
  );
}

export interface RouteEnv {
  ledger: BillingLedger;
  resolver: CredentialResolver;
  cursorSecret: string;
}

function jsonOf(v: unknown, status: number): Response {
  return new Response(JSON.stringify(v, (_, x) => (typeof x === "bigint" ? String(x) : x)), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

export function createLedgerRoutes(env: RouteEnv): Hono {
  const app = new Hono();

  const readKey = (header: string | undefined): string => {
    if (!header)
      throw new LedgerError(
        "missing_idempotency_key",
        "Idempotency-Key is required on every business write",
      );
    return header;
  };

  const parseBody = async (c: { req: { text(): Promise<string> } }): Promise<Record<string, unknown>> => {
    let parsed: unknown;
    try {
      parsed = JSON.parse(await c.req.text());
    } catch {
      throw new LedgerError("invalid_integer", "request body is not valid JSON");
    }
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed))
      throw new LedgerError("invalid_integer", "request body must be a JSON object");
    return parsed as Record<string, unknown>;
  };

  const checkShape = (operation: string, body: Record<string, unknown>): void => {
    const spec = REQUEST_FIELDS[operation]!;
    for (const key of Object.keys(body)) {
      if (!spec.known.includes(key))
        throw new LedgerError("invalid_integer", `unknown request field ${key}`);
    }
    for (const field of spec.required) {
      const v = body[field];
      if (!(field in body))
        throw new LedgerError("invalid_integer", `missing required field ${field}`);
      if (v === null && !spec.nullable.has(field))
        throw new LedgerError("invalid_integer", `field ${field} is not nullable`);
    }
  };

  const uuidOr = (v: string, code: LedgerError["code"] = "invalid_integer"): string => {
    if (!UUID_RE.test(v)) throw new LedgerError(code, "expected a uuid");
    return v;
  };

  const intParam = (v: string | undefined, name: string): bigint | null => {
    if (v === undefined) return null;
    if (!/^(0|[1-9][0-9]{0,17})$/.test(v))
      throw new LedgerError("out_of_range", `${name} violates the timestamp lexical rule`);
    return BigInt(v);
  };

  // ------------------------------------------------------------ registration
  app.post("/internal/v1/billing/accounts", async (c) => {
    try {
      const cred = env.resolver.authenticate(c.req.header("authorization"));
      env.resolver.requireCapability(cred, CAPABILITY_BY_OPERATION.registerBillingAccount!);
      const key = readKey(c.req.header("idempotency-key"));
      const body = await parseBody(c);
      checkShape("registerBillingAccount", body);
      const organizationId = uuidOr(String(body.organization_id));
      // Registration is organization-scoped only: the credential may register
      // accounts for its own organization and no other.
      if (cred.organizationId !== organizationId)
        throw new LedgerError("resource_not_found", "registration outside the credential organization scope");
      const result = await env.ledger.registerAccount(
        {
          organizationId,
          ownerSubjectId: String(body.owner_subject_id),
          personalWorkspaceId: String(body.personal_workspace_id),
        },
        { key, requestId: randomUUID() },
      );
      return jsonOf(result.body, result.status);
    } catch (e) {
      return ledgerProblem(e);
    }
  });

  // ---------------------------------------------------------------- grants
  app.post("/internal/v1/billing/credit-grants", async (c) => {
    try {
      const cred = env.resolver.authenticate(c.req.header("authorization"));
      env.resolver.requireCapability(cred, CAPABILITY_BY_OPERATION.createCreditGrant!);
      const key = readKey(c.req.header("idempotency-key"));
      const body = await parseBody(c);
      checkShape("createCreditGrant", body);
      const accountId = uuidOr(String(body.billing_account_id));
      env.resolver.requireAccountScope(cred, cred.organizationId, accountId);
      const result = await env.ledger.createGrant(cred, body, { key, requestId: randomUUID() });
      return jsonOf(result.body, result.status);
    } catch (e) {
      return ledgerProblem(e);
    }
  });

  // ----------------------------------------------------------- adjustments
  app.post("/internal/v1/billing/adjustments", async (c) => {
    try {
      const cred = env.resolver.authenticate(c.req.header("authorization"));
      env.resolver.requireCapability(cred, CAPABILITY_BY_OPERATION.createAdjustment!);
      const key = readKey(c.req.header("idempotency-key"));
      const body = await parseBody(c);
      checkShape("createAdjustment", body);
      const accountId = uuidOr(String(body.billing_account_id));
      env.resolver.requireAccountScope(cred, cred.organizationId, accountId);
      const result = await env.ledger.createAdjustment(cred, body, { key, requestId: randomUUID() });
      return jsonOf(result.body, result.status);
    } catch (e) {
      return ledgerProblem(e);
    }
  });

  // ----------------------------------------------------------------- reads
  const readPage = (c: { req: { query(name: string): string | undefined } }) => {
    const limitRaw = c.req.query("limit");
    let limit = 50;
    if (limitRaw !== undefined) {
      if (!/^(0|[1-9][0-9]{0,3})$/.test(limitRaw))
        throw new LedgerError("out_of_range", "limit outside 0..999");
      limit = Number(limitRaw);
    }
    const cursorRaw = c.req.query("cursor");
    const cursor = cursorRaw === undefined ? null : decodeCursor(cursorRaw, env.cursorSecret);
    return {
      limit,
      cursor,
      fromUs: intParam(c.req.query("from_us"), "from_us"),
      toUs: intParam(c.req.query("to_us"), "to_us"),
    };
  };

  const scopeOf = (c: { req: { query(name: string): string | undefined; header(n: string): string | undefined } }) => {
    const cred = env.resolver.authenticate(c.req.header("authorization"));
    env.resolver.requireCapability(cred, "billing:read");
    return cred;
  };

  const checkCursorScope = (
    credOrganizationId: string,
    accountId: string,
    page: { cursor: { organization_id: string; billing_account_id: string } | null },
  ): void => {
    const cur = page.cursor;
    if (cur && (cur.organization_id !== credOrganizationId || cur.billing_account_id !== accountId))
      throw new LedgerError("invalid_cursor", "cursor belongs to a different organization or account scope");
  };

  app.get("/internal/v1/billing/accounts/:id", async (c) => {
    try {
      const cred = scopeOf(c);
      const accountId = uuidOr(c.req.param("id"), "resource_not_found");
      env.resolver.requireAccountScope(cred, cred.organizationId, accountId);
      const snapshot = await env.ledger.accountSnapshot(cred.organizationId, accountId);
      return jsonOf(snapshot, 200);
    } catch (e) {
      return ledgerProblem(e);
    }
  });

  app.get("/internal/v1/billing/credit-lots", async (c) => {
    try {
      const cred = scopeOf(c);
      const accountId = uuidOr(c.req.query("billing_account_id") ?? "", "resource_not_found");
      env.resolver.requireAccountScope(cred, cred.organizationId, accountId);
      const page = readPage(c);
      checkCursorScope(cred.organizationId, accountId, page);
      return jsonOf(
        await env.ledger.listCreditLots(cred.organizationId, accountId, page, env.cursorSecret),
        200,
      );
    } catch (e) {
      return ledgerProblem(e);
    }
  });

  app.get("/internal/v1/billing/adjustments", async (c) => {
    try {
      const cred = scopeOf(c);
      const accountId = uuidOr(c.req.query("billing_account_id") ?? "", "resource_not_found");
      env.resolver.requireAccountScope(cred, cred.organizationId, accountId);
      const page = readPage(c);
      checkCursorScope(cred.organizationId, accountId, page);
      return jsonOf(
        await env.ledger.listAdjustments(cred.organizationId, accountId, page, env.cursorSecret),
        200,
      );
    } catch (e) {
      return ledgerProblem(e);
    }
  });

  app.get("/internal/v1/billing/accounts/:id/ledger-events", async (c) => {
    try {
      const cred = scopeOf(c);
      const accountId = uuidOr(c.req.param("id"), "resource_not_found");
      env.resolver.requireAccountScope(cred, cred.organizationId, accountId);
      const page = readPage(c);
      checkCursorScope(cred.organizationId, accountId, page);
      return jsonOf(
        await env.ledger.listLedgerEvents(cred.organizationId, accountId, page, env.cursorSecret),
        200,
      );
    } catch (e) {
      return ledgerProblem(e);
    }
  });

  function ledgerProblem(e: unknown): Response {
    if (e instanceof LedgerError) return problem(e.code, e.message, e.retryAfterSeconds);
    // Storage could not reliably commit: 503, never an in-memory success.
    return problem(
      "ledger_unavailable",
      `the ledger could not durably process this request: ${e instanceof Error ? e.message : String(e)}`,
    );
  }

  return app;
}

// Identifier lexical rule is exported for the isolated driver's own parsing.
export { ID_RE, SCHEMA_VERSION };
