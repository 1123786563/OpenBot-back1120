/**
 * Billing catalog service (#65): the shared business entry for order, ledger
 * and entitlement consumers.
 *
 * The service owns the trusted clock (injected; no client `now` is ever
 * accepted), organization/account scoping, sellability closure (no production
 * release -> sellable=false with a stable reason, never a zero price), exact
 * step pricing against a pinned version, Beijing-time period queries, and the
 * eligibility outcome over a trusted state snapshot. It is a read/quote
 * service: it never charges, grants credits, creates orders or drives workers.
 *
 * Error model mirrors the contract: lexical/range failures are 422
 * invalid_integer/out_of_range, unknown versions are 404 resource_not_found,
 * a mismatched pinned version is 409 price_version_conflict, stale state or an
 * already-started target period is 409 state_conflict, and catalog storage
 * failure is 503 ledger_unavailable — a storage outage is never disguised as
 * "not sellable" or as a zero price.
 */

import {
  BillingValueError,
  formatMicrocreditsDisplay,
  parseTimestampUs,
} from "../billing-contract/money-time.js";
import type { Database } from "../db/client";
import {
  type EligibilityOutcome,
  evaluatePurchaseEligibility,
  type TrustedSubscriptionSnapshot,
} from "./eligibility";
import {
  anchorFromActivation,
  type LocalWallTime,
  periodByIndex,
  periodOf,
} from "./periods";
import {
  type MeasurementUnit,
  PRICED_RESOURCES,
  type PricedResource,
  stepCostMicrocreditsExact,
  validatePriceEntry,
} from "./pricing";
import {
  CatalogConfigurationError,
  loadPriceVersionForReplay,
  loadReleaseSnapshot,
  type PublishReleaseInput,
  publishRelease,
  type ScopeKey,
  selectReleaseForQuote,
} from "./repository";

export interface TrustedClock {
  nowUs(): bigint;
}

export interface TrustedStateReader {
  /**
   * The trusted subscription/commitment/refund projection for the account, or
   * null when the account has none. A missing/unreadable projection must be
   * surfaced by the CALLER as an error, never as an "eligible" default.
   */
  readSubscriptionSnapshot(
    scope: ScopeKey,
    atUs: bigint,
  ): Promise<TrustedSubscriptionSnapshot>;
}

export interface BillingCatalogService {
  publishRelease(
    input: PublishReleaseInput,
  ): Promise<{ id: string; contentDigest: string }>;
  quoteProduct(input: QuoteProductInput): Promise<ProductQuote>;
  /** The CURRENT published unit prices + default Run cap for new steps. */
  resolveCurrentPrice(
    input: ResolveCurrentPriceInput,
  ): Promise<CurrentPriceResolution>;
  quoteStep(input: QuoteStepInput): Promise<StepQuote>;
  queryPeriod(input: QueryPeriodInput): Promise<PeriodAnswer>;
  getCatalogVersion(input: {
    organizationId: string;
    /** Trusted account authorization (null = unrestricted in the organization). */
    billingAccountIds: string[] | null;
    releaseId: string;
  }): Promise<CatalogVersionSnapshot>;
}

export interface QuoteProductInput {
  organizationId: string;
  billingAccountId: string | null;
  /**
   * The deployment environment to quote against: production (the default)
   * or an explicitly test-authorized test catalog. A production sale never
   * selects a test release and vice versa.
   */
  environment?: "production" | "test";
  productId: string;
  /** The purchase action the order service intends; eligibility is evaluated for it. */
  action: "initial_purchase" | "renewal" | "change_tier";
  /** Optional client-chosen version; a divergence from the selected release is 409. */
  expectedPriceVersionId?: string;
  includeEligibility?: boolean;
}

export interface ResolveCurrentPriceInput {
  organizationId: string;
  billingAccountId: string | null;
  /** The deployment environment to resolve (test requires trusted authorization). */
  environment?: "production" | "test";
  /**
   * Optional product to resolve the pinned price for. Absent, every item of
   * the release must pin the SAME price version, and that shared version is
   * resolved; a divergent catalog fails closed.
   */
  productId?: string;
}

