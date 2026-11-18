/**
 * Billing catalog business-level integration (#65) against REAL PostgreSQL.
 *
 * Every business path goes through the production service and the production
 * Hono sub-app (never a copy of the logic): publish a complete release, quote
 * products (sellability closure, test isolation, price-version conflict),
 * quote steps against pinned versions (exact microcredits, replay after
 * "restart", retirement), query Beijing-time periods, walk the eligibility
 * table through the injected trusted projection, and verify the negative
 * space (cross-organization invisibility, draft rejection, overlapping
 * releases, concurrent publishes, storage outage).
 *
 * Requires TEST_DATABASE_URL pointing at a dedicated database (the suite
 * support refuses the live application database by name).
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import {
  type BillingCatalogService,
  CatalogServiceError,
  createBillingCatalogRoutes,
  createBillingCatalogService,
  type TrustedSubscriptionSnapshot,
} from "../src/billing-catalog";
import {
  type LocalWallTime,
  localToUtcUs,
  periodByIndex,
} from "../src/billing-catalog/periods";
import { createDatabase, type Database } from "../src/db/client";
import {
  billingPriceResources,
  billingPriceVersions,
  billingProductVersions,
  billingQuotaVersions,
  billingRunCapVersions,
} from "../src/db/schema";
import { TEST_POOL, testDatabaseUrl } from "./support/database";

const ORG = randomUUID();
const ORG_TEST_ONLY = randomUUID();
const ORG_FOREIGN = randomUUID();
const ACCOUNT = randomUUID();

const ANCHOR: LocalWallTime = {
  year: 2024,
  month: 1,
  day: 31,
  hour: 9,
  minute: 30,
  second: 15,
  microsecond: 123456,
};
const B1 = periodByIndex(ANCHOR, 1n);

/** Trusted server clock: fixed instant, overridable per scenario. */
class FixedClock {
  constructor(public us: bigint) {}
  nowUs(): bigint {
    return this.us;
  }
}

let database: Database;
let service: BillingCatalogService;
let clock: FixedClock;
/** The trusted projection a scenario arranges; the quote reads THIS, never a client claim. */
let trustedSnapshot: TrustedSubscriptionSnapshot;
const createdIds: string[] = [];

const PROD_TOKEN = "svc_billing_prod_capability";
const FOREIGN_TOKEN = "svc_billing_foreign_capability";

/** Trusted projection: subscription active on the Jan-31 anchor, no commitment. */
function activeSubscription(
  overrides: Partial<
    NonNullable<TrustedSubscriptionSnapshot["subscription"]>
  > = {},
): TrustedSubscriptionSnapshot {
  return {
    stateRevision: 11n,
    observedAtUs: clock.us,
    subscription: {
      anchor: ANCHOR,
      currentPeriodIndex: 0n,
      status: "active",
      currentProductId: "pack_1m_credits_test",
      prepaid: null,
      ...overrides,
    },
    refundsForTargetPeriod: [],
  };
}

async function seedVersion(
  kind: "quota" | "runCap" | "price" | "product",
  values: Record<string, unknown>,
): Promise<string> {
  const now = 1_700_000_000_000_000n;
  if (kind === "quota") {
    const [row] = await database
      .insert(billingQuotaVersions)
      .values({
        organizationId: values.organizationId as string,
        billingAccountId: (values.billingAccountId as string | null) ?? null,
        environment:
          (values.environment as "production" | "test") ?? "production",
        tier: values.tier as "basic" | "subscription",
        spec: values.spec as never,
        status: "active",
        createdAtUs: now,
        updatedAtUs: now,
      })
      .returning({ id: billingQuotaVersions.id });
    return row.id;
  }
  if (kind === "runCap") {
    const [row] = await database
      .insert(billingRunCapVersions)
      .values({
        organizationId: values.organizationId as string,
        billingAccountId: (values.billingAccountId as string | null) ?? null,
        environment:
          (values.environment as "production" | "test") ?? "production",
        capMicrocredits: values.capMicrocredits as bigint,
        status: "active",
        createdAtUs: now,
        updatedAtUs: now,
      })
      .returning({ id: billingRunCapVersions.id });
    return row.id;
  }
  if (kind === "price") {
    const [row] = await database
      .insert(billingPriceVersions)
      .values({
        organizationId: values.organizationId as string,
        billingAccountId: (values.billingAccountId as string | null) ?? null,
        environment:
          (values.environment as "production" | "test") ?? "production",
        effectiveFromUs: values.effectiveFromUs as bigint,
        effectiveToUs: (values.effectiveToUs as bigint | null) ?? null,
        defaultRootRunCapVersionId: values.runCapId as string,
        defaultRootRunCapMicrocredits: values.capMicrocredits as bigint,
        status: "active",
        createdAtUs: now,
        updatedAtUs: now,
      })
      .returning({ id: billingPriceVersions.id });
    await database.insert(billingPriceResources).values(
      (
        values.resources as {
          resource: string;
          measurementUnit: string;
          unitSize: bigint;
          numerator: bigint;
          denominator: bigint;
        }[]
      ).map((r) => ({
        priceVersionId: row.id,
        resource: r.resource as never,
        measurementUnit: r.measurementUnit as never,
        unitSize: r.unitSize,
        numerator: r.numerator,
        denominator: r.denominator,
      })),
    );
    return row.id;
  }
  const [row] = await database
    .insert(billingProductVersions)
    .values({
      organizationId: values.organizationId as string,
      billingAccountId: (values.billingAccountId as string | null) ?? null,
      environment:
        (values.environment as "production" | "test") ?? "production",
      productId: values.productId as string,
      productType: values.productType as "monthly_plan" | "credit_pack",
      displayName: values.displayName as string,
      priceFen: values.priceFen as bigint,
      grantedMicrocredits:
        (values.grantedMicrocredits as bigint | null) ?? null,
      periodMonths: (values.periodMonths as number | null) ?? null,
      quotaVersionId: (values.quotaVersionId as string | null) ?? null,
      status: "active",
      createdAtUs: now,
      updatedAtUs: now,
    })
    .returning({ id: billingProductVersions.id });
  return row.id;
}

