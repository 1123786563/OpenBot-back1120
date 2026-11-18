/**
 * Internal billing catalog HTTP surface (#65): the four trusted read-only
 * operations of the billing contract, as one Hono sub-app.
 *
 * Not browser-reachable: every route demands a trusted service credential
 * (`Authorization: Bearer`, verified by the injected verifier) under the
 * /internal prefix; CORS is not access control. The organization/account scope
 * is resolved server-side by the credential verifier from the trusted
 * credential context — the request body never designates a caller.
 *
 * These operations have NO write side effects (quotes are observations; they
 * occupy no purchase eligibility and pin nothing), which the contract marks
 * with x-readonly: true; error answers use application/problem+json.
 */

import { type Context, Hono } from "hono";
import type { ContentfulStatusCode } from "hono/utils/http-status";
import type {
  BillingCatalogService,
  CatalogServiceError,
  ProductQuote,
} from "./service";

type CatalogEnv = { Variables: { trustedOrganizationId: string } };

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const DECIMAL_RE = /^(0|[1-9][0-9]{0,18})$/;
const SMALL_INDEX_RE = /^(0|[1-9][0-9]{0,9})$/;
const PRODUCT_ID_RE = /^[A-Za-z0-9._:-]{1,128}$/;

export interface TrustedCredentialVerifierResult {
  ok: boolean;
  /** The organization the credential is bound to, when ok. */
  organizationId?: string;
}