export interface CurrentPriceResolution {
  sellable: boolean;
  notSellableReason?: string;
  testOnly: boolean;
  releaseId?: string;
  releaseContentDigest?: string;
  scopeIsAccountSpecific?: boolean;
  priceVersionId?: string;
  runCapVersionId?: string;
  runCapMicrocredits?: string;
  prices: {
    resource: string;
    measurementUnit: string;
    unitSize: string;
    numerator: string;
    denominator: string;
  }[];
  quotedAtUs: string;
}

export interface SellableSnapshot {
  releaseId: string;
  releaseContentDigest: string;
  scopeIsAccountSpecific: boolean;
  productVersionId: string;
  productId: string;
  productType: "monthly_plan" | "credit_pack";
  displayName: string;
  amountFen: string;
  currency: "CNY";
  grantedMicrocredits: string | null;
  periodMonths: number | null;
  longLived: boolean;
  priceVersionId: string;
  quotaVersionId: string | null;
  basicQuotaVersionId: string;
  runCapVersionId: string;
  runCapMicrocredits: string;
}

export interface ProductQuote {
  sellable: boolean;
  /** Stable closure reason when not sellable. */
  notSellableReason?: string;
  /** True when the selected configuration is explicitly test-only. */
  testOnly: boolean;
  snapshot?: SellableSnapshot;
  periodPreview?: {
    index: bigint;
    startUs: string;
    endUs: string;
    startIso: string;
    endIso: string;
  } | null;
  eligibility?: EligibilityOutcome;
  quotedAtUs: string;
}

export interface QuoteStepInput {
  organizationId: string;
  /**
   * Trusted billing-account authorization carried from the credential context
   * (null = unrestricted within the organization). A price version scoped to
   * another account is invisible, exactly like a cross-organization one.
   */
  billingAccountIds: string[] | null;
  /** The caller's trusted deployment environment; foreign-environment versions are invisible. */
  environment?: "production" | "test";
  priceVersionId: string;
  /**
   * The RESERVED fixed reference recorded on the step/reservation when the
   * step was priced. When present it must equal price_version_id — replaying
   * (or settling) a step against any other version is 409
   * price_version_conflict, so a settlement can never silently reprice a
   * pinned step under a different configuration.
   */
  expectedPriceVersionId?: string;
  /** Final merged resource vector for one step: resource -> quantity string. */
  resources: { resource: string; quantity: string }[];
}

export interface StepQuoteLine {
  resource: string;
  quantity: string;
  measurementUnit: string;
  unitSize: string;
  numerator: string;
  denominator: string;
}

export interface StepQuote {
  priceVersionId: string;
  rounding: "half_up";
  lines: StepQuoteLine[];
  totalMicrocredits: string;
  totalDisplay: string;
}

export interface QueryPeriodInput {
  organizationId: string;
  /** Trusted original activation anchor (server-confirmed activation instant). */
  originalPurchasedAtUs: string;
  /** Either an explicit target period index or an occurrence time to locate. */
  targetPeriodIndex?: string;
  occurrenceUs?: string;
}

export interface PeriodAnswer {
  timezone: "Asia/Shanghai";
  anchor: {
    utcUs: string;
    utcIso: string;
    local: LocalWallTime;
  };
  period: {
    index: string;
    startUs: string;
    endUs: string;
    startIso: string;
    endIso: string;
    startLocal: LocalWallTime;
    endLocal: LocalWallTime;
  };
}

export interface CatalogVersionSnapshot {
  releaseId: string;
  contentDigest: string;
  status: string;
  environment: string;
  effectiveFromUs: string;
  effectiveToUs: string | null;
  basicQuota: {
    quotaVersionId: string;
    tier: string;
    quotas: { resource_key: string; limit: string; unit: string }[];
  } | null;
  items: {
    productVersionId: string;
    productId: string;
    productType: string;
    displayName: string;
    amountFen: string;
    currency: string;
    grantedMicrocredits: string | null;
    periodMonths: number | null;
    priceVersionId: string;
    quotaVersionId: string | null;
    quota: {
      quotaVersionId: string;
      tier: string;
      quotas: { resource_key: string; limit: string; unit: string }[];
    } | null;
    runCapVersionId: string;
    runCapMicrocredits: string;
    prices: {
      resource: string;
      measurementUnit: string;
      unitSize: string;
      numerator: string;
      denominator: string;
    }[];
  }[];
}