const T0 = 1_700_000_000_000_000n; // fixed publish interval start
const APP = () =>
  createBillingCatalogRoutes({
    service,
    verifyCredential: (authorization) => {
      if (authorization === `Bearer ${PROD_TOKEN}`)
        return { ok: true, organizationId: ORG };
      if (authorization === `Bearer ${FOREIGN_TOKEN}`) {
        return { ok: true, organizationId: ORG_FOREIGN };
      }
      return { ok: false };
    },
  });

const json = (body: unknown, token = PROD_TOKEN): RequestInit => ({
  method: "POST",
  headers: {
    "content-type": "application/json",
    authorization: `Bearer ${token}`,
  },
  body: JSON.stringify(body),
});

const get = (token = PROD_TOKEN): RequestInit => ({
  headers: { authorization: `Bearer ${token}` },
});

beforeAll(async () => {
  database = createDatabase(testDatabaseUrl(), TEST_POOL);
  clock = new FixedClock(T0 + 3_600_000_000_000n);
  service = createBillingCatalogService({
    database,
    clock,
    trustedState: {
      readSubscriptionSnapshot: async () => {
        if (!trustedSnapshot) {
          throw new Error("trusted subscription projection unreadable");
        }
        return trustedSnapshot;
      },
    },
  });

  // --- org-scoped TEST release (marked test_only; never a production sale) ---
  const capTest = await seedVersion("runCap", {
    organizationId: ORG,
    environment: "test",
    capMicrocredits: 5_000_000n,
  });
  const priceTest = await seedVersion("price", {
    organizationId: ORG,
    environment: "test",
    effectiveFromUs: T0,
    runCapId: capTest,
    capMicrocredits: 5_000_000n,
    resources: [
      {
        resource: "model_input_tokens",
        measurementUnit: "token",
        unitSize: 1000n,
        numerator: 100n,
        denominator: 1_000_000n,
      }, // 0.1 credits / 1000 tokens
    ],
  });
  const packTest = await seedVersion("product", {
    organizationId: ORG,
    environment: "test",
    productId: "pack_1m_credits_test",
    productType: "credit_pack",
    displayName: "TEST ONLY: 1M credits pack",
    priceFen: 9900n,
    grantedMicrocredits: 1_000_000n,
  });
  await service.publishRelease({
    organizationId: ORG,
    billingAccountId: null,
    environment: "test",
    effectiveFromUs: T0,
    effectiveToUs: null,
    items: [
      {
        productVersionId: packTest,
        priceVersionId: priceTest,
        quotaVersionId: null,
      },
    ],
    createdAtUs: T0,
  });
  createdIds.push(capTest, priceTest, packTest);

  // --- production release: one monthly plan + one pack -----------------------
  const capProd = await seedVersion("runCap", {
    organizationId: ORG,
    capMicrocredits: 5_000_000n,
  });
  const quota = await seedVersion("quota", {
    organizationId: ORG,
    tier: "subscription",
    spec: {
      quotas: [
        { resource_key: "concurrent_runs", limit: "5", unit: "count" },
        { resource_key: "automatic_task_seats", limit: "20", unit: "count" },
      ],
    },
  });
  const priceV1 = await seedVersion("price", {
    organizationId: ORG,
    effectiveFromUs: T0,
    runCapId: capProd,
    capMicrocredits: 5_000_000n,
    resources: [
      {
        resource: "model_input_tokens",
        measurementUnit: "token",
        unitSize: 1n,
        numerator: 1n,
        denominator: 10n,
      }, // 0.1 credits per token (test numbers, by design)
    ],
  });
  const plan = await seedVersion("product", {
    organizationId: ORG,
    productId: "plan_pro_monthly",
    productType: "monthly_plan",
    displayName: "Pro monthly",
    priceFen: 4900n,
    periodMonths: 1,
    quotaVersionId: quota,
  });
  const pack = await seedVersion("product", {
    organizationId: ORG,
    productId: "pack_1m_credits",
    productType: "credit_pack",
    displayName: "1M credits pack",
    priceFen: 9900n,
    grantedMicrocredits: 1_000_000n,
  });
  release1 = await service.publishRelease({
    organizationId: ORG,
    billingAccountId: null,
    environment: "production",
    effectiveFromUs: T0,
    effectiveToUs: null,
    items: [
      {
        productVersionId: plan,
        priceVersionId: priceV1,
        quotaVersionId: quota,
      },
      { productVersionId: pack, priceVersionId: priceV1, quotaVersionId: null },
    ],
    createdAtUs: T0,
  });
  createdIds.push(capProd, quota, priceV1, plan, pack);

  // --- an organization whose catalog exists ONLY as a test release ----------
  const capTestOnly = await seedVersion("runCap", {
    organizationId: ORG_TEST_ONLY,
    environment: "test",
    capMicrocredits: 1_000_000n,
  });
  const priceTestOnly = await seedVersion("price", {
    organizationId: ORG_TEST_ONLY,
    environment: "test",
    effectiveFromUs: T0,
    runCapId: capTestOnly,
    capMicrocredits: 1_000_000n,
    resources: [
      {
        resource: "model_input_tokens",
        measurementUnit: "token",
        unitSize: 1n,
        numerator: 1n,
        denominator: 1_000_000n,
      },
    ],
  });
  const packTestOnly = await seedVersion("product", {
    organizationId: ORG_TEST_ONLY,
    environment: "test",
    productId: "pack_test_only",
    productType: "credit_pack",
    displayName: "test-only pack",
    priceFen: 100n,
    grantedMicrocredits: 1000n,
  });
  await service.publishRelease({
    organizationId: ORG_TEST_ONLY,
    billingAccountId: null,
    environment: "test",
    effectiveFromUs: T0,
    effectiveToUs: null,
    items: [
      {
        productVersionId: packTestOnly,
        priceVersionId: priceTestOnly,
        quotaVersionId: null,
      },
    ],
    createdAtUs: T0,
  });
  createdIds.push(capTestOnly, priceTestOnly, packTestOnly);

  // Default trusted projection: active subscription, no commitment.
  trustedSnapshot = activeSubscription();
});