export function createBillingCatalogRoutes(deps: {
  service: BillingCatalogService;
  /** Verifies the service credential and resolves the trusted organization scope. */
  verifyCredential: (
    authorizationHeader: string | undefined,
  ) => TrustedCredentialVerifierResult;
}) {
  const routes = new Hono<CatalogEnv>();

  function problem(
    c: Context<CatalogEnv>,
    status: ContentfulStatusCode,
    code: string,
    detail: string,
    fieldErrors?: { field: string; issue: string }[],
  ): Response {
    return c.json(
      {
        type: `https://openbot.dev/billing/errors/${code}`,
        title: problemTitle(code),
        status,
        detail,
        instance: c.req.path,
        code,
        request_id: crypto.randomUUID(),
        ...(fieldErrors ? { field_errors: fieldErrors } : {}),
      },
      status,
    );
  }

  function fail(c: Parameters<typeof problem>[0], e: unknown): Response {
    const err = e as CatalogServiceError;
    if (err && err.name === "CatalogServiceError") {
      return problem(
        c,
        err.status as ContentfulStatusCode,
        err.code,
        err.message,
        err.field ? [{ field: err.field, issue: err.code }] : undefined,
      );
    }
    return problem(
      c,
      503,
      "ledger_unavailable",
      `catalog storage unavailable: ${e instanceof Error ? e.message : String(e)}`,
    );
  }

  // Every route: trusted service credential, server-resolved organization.
  routes.use("*", async (c, next) => {
    const verdict = deps.verifyCredential(c.req.header("authorization"));
    if (!verdict.ok || !verdict.organizationId) {
      return problem(
        c,
        401,
        "unauthenticated",
        "No or invalid trusted service credential.",
      );
    }
    c.set("trustedOrganizationId", verdict.organizationId);
    await next();
  });

  async function readJson(
    c: Context<CatalogEnv>,
  ): Promise<Record<string, unknown> | Response> {
    try {
      const body = (await c.req.json()) as unknown;
      if (!body || typeof body !== "object" || Array.isArray(body)) {
        throw new Error("not an object");
      }
      return body as Record<string, unknown>;
    } catch {
      return problem(
        c,
        400,
        "invalid_integer",
        "request body must be a JSON object",
        [{ field: "body", issue: "not_json_object" }],
      );
    }
  }

  // ------------------------------------------------------------ product quote
  routes.post("/internal/v1/billing/product-quotes", async (c) => {
    const body = await readJson(c);
    if (body instanceof Response) return body;
    const organizationId = c.get("trustedOrganizationId");
    const rawAccount = body.billing_account_id;
    if (rawAccount !== undefined && rawAccount !== null) {
      if (typeof rawAccount !== "string" || !UUID_RE.test(rawAccount)) {
        return problem(
          c,
          422,
          "invalid_integer",
          "billing_account_id must be a UUID or null",
          [{ field: "billing_account_id", issue: "not_a_uuid" }],
        );
      }
    }
    const productId = body.product_id;
    if (typeof productId !== "string" || !PRODUCT_ID_RE.test(productId)) {
      return problem(
        c,
        422,
        "out_of_range",
        "product_id must match ^[A-Za-z0-9._:-]{1,128}$",
        [{ field: "product_id", issue: "invalid_product_id" }],
      );
    }
    const action = body.action;
    if (
      action !== "initial_purchase" &&
      action !== "renewal" &&
      action !== "change_tier"
    ) {
      return problem(
        c,
        422,
        "out_of_range",
        "action must be initial_purchase, renewal or change_tier",
        [{ field: "action", issue: "invalid_action" }],
      );
    }
    const expected = body.expected_price_version_id;
    if (
      expected !== undefined &&
      (typeof expected !== "string" || !UUID_RE.test(expected))
    ) {
      return problem(
        c,
        422,
        "invalid_integer",
        "expected_price_version_id must be a UUID",
        [{ field: "expected_price_version_id", issue: "not_a_uuid" }],
      );
    }
    try {
      const quote = await deps.service.quoteProduct({
        organizationId,
        billingAccountId: typeof rawAccount === "string" ? rawAccount : null,
        productId,
        action,
        expectedPriceVersionId:
          typeof expected === "string" ? expected : undefined,
      });
      return c.json(serializeQuote(quote));
    } catch (e) {
      return fail(c, e);
    }
  });

  // -------------------------------------------------------------- step quote
  routes.post("/internal/v1/billing/step-quotes", async (c) => {
    const body = await readJson(c);
    if (body instanceof Response) return body;
    const organizationId = c.get("trustedOrganizationId");
    const priceVersionId = body.price_version_id;
    if (typeof priceVersionId !== "string" || !UUID_RE.test(priceVersionId)) {
      return problem(
        c,
        422,
        "invalid_integer",
        "price_version_id must be a UUID",
        [{ field: "price_version_id", issue: "not_a_uuid" }],
      );
    }
    const resources = body.resources;
    const linesOk =
      Array.isArray(resources) &&
      resources.length > 0 &&
      (resources as unknown[]).every(
        (r) =>
          r !== null &&
          typeof r === "object" &&
          typeof (r as Record<string, unknown>).resource === "string" &&
          typeof (r as Record<string, unknown>).quantity === "string" &&
          DECIMAL_RE.test((r as Record<string, unknown>).quantity as string),
      );
    if (!linesOk) {
      return problem(
        c,
        422,
        "invalid_integer",
        "resources must be [{resource, quantity}] with contract decimal-string quantities",
        [{ field: "resources", issue: "invalid_resource_vector" }],
      );
    }
    try {
      const quote = await deps.service.quoteStep({
        organizationId,
        priceVersionId,
        resources: (resources as Record<string, string>[]).map((r) => ({
          resource: r.resource,
          quantity: r.quantity,
        })),
      });
      return c.json({
        price_version_id: quote.priceVersionId,
        rounding: quote.rounding,
        lines: quote.lines.map((l) => ({
          resource: l.resource,
          quantity: l.quantity,
          measurement_unit: l.measurementUnit,
          unit_size: l.unitSize,
          numerator: l.numerator,
          denominator: l.denominator,
        })),
        total_microcredits: quote.totalMicrocredits,
        total_display: quote.totalDisplay,
      });
    } catch (e) {
      return fail(c, e);
    }
  });

  // ------------------------------------------------------------ period query
  routes.post("/internal/v1/billing/period-queries", async (c) => {
    const body = await readJson(c);
    if (body instanceof Response) return body;
    const organizationId = c.get("trustedOrganizationId");
    const anchor = body.original_purchased_at_us;
    if (typeof anchor !== "string" || !DECIMAL_RE.test(anchor)) {
      return problem(
        c,
        422,
        "invalid_integer",
        "original_purchased_at_us must be a contract decimal string",
        [{ field: "original_purchased_at_us", issue: "not_a_decimal_string" }],
      );
    }
    const hasIndex =
      typeof body.target_period_index === "string" &&
      SMALL_INDEX_RE.test(body.target_period_index);
    const hasOccurrence =
      typeof body.occurrence_us === "string" &&
      DECIMAL_RE.test(body.occurrence_us);
    if (hasIndex === hasOccurrence) {
      return problem(
        c,
        422,
        "out_of_range",
        "provide exactly one of target_period_index or occurrence_us",
        [
          {
            field: "target_period_index",
            issue: "exactly_one_selector_required",
          },
        ],
      );
    }
    try {
      const answer = await deps.service.queryPeriod({
        organizationId,
        originalPurchasedAtUs: anchor,
        targetPeriodIndex: hasIndex
          ? (body.target_period_index as string)
          : undefined,
        occurrenceUs: hasOccurrence
          ? (body.occurrence_us as string)
          : undefined,
      });
      return c.json({
        timezone: answer.timezone,
        anchor: {
          utc_us: answer.anchor.utcUs,
          utc_iso: answer.anchor.utcIso,
          local: answer.anchor.local,
        },
        period: {
          index: answer.period.index,
          start_us: answer.period.startUs,
          end_us: answer.period.endUs,
          start_iso: answer.period.startIso,
          end_iso: answer.period.endIso,
          start_local: answer.period.startLocal,
          end_local: answer.period.endLocal,
        },
      });
    } catch (e) {
      return fail(c, e);
    }
  });

  // ------------------------------------------------- historical version read
  routes.get("/internal/v1/billing/catalog-versions/:release_id", async (c) => {
    const releaseId = c.req.param("release_id");
    if (!UUID_RE.test(releaseId)) {
      return problem(c, 422, "invalid_integer", "release_id must be a UUID", [
        { field: "release_id", issue: "not_a_uuid" },
      ]);
    }
    const organizationId = c.get("trustedOrganizationId");
    try {
      const snapshot = await deps.service.getCatalogVersion({
        organizationId,
        releaseId,
      });
      return c.json({
        release_id: snapshot.releaseId,
        content_digest: snapshot.contentDigest,
        status: snapshot.status,
        environment: snapshot.environment,
        effective_from_us: snapshot.effectiveFromUs,
        effective_to_us: snapshot.effectiveToUs,
        items: snapshot.items.map((item) => ({
          product_version_id: item.productVersionId,
          product_id: item.productId,
          product_type: item.productType,
          price_version_id: item.priceVersionId,
          quota_version_id: item.quotaVersionId,
          run_cap_version_id: item.runCapVersionId,
          run_cap_microcredits: item.runCapMicrocredits,
          prices: item.prices.map((p) => ({
            resource: p.resource,
            measurement_unit: p.measurementUnit,
            unit_size: p.unitSize,
            numerator: p.numerator,
            denominator: p.denominator,
          })),
        })),
      });
    } catch (e) {
      return fail(c, e);
    }
  });

  return routes;
}