/** Serialize a quota spec into the contract's closed quota-content shape. */
function serializeQuotaContent(
  quotaVersionId: string,
  tier: string,
  spec: { quotas: { resource_key: string; limit: string; unit: string }[] },
): {
  quotaVersionId: string;
  tier: string;
  quotas: { resource_key: string; limit: string; unit: string }[];
} {
  return {
    quotaVersionId,
    tier,
    quotas: spec.quotas.map((q) => ({
      resource_key: q.resource_key,
      limit: q.limit,
      unit: q.unit,
    })),
  };
}

export class CatalogServiceError extends Error {
  readonly code:
    | "invalid_integer"
    | "out_of_range"
    | "forbidden"
    | "resource_not_found"
    | "state_conflict"
    | "price_version_conflict"
    | "ledger_unavailable";
  readonly status: number;
  readonly field?: string;

  constructor(
    code: CatalogServiceError["code"],
    message: string,
    field?: string,
  ) {
    super(message);
    this.name = "CatalogServiceError";
    this.code = code;
    this.status =
      code === "resource_not_found"
        ? 404
        : code === "forbidden"
          ? 403
          : code === "state_conflict" || code === "price_version_conflict"
            ? 409
            : code === "ledger_unavailable"
              ? 503
              : 422;
    this.field = field;
  }
}