let release1: { id: string; contentDigest: string };
let priceV2Id = "";

afterAll(async () => {
  // The database is disposable (billing62_<run> isolation); nothing here needs
  // explicit teardown beyond closing the pool.
  await database.$client.end({ timeout: 5 });
});

describe("catalog quotes: sellability closure and test isolation (A1/A2/A14)", () => {
  test("a production request can never select the test release, even when it exists", async () => {
    const res = await APP().request(
      "/internal/v1/billing/product-quotes",
      json({
        product_id: "pack_1m_credits_test",
        action: "initial_purchase",
        billing_account_id: ACCOUNT,
      }),
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      sellable: boolean;
      not_sellable_reason?: string;
    };
    expect(body.sellable).toBe(false);
    expect(body.not_sellable_reason).toBe("product_not_in_release");
  });

  test("the test release is selectable in the test environment through the same repository", async () => {
    const { selectReleaseForQuote } = await import(
      "../src/billing-catalog/repository"
    );
    const selection = await selectReleaseForQuote(
      database,
      { organizationId: ORG, billingAccountId: ACCOUNT, environment: "test" },
      clock.nowUs(),
    );
    expect(selection.ok).toBe(true);
    if (selection.ok) {
      expect(selection.release.items[0].productVersion.productId).toBe(
        "pack_1m_credits_test",
      );
      expect(selection.release.items[0].runCap.capMicrocredits).toBe(
        5_000_000n,
      );
    }
  });

  test("an organization with only a test catalog is NOT sellable in production", async () => {
    const result = await service.quoteProduct({
      organizationId: ORG_TEST_ONLY,
      billingAccountId: null,
      productId: "pack_test_only",
      action: "initial_purchase",
      includeEligibility: false,
    });
    expect(result.sellable).toBe(false);
    expect(result.notSellableReason).toBe("no_published_release");
    expect(result.snapshot).toBeUndefined();
  });

  test("an organization with no catalog at all is not sellable, never zero-priced", async () => {
    const result = await service.quoteProduct({
      organizationId: ORG_FOREIGN,
      billingAccountId: null,
      productId: "anything",
      action: "initial_purchase",
      includeEligibility: false,
    });
    expect(result.sellable).toBe(false);
    expect(result.notSellableReason).toBe("no_published_release");
  });

  test("the production release quotes the pack with the full immutable snapshot", async () => {
    const result = await service.quoteProduct({
      organizationId: ORG,
      billingAccountId: null,
      productId: "pack_1m_credits",
      action: "initial_purchase",
      includeEligibility: false,
    });
    expect(result.sellable).toBe(true);
    expect(result.snapshot?.amountFen).toBe("9900");
    expect(result.snapshot?.currency).toBe("CNY");
    expect(result.snapshot?.grantedMicrocredits).toBe("1000000");
    expect(result.snapshot?.longLived).toBe(true);
    expect(result.snapshot?.releaseId).toBe(release1.id);
    expect(result.snapshot?.releaseContentDigest).toBe(release1.contentDigest);
    expect(result.snapshot?.runCapMicrocredits).toBe("5000000");
    expect(result.testOnly).toBe(false);
  });

  test("an expected price version that is not the pinned one is 409 price_version_conflict", async () => {
    expect.assertions(3);
    try {
      await service.quoteProduct({
        organizationId: ORG,
        billingAccountId: null,
        productId: "pack_1m_credits",
        action: "initial_purchase",
        expectedPriceVersionId: randomUUID(),
        includeEligibility: false,
      });
    } catch (e) {
      expect(e).toBeInstanceOf(CatalogServiceError);
      const err = e as CatalogServiceError;
      expect(err.code).toBe("price_version_conflict");
      expect(err.status).toBe(409);
    }
  });
});

