/**
 * Catalog persistence (#65): publish transactions and history/selection reads.
 *
 * Publishing locks the (organization, account scope, environment) publish slot
 * with a transaction advisory lock, so concurrent publishes serialize instead
 * of racing two releases over the same interval. Integrity is checked INSIDE
 * the transaction: references must exist in the same scope and environment,
 * business content must be active, every release product resolves a price, and
 * no active release of the same scope overlaps the new effective interval —
 * selection must never face two same-priority candidates.
 *
 * A previous release with an open end is closed at the successor's start and
 * the routing change is recorded in billing_catalog_release_handovers; the old
 * release's business content is never rewritten, so historical quotes keep
 * replaying it.
 *
 * Selection never uses wall-clock time: the caller passes the trusted instant.
 * Account-specific releases win over organization-global ones; an existing
 * account-specific release that is expired/not-yet-active fails the quote
 * CLOSED (reason `account_release_unavailable`) rather than silently falling
 * back to the generic release.
 */

import { and, asc, eq, gt, isNull, lt, lte, or, sql } from "drizzle-orm";
import {
  BillingValueError,
  parseTimestampUs,
} from "../billing-contract/money-time.js";
import type { Database } from "../db/client";
import {
  type BillingQuotaSpec,
  billingCatalogReleaseHandovers,
  billingCatalogReleaseItems,
  billingCatalogReleases,
  billingPriceResources,
  billingPriceVersions,
  billingProductVersions,
  billingQuotaVersions,
  billingRunCapVersions,
} from "../db/schema";
import { type MeasurementUnit, validatePriceEntry } from "./pricing.js";

type DatabaseLike = Database;
/** What a helper running INSIDE the publish transaction receives. */
type TxLike = Parameters<Parameters<Database["transaction"]>[0]>[0];

export interface ScopeKey {
  organizationId: string;
  /** null = organization-global scope. */
  billingAccountId: string | null;
  environment: "production" | "test";
}

export interface PublishReleaseInput extends ScopeKey {
  effectiveFromUs: bigint;
  effectiveToUs: bigint | null;
  /** product_version_id -> price_version_id for this release. */
  items: {
    productVersionId: string;
    priceVersionId: string;
    quotaVersionId: string | null;
  }[];
  createdAtUs: bigint;
}

export interface PublishedRelease {
  id: string;
  contentDigest: string;
}

export class CatalogConfigurationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CatalogConfigurationError";
  }
}

function hashDigest(parts: string[]): string {
  // SHA-256 over the sorted reference list; content, not randomness, decides.
  // Bun's crypto is synchronous enough here via Bun.CryptoHasher.
  const hasher = new Bun.CryptoHasher("sha256");
  for (const p of parts) {
    hasher.update(p);
    hasher.update("\n");
  }
  return hasher.digest("hex");
}

async function loadPriceVersion(tx: TxLike, id: string, scope: ScopeKey) {
  const [row] = await tx
    .select()
    .from(billingPriceVersions)
    .where(eq(billingPriceVersions.id, id));
  if (!row)
    throw new CatalogConfigurationError(`price version ${id} does not exist`);
  if (
    row.organizationId !== scope.organizationId ||
    row.billingAccountId !== scope.billingAccountId ||
    row.environment !== scope.environment
  ) {
    throw new CatalogConfigurationError(
      `price version ${id} is outside the release scope (cross-scope references are rejected)`,
    );
  }
  if (row.status === "draft") {
    throw new CatalogConfigurationError(`price version ${id} is still draft`);
  }
  const resources = await tx
    .select()
    .from(billingPriceResources)
    .where(eq(billingPriceResources.priceVersionId, id))
    .orderBy(asc(billingPriceResources.resource));
  if (resources.length === 0) {
    throw new CatalogConfigurationError(
      `price version ${id} prices no resources`,
    );
  }
  for (const r of resources) {
    validatePriceEntry({
      numerator: r.numerator,
      denominator: r.denominator,
      unitSize: r.unitSize,
      measurementUnit: r.measurementUnit as MeasurementUnit,
    });
  }
  const [cap] = await tx
    .select()
    .from(billingRunCapVersions)
    .where(eq(billingRunCapVersions.id, row.defaultRootRunCapVersionId));
  if (!cap) {
    throw new CatalogConfigurationError(
      `price version ${id} references a missing run cap version`,
    );
  }
  if (
    cap.organizationId !== scope.organizationId ||
    cap.billingAccountId !== scope.billingAccountId ||
    cap.environment !== scope.environment
  ) {
    throw new CatalogConfigurationError(
      `price version ${id} references a run cap outside the release scope`,
    );
  }
  if (cap.capMicrocredits !== row.defaultRootRunCapMicrocredits) {
    throw new CatalogConfigurationError(
      `price version ${id} embeds a run cap value that diverges from its referenced run cap version`,
    );
  }
  return { row, resources, cap };
}