function problemTitle(code: string): string {
  switch (code) {
    case "invalid_integer":
      return "Malformed integer";
    case "out_of_range":
      return "Value outside the contract range";
    case "resource_not_found":
      return "Not found in this scope";
    case "state_conflict":
      return "State conflict";
    case "price_version_conflict":
      return "Price version conflict";
    case "ledger_unavailable":
      return "Catalog storage unavailable";
    case "unauthenticated":
      return "Unauthenticated";
    default:
      return "Billing catalog error";
  }
}

/** Serialize a quote to the contract's snake_case JSON shape. */
function serializeQuote(quote: ProductQuote): Record<string, unknown> {
  const s = quote.snapshot;
  const preview = quote.periodPreview;
  return {
    sellable: quote.sellable,
    ...(quote.notSellableReason
      ? { not_sellable_reason: quote.notSellableReason }
      : {}),
    test_only: quote.testOnly,
    quoted_at_us: quote.quotedAtUs,
    ...(s
      ? {
          snapshot: {
            release_id: s.releaseId,
            release_content_digest: s.releaseContentDigest,
            scope_is_account_specific: s.scopeIsAccountSpecific,
            product_version_id: s.productVersionId,
            product_id: s.productId,
            product_type: s.productType,
            display_name: s.displayName,
            amount_fen: s.amountFen,
            currency: s.currency,
            granted_microcredits: s.grantedMicrocredits,
            period_months: s.periodMonths,
            long_lived: s.longLived,
            price_version_id: s.priceVersionId,
            quota_version_id: s.quotaVersionId,
            run_cap_version_id: s.runCapVersionId,
            run_cap_microcredits: s.runCapMicrocredits,
          },
        }
      : {}),
    ...(preview !== undefined
      ? {
          period_preview:
            preview === null
              ? null
              : {
                  index: preview.index.toString(),
                  start_us: preview.startUs,
                  end_us: preview.endUs,
                  start_iso: preview.startIso,
                  end_iso: preview.endIso,
                },
        }
      : {}),
    ...(quote.eligibility
      ? {
          eligibility: {
            allowed: quote.eligibility.allowed,
            reason: quote.eligibility.reason,
            next_action: quote.eligibility.nextAction,
            target_period:
              quote.eligibility.targetPeriod === null
                ? null
                : {
                    index: quote.eligibility.targetPeriod.index.toString(),
                    start_us: quote.eligibility.targetPeriod.startUs.toString(),
                    end_us: quote.eligibility.targetPeriod.endUs.toString(),
                  },
            state_revision: quote.eligibility.stateRevision.toString(),
            existing_commitment:
              quote.eligibility.existingCommitment === null
                ? null
                : {
                    product_id: quote.eligibility.existingCommitment.productId,
                    target_period_start_us:
                      quote.eligibility.existingCommitment.targetPeriodStartUs.toString(),
                  },
          },
        }
      : {}),
  };
}