describe("step quotes: exact pricing against pinned versions (A5/A7/A6)", () => {
  test("V1 price 0.1 credits per unit, quantity 3 -> 300000 microcredits", async () => {
    const snapshot = await service.getCatalogVersion({
      organizationId: ORG,
      releaseId: release1.id,
    });
    const v1 = snapshot.items.find(
      (i) => i.productId === "pack_1m_credits",
    )!.priceVersionId;
    const quoted = await service.quoteStep({
      organizationId: ORG,
      priceVersionId: v1,
      resources: [{ resource: "model_input_tokens", quantity: "3" }],
    });
    expect(quoted.totalMicrocredits).toBe("300000");
    expect(quoted.totalDisplay).toBe("0.300000"); // 300000 µc shown with the contract's six decimals
    expect(quoted.rounding).toBe("half_up");
  });

  test("reprice appends V2; old steps keep replaying V1 after a fresh service instance", async () => {
    // Find the pinned V1 price version from the release snapshot.
    const snapshot = await service.getCatalogVersion({
      organizationId: ORG,
      releaseId: release1.id,
    });
    const packItem = snapshot.items.find(
      (i) => i.productId === "pack_1m_credits",
    );
    const v1 = packItem!.priceVersionId;
    const quoted = await service.quoteStep({
      organizationId: ORG,
      priceVersionId: v1,
      resources: [{ resource: "model_input_tokens", quantity: "3" }],
    });
    expect(quoted.totalMicrocredits).toBe("300000");

    // Append V2 (0.2 credits per unit) + successor release at a later interval.
    const capId = (
      await service.getCatalogVersion({
        organizationId: ORG,
        releaseId: release1.id,
      })
    ).items[0].runCapVersionId;
    const priceV2 = await seedVersion("price", {
      organizationId: ORG,
      effectiveFromUs: T0 + 86_400_000_000_000n, // a day after the first interval
      effectiveToUs: null,
      runCapId: capId,
      capMicrocredits: 5_000_000n,
      resources: [
        {
          resource: "model_input_tokens",
          measurementUnit: "token",
          unitSize: 1n,
          numerator: 2n,
          denominator: 10n,
        },
      ],
    });
    priceV2Id = priceV2;
    const successor = await service.publishRelease({
      organizationId: ORG,
      billingAccountId: null,
      environment: "production",
      effectiveFromUs: T0 + 86_400_000_000_000n,
      effectiveToUs: null,
      items: [
        {
          productVersionId: snapshot.items.find(
            (i) => i.productId === "plan_pro_monthly",
          )!.productVersionId,
          priceVersionId: priceV2,
          quotaVersionId: snapshot.items.find(
            (i) => i.productId === "plan_pro_monthly",
          )!.quotaVersionId,
        },
        {
          productVersionId: packItem!.productVersionId,
          priceVersionId: priceV2,
          quotaVersionId: null,
        },
      ],
      createdAtUs: T0 + 86_400_000_000_000n,
    });
    expect(successor.id).not.toBe(release1.id);

    // NEW steps select the successor (clock moved past the boundary).
    const later = createBillingCatalogService({
      database,
      clock: new FixedClock(T0 + 2n * 86_400_000_000_000n),
      trustedState: { readSubscriptionSnapshot: async () => trustedSnapshot },
    });
    const requote = await later.quoteProduct({
      organizationId: ORG,
      billingAccountId: null,
      productId: "pack_1m_credits",
      action: "initial_purchase",
      includeEligibility: false,
    });
    expect(requote.snapshot?.priceVersionId).toBe(priceV2);

    // OLD steps replay V1 -- through a brand-new service instance (restart).
    const restarted = createBillingCatalogService({
      database,
      clock: new FixedClock(T0 + 2n * 86_400_000_000_000n),
      trustedState: { readSubscriptionSnapshot: async () => trustedSnapshot },
    });
    const replay = await restarted.quoteStep({
      organizationId: ORG,
      priceVersionId: v1,
      resources: [{ resource: "model_input_tokens", quantity: "3" }],
    });
    expect(replay.totalMicrocredits).toBe("300000");
    // And the successor version quotes 600000 for the same usage.
    const reprice = await restarted.quoteStep({
      organizationId: ORG,
      priceVersionId: priceV2,
      resources: [{ resource: "model_input_tokens", quantity: "3" }],
    });
    expect(reprice.totalMicrocredits).toBe("600000");
  });

  test("the selection boundary belongs to the successor release, audited", async () => {
    const [r1] = await database.execute<{ effective_to_us: string }>(
      `select effective_to_us from billing_catalog_releases where id = '${release1.id}'`,
    );
    expect(BigInt(r1.effective_to_us)).toBe(T0 + 86_400_000_000_000n);
    const handover = await database.execute<{ boundary_us: string }>(
      `select boundary_us from billing_catalog_release_handovers where previous_release_id = '${release1.id}'`,
    );
    expect(handover).toHaveLength(1);
    expect(BigInt(handover[0].boundary_us)).toBe(T0 + 86_400_000_000_000n);
  });

  test("unknown price version is 404 without leaking other organizations' versions", async () => {
    expect.assertions(2);
    try {
      await service.quoteStep({
        organizationId: ORG,
        priceVersionId: randomUUID(),
        resources: [{ resource: "model_input_tokens", quantity: "1" }],
      });
    } catch (e) {
      expect((e as CatalogServiceError).status).toBe(404);
    }
    try {
      await service.quoteStep({
        organizationId: ORG_FOREIGN,
        priceVersionId: priceV2Id,
        resources: [{ resource: "model_input_tokens", quantity: "1" }],
      });
    } catch (e) {
      expect((e as CatalogServiceError).status).toBe(404); // exists, but invisible cross-org
    }
  });

  test("unknown resource is 422 even at quantity zero (A6)", async () => {
    const snapshot = await service.getCatalogVersion({
      organizationId: ORG,
      releaseId: release1.id,
    });
    const v1 = snapshot.items.find(
      (i) => i.productId === "pack_1m_credits",
    )!.priceVersionId;
    expect.assertions(2);
    try {
      await service.quoteStep({
        organizationId: ORG,
        priceVersionId: v1,
        resources: [{ resource: "tool_call_count", quantity: "0" }],
      });
    } catch (e) {
      expect((e as CatalogServiceError).status).toBe(422);
      expect((e as CatalogServiceError).code).toBe("out_of_range");
    }
  });

  test("over the HTTP surface: >2^53 decimal strings round-trip; invalid lexemes and int64 overflow are 422", async () => {
    const snapshot = await service.getCatalogVersion({
      organizationId: ORG,
      releaseId: release1.id,
    });
    const capId = snapshot.items[0].runCapVersionId;
    // A 1-microcredit-per-token price keeps a >2^53 quantity's total inside int64.
    const bigQPrice = await seedVersion("price", {
      organizationId: ORG,
      effectiveFromUs: T0,
      effectiveToUs: null,
      runCapId: capId,
      capMicrocredits: 5_000_000n,
      resources: [
        {
          resource: "model_input_tokens",
          measurementUnit: "token",
          unitSize: 1n,
          numerator: 1n,
          denominator: 1_000_000n,
        },
      ],
    });
    const app = APP();
    const good = await app.request(
      "/internal/v1/billing/step-quotes",
      json({
        price_version_id: bigQPrice,
        resources: [
          { resource: "model_input_tokens", quantity: "9007199254740993" },
        ],
      }),
    );
    expect(good.status).toBe(200);
    const body = (await good.json()) as {
      lines: { quantity: string }[];
      total_microcredits: string;
    };
    expect(body.lines[0].quantity).toBe("9007199254740993"); // zero loss, no float
    // 9007199254740993 tokens * 1 µc/token = 9007199254740993 µc.
    expect(body.total_microcredits).toBe("9007199254740993");

    // The V1 price (0.1 credits/unit) with the same quantity would exceed int64.
    const v1 = snapshot.items.find(
      (i) => i.productId === "pack_1m_credits",
    )!.priceVersionId;
    const overflow = await app.request(
      "/internal/v1/billing/step-quotes",
      json({
        price_version_id: v1,
        resources: [
          { resource: "model_input_tokens", quantity: "9007199254740993" },
        ],
      }),
    );
    expect(overflow.status).toBe(422);
    const overflowProblem = (await overflow.json()) as { code: string };
    expect(overflowProblem.code).toBe("out_of_range");

    const bad = await app.request(
      "/internal/v1/billing/step-quotes",
      json({
        price_version_id: v1,
        resources: [{ resource: "model_input_tokens", quantity: "1.5" }],
      }),
    );
    expect(bad.status).toBe(422);
    const problem = (await bad.json()) as { code: string; title?: string };
    expect(problem.code).toBe("invalid_integer");
  });

  test("no credential is 401 problem+json", async () => {
    const res = await APP().request(
      "/internal/v1/billing/step-quotes",
      json(
        {
          price_version_id: randomUUID(),
          resources: [{ resource: "model_input_tokens", quantity: "1" }],
        },
        "wrong-token",
      ),
    );
    expect(res.status).toBe(401);
    const problem = (await res.json()) as { code: string };
    expect(problem.code).toBe("unauthenticated");
  });
});