/**
 * Append one immutable release in a single transaction. All versions referenced
 * must already exist, be active (or retired for history-only references —
 * never draft), live in the SAME scope/environment, and not overlap the
 * already-selected active interval of the scope.
 */
export async function publishRelease(
  db: DatabaseLike,
  input: PublishReleaseInput,
): Promise<PublishedRelease> {
  parseTimestampUs(input.effectiveFromUs.toString());
  if (input.effectiveToUs !== null) {
    const to = parseTimestampUs(input.effectiveToUs.toString());
    if (to <= input.effectiveFromUs) {
      throw new BillingValueError(
        "out_of_range",
        "release effective interval must be half-open and non-empty",
      );
    }
  }
  if (input.items.length === 0) {
    throw new CatalogConfigurationError(
      "a release must carry at least one product",
    );
  }
  return db.transaction(async (tx) => {
    // Serialize publishes per scope so interval bookkeeping cannot race.
    const slot = `${input.organizationId}|${input.billingAccountId ?? "-"}|${input.environment}`;
    await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${slot}))`);

    const seen = new Set<string>();
    const digestParts: string[] = [];
    for (const item of input.items) {
      if (seen.has(item.productVersionId)) {
        throw new CatalogConfigurationError(
          `product version ${item.productVersionId} listed twice in one release`,
        );
      }
      seen.add(item.productVersionId);
      const [product] = await tx
        .select()
        .from(billingProductVersions)
        .where(eq(billingProductVersions.id, item.productVersionId));
      if (!product) {
        throw new CatalogConfigurationError(
          `product version ${item.productVersionId} does not exist`,
        );
      }
      if (
        product.organizationId !== input.organizationId ||
        product.billingAccountId !== input.billingAccountId ||
        product.environment !== input.environment
      ) {
        throw new CatalogConfigurationError(
          `product version ${item.productVersionId} is outside the release scope`,
        );
      }
      if (product.status === "draft") {
        throw new CatalogConfigurationError(
          `product version ${item.productVersionId} is still draft`,
        );
      }
      const price = await loadPriceVersion(tx, item.priceVersionId, input);
      if (item.quotaVersionId !== null) {
        const [quota] = await tx
          .select()
          .from(billingQuotaVersions)
          .where(eq(billingQuotaVersions.id, item.quotaVersionId));
        if (!quota) {
          throw new CatalogConfigurationError(
            `quota version ${item.quotaVersionId} does not exist`,
          );
        }
        if (
          quota.organizationId !== input.organizationId ||
          quota.billingAccountId !== input.billingAccountId ||
          quota.environment !== input.environment
        ) {
          throw new CatalogConfigurationError(
            `quota version ${item.quotaVersionId} is outside the release scope`,
          );
        }
        if (
          product.productType !== "monthly_plan" ||
          product.quotaVersionId === null
        ) {
          throw new CatalogConfigurationError(
            `product ${product.productId} is not a monthly plan but references a quota version`,
          );
        }
        if (quota.id !== product.quotaVersionId) {
          throw new CatalogConfigurationError(
            `release quota ${quota.id} diverges from the product version's own quota reference`,
          );
        }
        validateQuotaSpec(quota.spec);
      } else if (product.productType === "monthly_plan") {
        throw new CatalogConfigurationError(
          `monthly plan ${product.productId} needs its quota version in the release`,
        );
      }
      digestParts.push(
        JSON.stringify([
          item.productVersionId,
          product.revision.toString(),
          item.priceVersionId,
          price.row.revision.toString(),
          price.resources.map(
            (r) =>
              `${r.resource}:${r.measurementUnit}:${r.unitSize}/${r.numerator}/${r.denominator}`,
          ),
          price.row.defaultRootRunCapVersionId,
          price.cap.capMicrocredits.toString(),
        ]),
      );
    }

    // Selection must never face two same-priority candidates. An open-ended
    // PREDECESSOR (start strictly before the new interval) is not a conflict:
    // publish closes it at the new boundary with an audited handover record.
    // Genuine conflicts are rejected:
    //   a) an existing release starting at/after the new start while the new
    //      interval is still open there (two selectors at or after the start);
    //   b) a FINITE existing interval crossing the new start (publish only
    //      closes open-ended predecessors, never truncates a bounded one).
    const scopeFilter = and(
      eq(billingCatalogReleases.organizationId, input.organizationId),
      input.billingAccountId === null
        ? isNull(billingCatalogReleases.billingAccountId)
        : eq(billingCatalogReleases.billingAccountId, input.billingAccountId),
      eq(billingCatalogReleases.environment, input.environment),
      or(
        eq(billingCatalogReleases.status, "active"),
        eq(billingCatalogReleases.status, "draft"),
      ),
    );
    const candidates = await tx
      .select({
        id: billingCatalogReleases.id,
        effectiveFromUs: billingCatalogReleases.effectiveFromUs,
        effectiveToUs: billingCatalogReleases.effectiveToUs,
      })
      .from(billingCatalogReleases)
      .where(scopeFilter);
    for (const r of candidates) {
      const startsAtOrAfterNewStart =
        r.effectiveFromUs >= input.effectiveFromUs;
      const newIntervalOpenThere =
        input.effectiveToUs === null || r.effectiveFromUs < input.effectiveToUs;
      if (startsAtOrAfterNewStart && newIntervalOpenThere) {
        throw new CatalogConfigurationError(
          `release interval overlaps existing release ${r.id} of the same scope`,
        );
      }
      if (
        r.effectiveFromUs < input.effectiveFromUs &&
        r.effectiveToUs !== null &&
        r.effectiveToUs > input.effectiveFromUs
      ) {
        throw new CatalogConfigurationError(
          `release interval crosses the bounded interval of existing release ${r.id}`,
        );
      }
    }

    const digest = hashDigest(digestParts.sort());
    const [release] = await tx
      .insert(billingCatalogReleases)
      .values({
        organizationId: input.organizationId,
        billingAccountId: input.billingAccountId,
        environment: input.environment,
        effectiveFromUs: input.effectiveFromUs,
        effectiveToUs: input.effectiveToUs,
        contentDigest: digest,
        status: "active",
        createdAtUs: input.createdAtUs,
        updatedAtUs: input.createdAtUs,
      })
      .returning({ id: billingCatalogReleases.id });
    for (const item of input.items) {
      await tx.insert(billingCatalogReleaseItems).values({
        releaseId: release.id,
        productVersionId: item.productVersionId,
        priceVersionId: item.priceVersionId,
        quotaVersionId: item.quotaVersionId,
      });
    }

    // Close an open-ended predecessor of the same scope at the new boundary,
    // audited; the predecessor's business content is untouched.
    const predecessors = await tx
      .select({
        id: billingCatalogReleases.id,
        effectiveFromUs: billingCatalogReleases.effectiveFromUs,
      })
      .from(billingCatalogReleases)
      .where(
        and(
          scopeFilter,
          eq(billingCatalogReleases.status, "active"),
          isNull(billingCatalogReleases.effectiveToUs),
          lt(billingCatalogReleases.effectiveFromUs, input.effectiveFromUs),
        ),
      )
      .orderBy(asc(billingCatalogReleases.effectiveFromUs));
    for (const p of predecessors) {
      if (p.effectiveFromUs >= input.effectiveFromUs) continue;
      await tx
        .update(billingCatalogReleases)
        .set({
          effectiveToUs: input.effectiveFromUs,
          updatedAtUs: input.createdAtUs,
        })
        .where(eq(billingCatalogReleases.id, p.id));
      await tx.insert(billingCatalogReleaseHandovers).values({
        organizationId: input.organizationId,
        billingAccountId: input.billingAccountId,
        environment: input.environment,
        previousReleaseId: p.id,
        successorReleaseId: release.id,
        boundaryUs: input.effectiveFromUs,
        createdAtUs: input.createdAtUs,
      });
    }
    return { id: release.id, contentDigest: digest };
  });
}