export function createBillingCatalogService(deps: {
  database: Database;
  clock: TrustedClock;
  trustedState?: TrustedStateReader;
}): BillingCatalogService {
  const { database, clock } = deps;

  return {
    async publishRelease(input) {
      try {
        return await publishRelease(database, input);
      } catch (e) {
        if (e instanceof CatalogConfigurationError) {
          throw new CatalogServiceError("out_of_range", e.message);
        }
        throw mapStorageError(e);
      }
    },

    async quoteProduct(input) {
      const now = clock.nowUs();
      const scope: ScopeKey = {
        organizationId: input.organizationId,
        billingAccountId: input.billingAccountId,
        environment: input.environment ?? "production",
      };
      let selection: Awaited<ReturnType<typeof selectReleaseForQuote>>;
      try {
        selection = await selectReleaseForQuote(database, scope, now);
      } catch (e) {
        throw mapStorageError(e);
      }
      const quotedAtUs = now.toString();
      // The test-only marker reflects the environment the release was
      // actually selected from: a test-authorized quote of a test catalog
      // carries test_only=true so a test number can never masquerade as a
      // production price downstream.
      const testOnly = (input.environment ?? "production") === "test";
      if (!selection.ok) {
        return {
          sellable: false,
          notSellableReason: selection.reason,
          testOnly,
          quotedAtUs,
        };
      }
      const item = selection.release.items.find(
        (i) => i.productVersion.productId === input.productId,
      );
      if (!item) {
        return {
          sellable: false,
          notSellableReason: "product_not_in_release",
          testOnly,
          quotedAtUs,
        };
      }
      if (
        input.expectedPriceVersionId &&
        input.expectedPriceVersionId !== item.priceVersion.id
      ) {
        throw new CatalogServiceError(
          "price_version_conflict",
          `expected price version ${input.expectedPriceVersionId} is not the version the current release pins (${item.priceVersion.id})`,
        );
      }
      if (
        item.quotaVersion === null &&
        item.productVersion.productType === "monthly_plan"
      ) {
        return {
          sellable: false,
          notSellableReason: "quota_version_missing",
          testOnly,
          quotedAtUs,
        };
      }
      if (!selection.release.basicQuota) {
        // Selection mode rejects this closed; the guard is defensive for
        // type-narrowing only.
        return {
          sellable: false,
          notSellableReason: "release_incomplete",
          testOnly,
          quotedAtUs,
        };
      }
      const snapshot: SellableSnapshot = {
        releaseId: selection.release.id,
        releaseContentDigest: selection.release.contentDigest,
        scopeIsAccountSpecific: selection.release.scopeIsAccountSpecific,
        productVersionId: item.productVersion.id,
        productId: item.productVersion.productId,
        productType: item.productVersion.productType as
          | "monthly_plan"
          | "credit_pack",
        displayName: item.productVersion.displayName,
        amountFen: item.productVersion.priceFen.toString(),
        currency: "CNY",
        grantedMicrocredits:
          item.productVersion.grantedMicrocredits?.toString() ?? null,
        periodMonths: item.productVersion.periodMonths ?? null,
        longLived: item.productVersion.productType === "credit_pack",
        priceVersionId: item.priceVersion.id,
        quotaVersionId: item.quotaVersion?.id ?? null,
        basicQuotaVersionId: selection.release.basicQuota.id,
        runCapVersionId: item.runCap.id,
        runCapMicrocredits: item.runCap.capMicrocredits.toString(),
      };

      // Eligibility and period preview need the trusted projection; a missing
      // reader (or an unreadable projection) must not silently pass.
      let eligibility: EligibilityOutcome | undefined;
      let periodPreview: ProductQuote["periodPreview"];
      if (input.includeEligibility !== false) {
        if (!deps.trustedState) {
          throw new CatalogServiceError(
            "ledger_unavailable",
            "no trusted subscription-state reader is configured; eligibility cannot be determined",
          );
        }
        let snap: TrustedSubscriptionSnapshot;
        try {
          snap = await deps.trustedState.readSubscriptionSnapshot(scope, now);
        } catch (e) {
          throw mapStorageError(e);
        }
        eligibility = evaluatePurchaseEligibility({
          requestedProductId: input.productId,
          requestedProductType: item.productVersion.productType as
            | "monthly_plan"
            | "credit_pack",
          nowUs: now,
          snapshot: snap,
        });
        const sub = snap.subscription;
        if (eligibility.targetPeriod && sub) {
          const p = periodByIndex(sub.anchor, eligibility.targetPeriod.index);
          periodPreview = {
            index: p.index,
            startUs: p.startUs.toString(),
            endUs: p.endUs.toString(),
            startIso: p.startIso,
            endIso: p.endIso,
          };
        } else {
          // Fresh purchase: the anchor is set at actual activation (#68), not
          // at payment time; no period is previewed or locked here.
          periodPreview = null;
        }
      }
      return {
        sellable: true,
        testOnly,
        snapshot,
        periodPreview: periodPreview ?? null,
        eligibility,
        quotedAtUs,
      };
    },

    async resolveCurrentPrice(input) {
      const now = clock.nowUs();
      const scope: ScopeKey = {
        organizationId: input.organizationId,
        billingAccountId: input.billingAccountId,
        environment: input.environment ?? "production",
      };
      let selection: Awaited<ReturnType<typeof selectReleaseForQuote>>;
      try {
        selection = await selectReleaseForQuote(database, scope, now);
      } catch (e) {
        throw mapStorageError(e);
      }
      const quotedAtUs = now.toString();
      const testOnly = (input.environment ?? "production") === "test";
      if (!selection.ok) {
        return {
          sellable: false,
          notSellableReason: selection.reason,
          testOnly,
          prices: [],
          quotedAtUs,
        };
      }
      let item = selection.release.items[0];
      if (input.productId !== undefined) {
        const found = selection.release.items.find(
          (i) => i.productVersion.productId === input.productId,
        );
        if (!found) {
          return {
            sellable: false,
            notSellableReason: "product_not_in_release",
            testOnly,
            prices: [],
            quotedAtUs,
          };
        }
        item = found;
      } else {
        // One price per step basis: a release whose items pin different price
        // versions has no single current price to resolve — fail closed.
        const version = selection.release.items[0].priceVersion.id;
        if (
          selection.release.items.some((i) => i.priceVersion.id !== version)
        ) {
          return {
            sellable: false,
            notSellableReason: "ambiguous_release_configuration",
            testOnly,
            prices: [],
            quotedAtUs,
          };
        }
      }
      return {
        sellable: true,
        testOnly,
        releaseId: selection.release.id,
        releaseContentDigest: selection.release.contentDigest,
        scopeIsAccountSpecific: selection.release.scopeIsAccountSpecific,
        priceVersionId: item.priceVersion.id,
        runCapVersionId: item.runCap.id,
        runCapMicrocredits: item.runCap.capMicrocredits.toString(),
        prices: item.priceResources
          .slice()
          .sort((a, b) => (a.resource < b.resource ? -1 : 1))
          .map((r) => ({
            resource: r.resource,
            measurementUnit: r.measurementUnit,
            unitSize: r.unitSize.toString(),
            numerator: r.numerator.toString(),
            denominator: r.denominator.toString(),
          })),
        quotedAtUs,
      };
    },

    async quoteStep(input) {
      if (input.resources.length === 0) {
        throw new CatalogServiceError(
          "out_of_range",
          "a step quote requires at least one resource line",
          "resources",
        );
      }
      if (
        input.expectedPriceVersionId !== undefined &&
        input.expectedPriceVersionId !== input.priceVersionId
      ) {
        // The reserved fixed reference recorded at pricing time is the ONLY
        // version a step may be (re)computed against; a divergence means the
        // caller is trying to price the step under another configuration.
        throw new CatalogServiceError(
          "price_version_conflict",
          `step is pinned to reserved price version ${input.expectedPriceVersionId}; quoting ${input.priceVersionId} would reprice it`,
        );
      }
      let replay: Awaited<ReturnType<typeof loadPriceVersionForReplay>>;
      try {
        replay = await loadPriceVersionForReplay(
          database,
          input.organizationId,
          input.priceVersionId,
          input.billingAccountIds,
          input.environment ?? "production",
        );
      } catch (e) {
        throw mapStorageError(e);
      }
      if (!replay) {
        throw new CatalogServiceError(
          "resource_not_found",
          `no published price version ${input.priceVersionId} is quotable in this organization and environment`,
        );
      }
      const priced = new Map(
        replay.resources.map((r) => [r.resource as string, r]),
      );
      const lines = input.resources.map((line) => {
        if (!(PRICED_RESOURCES as readonly string[]).includes(line.resource)) {
          throw new CatalogServiceError(
            "out_of_range",
            `resource ${line.resource} is not a priced resource (quantity zero does not excuse an unknown resource)`,
            "resources.resource",
          );
        }
        const row = priced.get(line.resource);
        if (!row) {
          throw new CatalogServiceError(
            "out_of_range",
            `resource ${line.resource} has no price in version ${input.priceVersionId}`,
            "resources.resource",
          );
        }
        validatePriceEntry({
          numerator: row.numerator,
          denominator: row.denominator,
          unitSize: row.unitSize,
          measurementUnit: row.measurementUnit as MeasurementUnit,
        });
        return {
          resource: line.resource as PricedResource,
          quantity: line.quantity,
          price: {
            numerator: row.numerator,
            denominator: row.denominator,
            unitSize: row.unitSize,
          },
        };
      });
      let total: bigint;
      try {
        total = stepCostMicrocreditsExact(
          lines.map((l) => ({
            resource: l.resource,
            quantity: l.quantity,
            price: l.price,
          })),
        );
      } catch (e) {
        if (e instanceof BillingValueError) {
          throw new CatalogServiceError(e.code, e.message, "resources");
        }
        throw e;
      }
      const display = formatMicrocreditsDisplay(total);
      return {
        priceVersionId: replay.priceVersion.id,
        rounding: "half_up",
        lines: lines.map((l) => ({
          resource: l.resource,
          quantity: l.quantity.toString(),
          measurementUnit: priced.get(l.resource)?.measurementUnit ?? "",
          unitSize: (priced.get(l.resource)?.unitSize ?? 0n).toString(),
          numerator: (priced.get(l.resource)?.numerator ?? 0n).toString(),
          denominator: (priced.get(l.resource)?.denominator ?? 0n).toString(),
        })),
        totalMicrocredits: total.toString(),
        totalDisplay: display,
      };
    },

    async queryPeriod(input) {
      const activation = parseUs(
        input.originalPurchasedAtUs,
        "original_purchased_at_us",
      );
      const anchor = anchorFromActivation(activation);
      let period: ReturnType<typeof periodByIndex>;
      if (input.targetPeriodIndex !== undefined) {
        period = periodByIndex(
          anchor.local,
          parseIndex(input.targetPeriodIndex),
        );
      } else if (input.occurrenceUs !== undefined) {
        period = periodOf(
          anchor.local,
          parseUs(input.occurrenceUs, "occurrence_us"),
        );
      } else {
        throw new CatalogServiceError(
          "out_of_range",
          "provide either target_period_index or occurrence_us",
        );
      }
      return {
        timezone: "Asia/Shanghai",
        anchor: {
          utcUs: anchor.utcUs.toString(),
          utcIso: anchor.utcIso,
          local: anchor.local,
        },
        period: {
          index: period.index.toString(),
          startUs: period.startUs.toString(),
          endUs: period.endUs.toString(),
          startIso: period.startIso,
          endIso: period.endIso,
          startLocal: period.startLocal,
          endLocal: period.endLocal,
        },
      };
    },

    async getCatalogVersion(input) {
      let snapshot: Awaited<ReturnType<typeof loadReleaseSnapshot>>;
      try {
        snapshot = await loadReleaseSnapshot(
          database,
          input.organizationId,
          input.releaseId,
          input.billingAccountIds,
        );
      } catch (e) {
        throw mapStorageError(e);
      }
      if (!snapshot) {
        throw new CatalogServiceError(
          "resource_not_found",
          `catalog release ${input.releaseId} does not exist in this organization`,
        );
      }
      return {
        releaseId: snapshot.release.id,
        contentDigest: snapshot.release.contentDigest,
        status: snapshot.release.status,
        environment: snapshot.release.environment,
        effectiveFromUs: snapshot.release.effectiveFromUs.toString(),
        effectiveToUs: snapshot.release.effectiveToUs?.toString() ?? null,
        basicQuota: snapshot.basicQuota
          ? serializeQuotaContent(
              snapshot.basicQuota.id,
              snapshot.basicQuota.tier,
              snapshot.basicQuota.spec,
            )
          : null,
        items: snapshot.items.map((item) => ({
          productVersionId: item.productVersion.id,
          productId: item.productVersion.productId,
          productType: item.productVersion.productType,
          displayName: item.productVersion.displayName,
          amountFen: item.productVersion.priceFen.toString(),
          currency: item.productVersion.currency,
          grantedMicrocredits:
            item.productVersion.grantedMicrocredits?.toString() ?? null,
          periodMonths: item.productVersion.periodMonths ?? null,
          priceVersionId: item.priceVersion.id,
          quotaVersionId: item.quotaVersion?.id ?? null,
          quota: item.quotaVersion
            ? serializeQuotaContent(
                item.quotaVersion.id,
                item.quotaVersion.tier,
                item.quotaVersion.spec,
              )
            : null,
          runCapVersionId: item.runCap.id,
          runCapMicrocredits: item.runCap.capMicrocredits.toString(),
          prices: item.priceResources.map((r) => ({
            resource: r.resource,
            measurementUnit: r.measurementUnit,
            unitSize: r.unitSize.toString(),
            numerator: r.numerator.toString(),
            denominator: r.denominator.toString(),
          })),
        })),
      };
    },
  };

  function parseUs(raw: string, field: string): bigint {
    try {
      if (typeof raw !== "string" || !/^(0|[1-9][0-9]{0,18})$/.test(raw)) {
        throw new BillingValueError(
          "invalid_integer",
          "not a contract decimal string",
        );
      }
      return parseTimestampUs(raw);
    } catch (e) {
      if (e instanceof BillingValueError) {
        throw new CatalogServiceError(e.code, `${field}: ${e.message}`, field);
      }
      throw e;
    }
  }

  function parseIndex(raw: string): bigint {
    if (typeof raw !== "string" || !/^(0|[1-9][0-9]{0,9})$/.test(raw)) {
      throw new CatalogServiceError(
        "invalid_integer",
        "target_period_index must be a small non-negative decimal string",
        "target_period_index",
      );
    }
    return BigInt(raw);
  }
}

function mapStorageError(e: unknown): Error {
  if (e instanceof CatalogServiceError) return e;
  return new CatalogServiceError(
    "ledger_unavailable",
    `catalog storage unavailable: ${e instanceof Error ? e.message : String(e)}`,
  );
}