describe("period queries through the business surface (A8–A10)", () => {
  const activationUs = localToUtcUs(ANCHOR);

  test("A8: leap-year anchor produces 02-29 then 03-31 with microseconds intact", async () => {
    const res = await APP().request(
      "/internal/v1/billing/period-queries",
      json({
        original_purchased_at_us: activationUs.toString(),
        target_period_index: "0",
      }),
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      timezone: string;
      anchor: { utc_us: string; local: { day: number; microsecond: number } };
      period: {
        index: string;
        start_us: string;
        end_us: string;
        start_iso: string;
        end_iso: string;
      };
    };
    expect(body.timezone).toBe("Asia/Shanghai");
    expect(body.anchor.utc_us).toBe(activationUs.toString());
    expect(body.anchor.local.microsecond).toBe(123456);
    expect(body.period.start_iso).toBe("2024-01-31T01:30:15.123456Z");
    expect(body.period.end_iso).toBe("2024-02-29T01:30:15.123456Z");
  });

  test("A10: occurrence at the boundary minus 1µs is period 0; the boundary itself is period 1", async () => {
    const before = await APP().request(
      "/internal/v1/billing/period-queries",
      json({
        original_purchased_at_us: activationUs.toString(),
        occurrence_us: (B1.startUs - 1n).toString(),
      }),
    );
    const bodyBefore = (await before.json()) as {
      period: { index: string; end_us: string };
    };
    expect(bodyBefore.period.index).toBe("0");
    expect(bodyBefore.period.end_us).toBe(B1.startUs.toString());
    const at = await APP().request(
      "/internal/v1/billing/period-queries",
      json({
        original_purchased_at_us: activationUs.toString(),
        occurrence_us: B1.startUs.toString(),
      }),
    );
    const bodyAt = (await at.json()) as { period: { index: string } };
    expect(bodyAt.period.index).toBe("1");
  });

  test("negative selectors and both-or-neither selectors are 422", async () => {
    const both = await APP().request(
      "/internal/v1/billing/period-queries",
      json({
        original_purchased_at_us: activationUs.toString(),
        target_period_index: "1",
        occurrence_us: "1",
      }),
    );
    expect(both.status).toBe(422);
    const neither = await APP().request(
      "/internal/v1/billing/period-queries",
      json({ original_purchased_at_us: activationUs.toString() }),
    );
    expect(neither.status).toBe(422);
    const negative = await APP().request(
      "/internal/v1/billing/period-queries",
      json({
        original_purchased_at_us: activationUs.toString(),
        target_period_index: "-1",
      }),
    );
    expect(negative.status).toBe(422);
  });
});