const QUOTA_KEYS = ["concurrent_runs", "automatic_task_seats"] as const;

export function validateQuotaSpec(spec: BillingQuotaSpec): void {
  if (!Array.isArray(spec.quotas) || spec.quotas.length === 0) {
    throw new CatalogConfigurationError(
      "a quota version must define at least one quota",
    );
  }
  const seen = new Set<string>();
  for (const q of spec.quotas) {
    if (!QUOTA_KEYS.includes(q.resource_key)) {
      throw new CatalogConfigurationError(
        `quota resource key ${String(q.resource_key)} is outside the closed set`,
      );
    }
    if (seen.has(q.resource_key)) {
      throw new CatalogConfigurationError(
        `quota resource key ${q.resource_key} defined twice`,
      );
    }
    seen.add(q.resource_key);
    const limit = BigInt(q.limit);
    if (limit < 0n || limit > 9223372036854775807n) {
      throw new CatalogConfigurationError(
        `quota limit ${q.limit} outside the int64 range`,
      );
    }
    if (q.unit !== "count") {
      throw new CatalogConfigurationError(`quota unit must be count`);
    }
  }
}

export type SelectedRelease = Awaited<ReturnType<typeof selectReleaseForQuote>>;

/**
 * The release a quote at trusted instant `atUs` must use, with every referenced
 * version resolved. Selection order: account-specific first; an existing
 * account-specific release that does not cover `atUs` fails closed. Two valid
 * same-priority candidates are a configuration error (publish prevents them).
 */