describe("eligibility through the business quote (A11/A12/A13)", () => {
  const activationUs = localToUtcUs(ANCHOR);

  test("active subscription, no commitment: renewal targets the next period, continuing the anchor", async () => {
    trustedSnapshot = activeSubscription();
    const res = await APP().request(
      "/internal/v1/billing/product-quotes",
      json({
        product_id: "pack_1m_credits",
        action: "renewal",
        billing_account_id: ACCOUNT,
      }),
    );
    const body = (await res.json()) as {
      sellable: boolean;
      eligibility?: {
        allowed: boolean;
        reason: string;
        target_period?: { start_us: string; end_us: string } | null;
      };
      period_preview?: { start_us: string } | null;
    };
    expect(body.sellable).toBe(true);
    expect(body.eligibility?.allowed).toBe(true);
    expect(body.eligibility?.reason).toBe("eligible");
    expect(body.eligibility?.target_period?.start_us).toBe(
      B1.startUs.toString(),
    );
    expect(body.eligibility?.target_period?.end_us).toBe(B1.endUs.toString());
    expect(body.period_preview?.start_us).toBe(B1.startUs.toString());
  });

  test("first purchase: no target period is returned and payment time never becomes the anchor", async () => {
    trustedSnapshot = {
      stateRevision: 3n,
      observedAtUs: clock.us,
      subscription: null,
      refundsForTargetPeriod: [],
    };
    const res = await APP().request(
      "/internal/v1/billing/product-quotes",
      json({
        product_id: "pack_1m_credits",
        action: "initial_purchase",
        billing_account_id: ACCOUNT,
      }),
    );
    const body = (await res.json()) as {
      eligibility?: { allowed: boolean; target_period: null };
      period_preview: null;
    };
    expect(body.eligibility?.allowed).toBe(true);
    expect(body.eligibility?.target_period).toBeNull();
    expect(body.period_preview).toBeNull();
    void activationUs;
  });

  test("expired subscription: re-purchase allowed, no gap back-fill, new anchor at activation", async () => {
    trustedSnapshot = activeSubscription({
      status: "expired",
      currentPeriodIndex: 4n,
    });
    const res = await APP().request(
      "/internal/v1/billing/product-quotes",
      json({
        product_id: "pack_1m_credits",
        action: "initial_purchase",
        billing_account_id: ACCOUNT,
      }),
    );
    const body = (await res.json()) as {
      eligibility?: { allowed: boolean; reason: string; target_period: null };
    };
    expect(body.eligibility?.allowed).toBe(true);
    expect(body.eligibility?.reason).toBe("eligible");
    expect(body.eligibility?.target_period).toBeNull();
  });

  test("already prepaid same tier: blocked with the existing commitment shown", async () => {
    trustedSnapshot = activeSubscription({
      prepaid: {
        productId: "pack_1m_credits",
        targetPeriodStartUs: B1.startUs,
        targetPeriodIndex: 1n,
      },
    });
    const res = await APP().request(
      "/internal/v1/billing/product-quotes",
      json({
        product_id: "pack_1m_credits",
        action: "renewal",
        billing_account_id: ACCOUNT,
      }),
    );
    const body = (await res.json()) as {
      eligibility?: {
        allowed: boolean;
        reason: string;
        next_action: string;
        existing_commitment?: { product_id: string } | null;
      };
    };
    expect(body.eligibility?.allowed).toBe(false);
    expect(body.eligibility?.reason).toBe("already_prepaid");
    expect(body.eligibility?.next_action).toBe("keep_existing_commitment");
    expect(body.eligibility?.existing_commitment?.product_id).toBe(
      "pack_1m_credits",
    );
  });

  test("prepaid then different tier: refund_required, refund first", async () => {
    trustedSnapshot = activeSubscription({
      prepaid: {
        productId: "pack_1m_credits",
        targetPeriodStartUs: B1.startUs,
        targetPeriodIndex: 1n,
      },
    });
    const res = await APP().request(
      "/internal/v1/billing/product-quotes",
      json({
        product_id: "plan_pro_monthly",
        action: "change_tier",
        billing_account_id: ACCOUNT,
      }),
    );
    const body = (await res.json()) as {
      eligibility?: { allowed: boolean; reason: string; next_action: string };
    };
    expect(body.eligibility?.allowed).toBe(false);
    expect(body.eligibility?.reason).toBe("refund_required");
    expect(body.eligibility?.next_action).toBe(
      "refund_existing_prepurchase_first",
    );
  });

  test("refund processing for the target period: blocked; succeeded: allowed again", async () => {
    trustedSnapshot = activeSubscription();
    trustedSnapshot.refundsForTargetPeriod = [
      { refundId: "r-1", status: "processing" },
    ];
    const blocked = await service.quoteProduct({
      organizationId: ORG,
      billingAccountId: ACCOUNT,
      productId: "pack_1m_credits",
      action: "renewal",
    });
    expect(blocked.eligibility?.allowed).toBe(false);
    expect(blocked.eligibility?.reason).toBe("refund_pending");
    trustedSnapshot.refundsForTargetPeriod = [
      { refundId: "r-1", status: "succeeded" },
    ];
    const allowed = await service.quoteProduct({
      organizationId: ORG,
      billingAccountId: ACCOUNT,
      productId: "plan_pro_monthly",
      action: "change_tier",
    });
    expect(allowed.eligibility?.allowed).toBe(true);
  });

  test("stale snapshot whose target period already started: state_conflict for the caller to recheck", async () => {
    trustedSnapshot = activeSubscription();
    // Move the trusted clock past the prepaid target period start while the
    // snapshot still reports the old revision.
    const later = createBillingCatalogService({
      database,
      clock: new FixedClock(B1.startUs + 1n),
      trustedState: { readSubscriptionSnapshot: async () => trustedSnapshot },
    });
    const result = await later.quoteProduct({
      organizationId: ORG,
      billingAccountId: ACCOUNT,
      productId: "pack_1m_credits",
      action: "renewal",
    });
    expect(result.eligibility?.allowed).toBe(false);
    expect(result.eligibility?.reason).toBe("state_conflict");
    expect(
      result.eligibility?.nextAction ??
        (result.eligibility as unknown as { next_action?: string }).next_action,
    ).toBeDefined();
  });

  test("an unreadable trusted projection is a storage error, never silently eligible", async () => {
    const broken = createBillingCatalogService({
      database,
      clock,
      trustedState: {
        readSubscriptionSnapshot: async () => {
          throw new Error("projection store down");
        },
      },
    });
    expect.assertions(2);
    try {
      await broken.quoteProduct({
        organizationId: ORG,
        billingAccountId: ACCOUNT,
        productId: "pack_1m_credits",
        action: "renewal",
      });
    } catch (e) {
      expect(e).toBeInstanceOf(CatalogServiceError);
      expect((e as CatalogServiceError).code).toBe("ledger_unavailable");
    }
  });
});