export async function selectReleaseForQuote(
  db: DatabaseLike,
  scope: ScopeKey,
  atUs: bigint,
): Promise<
  | {
      ok: true;
      release: {
        id: string;
        contentDigest: string;
        scopeIsAccountSpecific: boolean;
        items: {
          productVersion: typeof billingProductVersions.$inferSelect;
          priceVersion: typeof billingPriceVersions.$inferSelect;
          priceResources: (typeof billingPriceResources.$inferSelect)[];
          runCap: typeof billingRunCapVersions.$inferSelect;
          quotaVersion: typeof billingQuotaVersions.$inferSelect | null;
        }[];
      };
    }
  | { ok: false; reason: string }
> {
  parseTimestampUs(atUs.toString());
  const scopeFilter = (accountSpecific: boolean) =>
    and(
      eq(billingCatalogReleases.organizationId, scope.organizationId),
      accountSpecific && scope.billingAccountId !== null
        ? eq(billingCatalogReleases.billingAccountId, scope.billingAccountId)
        : isNull(billingCatalogReleases.billingAccountId),
      eq(billingCatalogReleases.environment, scope.environment),
      eq(billingCatalogReleases.status, "active"),
      lte(billingCatalogReleases.effectiveFromUs, atUs),
      or(
        isNull(billingCatalogReleases.effectiveToUs),
        gt(billingCatalogReleases.effectiveToUs, atUs),
      ),
    );

  if (scope.billingAccountId !== null) {
    const accountScoped = await db
      .select({ id: billingCatalogReleases.id })
      .from(billingCatalogReleases)
      .where(
        and(
          eq(billingCatalogReleases.organizationId, scope.organizationId),
          eq(billingCatalogReleases.billingAccountId, scope.billingAccountId),
          eq(billingCatalogReleases.environment, scope.environment),
        ),
      );
    if (accountScoped.length > 0) {
      // An account-specific catalog exists: it wins or the quote fails closed.
      const covering = await db
        .select()
        .from(billingCatalogReleases)
        .where(scopeFilter(true));
      if (covering.length === 0) {
        return { ok: false, reason: "account_release_unavailable" };
      }
      if (covering.length > 1) {
        return { ok: false, reason: "ambiguous_release_configuration" };
      }
      const resolved = await resolveReleaseItems(db, covering[0].id);
      if (!resolved.ok) return resolved;
      return {
        ok: true,
        release: { ...resolved.release, scopeIsAccountSpecific: true },
      };
    }
  }
  const covering = await db
    .select()
    .from(billingCatalogReleases)
    .where(scopeFilter(false));
  if (covering.length === 0)
    return { ok: false, reason: "no_published_release" };
  if (covering.length > 1)
    return { ok: false, reason: "ambiguous_release_configuration" };
  const resolved = await resolveReleaseItems(db, covering[0].id);
  if (!resolved.ok) return resolved;
  return {
    ok: true,
    release: { ...resolved.release, scopeIsAccountSpecific: false },
  };
}

async function resolveReleaseItems(
  db: DatabaseLike,
  releaseId: string,
): Promise<
  | {
      ok: true;
      release: {
        id: string;
        contentDigest: string;
        scopeIsAccountSpecific: boolean;
        items: {
          productVersion: typeof billingProductVersions.$inferSelect;
          priceVersion: typeof billingPriceVersions.$inferSelect;
          priceResources: (typeof billingPriceResources.$inferSelect)[];
          runCap: typeof billingRunCapVersions.$inferSelect;
          quotaVersion: typeof billingQuotaVersions.$inferSelect | null;
        }[];
      };
    }
  | { ok: false; reason: string }
> {
  const [release] = await db
    .select()
    .from(billingCatalogReleases)
    .where(eq(billingCatalogReleases.id, releaseId));
  if (!release) return { ok: false, reason: "release_vanished" };
  const items = await db
    .select()
    .from(billingCatalogReleaseItems)
    .where(eq(billingCatalogReleaseItems.releaseId, releaseId));
  const resolved: {
    productVersion: typeof billingProductVersions.$inferSelect;
    priceVersion: typeof billingPriceVersions.$inferSelect;
    priceResources: (typeof billingPriceResources.$inferSelect)[];
    runCap: typeof billingRunCapVersions.$inferSelect;
    quotaVersion: typeof billingQuotaVersions.$inferSelect | null;
  }[] = [];
  for (const item of items) {
    const [productVersion] = await db
      .select()
      .from(billingProductVersions)
      .where(eq(billingProductVersions.id, item.productVersionId));
    const [priceVersion] = await db
      .select()
      .from(billingPriceVersions)
      .where(eq(billingPriceVersions.id, item.priceVersionId));
    const priceResources = await db
      .select()
      .from(billingPriceResources)
      .where(eq(billingPriceResources.priceVersionId, item.priceVersionId));
    const [runCap] = await db
      .select()
      .from(billingRunCapVersions)
      .where(
        eq(
          billingRunCapVersions.id,
          priceVersion?.defaultRootRunCapVersionId ?? "",
        ),
      );
    const quotaVersion = item.quotaVersionId
      ? ((
          await db
            .select()
            .from(billingQuotaVersions)
            .where(eq(billingQuotaVersions.id, item.quotaVersionId))
        )[0] ?? null)
      : null;
    if (
      !productVersion ||
      !priceVersion ||
      !runCap ||
      priceResources.length === 0
    ) {
      // References are RESTRICT-deleted, so this is corruption, not history
      // loss; fail closed rather than serve a partial catalog.
      return { ok: false, reason: "release_incomplete" };
    }
    resolved.push({
      productVersion,
      priceVersion,
      priceResources,
      runCap,
      quotaVersion,
    });
  }
  return {
    ok: true,
    release: {
      id: release.id,
      contentDigest: release.contentDigest,
      scopeIsAccountSpecific: release.billingAccountId !== null,
      items: resolved,
    },
  };
}

/**
 * Historical replay: resolve ANY price version by id regardless of status or
 * effective interval. Retired versions stay quotable forever — pinned steps
 * and orders recompute their exact cost from the same rows after restarts,
 * repricing and retirement. A version of another organization is invisible
 * (resource_not_found at the service boundary, never an existence leak).
 */
export async function loadPriceVersionForReplay(
  db: DatabaseLike,
  organizationId: string,
  priceVersionId: string,
): Promise<{
  priceVersion: typeof billingPriceVersions.$inferSelect;
  resources: (typeof billingPriceResources.$inferSelect)[];
} | null> {
  const [priceVersion] = await db
    .select()
    .from(billingPriceVersions)
    .where(
      and(
        eq(billingPriceVersions.id, priceVersionId),
        eq(billingPriceVersions.organizationId, organizationId),
      ),
    );
  if (!priceVersion) return null;
  const resources = await db
    .select()
    .from(billingPriceResources)
    .where(eq(billingPriceResources.priceVersionId, priceVersionId));
  if (resources.length === 0) return null;
  return { priceVersion, resources };
}

/** Full immutable version bundle by release id, for the history endpoint. */
export async function loadReleaseSnapshot(
  db: DatabaseLike,
  organizationId: string,
  releaseId: string,
) {
  const [release] = await db
    .select()
    .from(billingCatalogReleases)
    .where(
      and(
        eq(billingCatalogReleases.id, releaseId),
        eq(billingCatalogReleases.organizationId, organizationId),
      ),
    );
  if (!release) return null;
  const resolved = await resolveReleaseItems(db, releaseId);
  if (!resolved.ok) return null;
  return { release, items: resolved.release.items };
}