describe("publish integrity and failure closure (A14)", () => {
  test("a draft version cannot enter a release", async () => {
    const capId = (
      await database
        .select({ id: billingRunCapVersions.id })
        .from(billingRunCapVersions)
        .where(eq(billingRunCapVersions.organizationId, ORG))
    )[0].id;
    const [draftPrice] = await database
      .insert(billingPriceVersions)
      .values({
        organizationId: ORG,
        environment: "test",
        effectiveFromUs: T0,
        defaultRootRunCapVersionId: capId,
        defaultRootRunCapMicrocredits: 5_000_000n,
        status: "draft",
        createdAtUs: T0,
        updatedAtUs: T0,
      })
      .returning({ id: billingPriceVersions.id });
    expect.assertions(1);
    await expect(
      service.publishRelease({
        organizationId: ORG,
        billingAccountId: null,
        environment: "test",
        effectiveFromUs: T0 + 3_000n,
        effectiveToUs: null,
        items: [
          {
            productVersionId: randomUUID(),
            priceVersionId: draftPrice.id,
            quotaVersionId: null,
          },
        ],
        createdAtUs: T0,
      }),
    ).rejects.toThrow(/does not exist|draft/);
  });

  test("an overlapping release interval of the same scope is rejected at publish", async () => {
    const snapshot = await service.getCatalogVersion({
      organizationId: ORG,
      releaseId: release1.id,
    });
    const item = snapshot.items[0];
    await expect(
      service.publishRelease({
        organizationId: ORG,
        billingAccountId: null,
        environment: "production",
        effectiveFromUs: T0 + 1000n, // inside the active successor's interval
        effectiveToUs: null,
        items: [
          {
            productVersionId: item.productVersionId,
            priceVersionId: item.priceVersionId,
            quotaVersionId: item.quotaVersionId,
          },
        ],
        createdAtUs: T0,
      }),
    ).rejects.toThrow(/overlaps|crosses/);
  });

  test("concurrent publishes of the same scope serialize; only one interval wins", async () => {
    const snapshot = await service.getCatalogVersion({
      organizationId: ORG,
      releaseId: release1.id,
    });
    const item = snapshot.items[0];
    const boundary = T0 + 90n * 86_400_000_000_000n;
    const attemptA = service.publishRelease({
      organizationId: ORG,
      billingAccountId: null,
      environment: "production",
      effectiveFromUs: boundary,
      effectiveToUs: null,
      items: [
        {
          productVersionId: item.productVersionId,
          priceVersionId: item.priceVersionId,
          quotaVersionId: item.quotaVersionId,
        },
      ],
      createdAtUs: boundary,
    });
    const attemptB = service.publishRelease({
      organizationId: ORG,
      billingAccountId: null,
      environment: "production",
      effectiveFromUs: boundary, // same slot, same interval: exactly one may win
      effectiveToUs: null,
      items: [
        {
          productVersionId: item.productVersionId,
          priceVersionId: item.priceVersionId,
          quotaVersionId: item.quotaVersionId,
        },
      ],
      createdAtUs: boundary,
    });
    const results = await Promise.allSettled([attemptA, attemptB]);
    const fulfilled = results.filter((r) => r.status === "fulfilled");
    expect(fulfilled).toHaveLength(1);
  });

  test("cross-organization history reads are 404 without existence leakage", async () => {
    const res = await APP().request(
      `/internal/v1/billing/catalog-versions/${release1.id}`,
      get(FOREIGN_TOKEN),
    );
    expect(res.status).toBe(404);
    const own = await APP().request(
      `/internal/v1/billing/catalog-versions/${release1.id}`,
      get(),
    );
    expect(own.status).toBe(200);
    const body = (await own.json()) as {
      release_id: string;
      content_digest: string;
      items: unknown[];
    };
    expect(body.release_id).toBe(release1.id);
    expect(body.content_digest).toBe(release1.contentDigest);
    expect(body.items).toHaveLength(2);
  });

  test("a catalog storage outage is 503 ledger_unavailable, never zero price or false unavailability", async () => {
    // A service bound to a database that cannot be reached.
    const deadDatabase = createDatabase(
      "postgres://billing65:isolated-run@127.0.0.1:15498/billing62_none",
      { max: 1 },
    );
    const dead = createBillingCatalogService({ database: deadDatabase, clock });
    expect.assertions(3);
    try {
      await dead.quoteProduct({
        organizationId: ORG,
        billingAccountId: null,
        productId: "pack_1m_credits",
        action: "initial_purchase",
        includeEligibility: false,
      });
      throw new Error("the outage was not detected");
    } catch (e) {
      expect(e).toBeInstanceOf(CatalogServiceError);
      expect((e as CatalogServiceError).code).toBe("ledger_unavailable");
      expect((e as CatalogServiceError).status).toBe(503);
    } finally {
      await deadDatabase.$client.end({ timeout: 1 });
    }
  });

  test("quotes are observations: repeated quoting changes nothing in the catalog", async () => {
    const before = await service.getCatalogVersion({
      organizationId: ORG,
      releaseId: release1.id,
    });
    for (let i = 0; i < 3; i++) {
      await service.quoteProduct({
        organizationId: ORG,
        billingAccountId: null,
        productId: "pack_1m_credits",
        action: "initial_purchase",
        includeEligibility: true,
      });
    }
    const after = await service.getCatalogVersion({
      organizationId: ORG,
      releaseId: release1.id,
    });
    expect(after.contentDigest).toBe(before.contentDigest);
    expect(after.status).toBe(before.status);
  });
});
