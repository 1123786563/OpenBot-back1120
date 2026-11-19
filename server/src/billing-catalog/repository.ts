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

import {
  and,
  asc,
  eq,
  gt,
  inArray,
  isNull,
  lt,
  lte,
  or,
  sql,
} from "drizzle-orm";
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
import {
  type MeasurementUnit,
  PRICED_RESOURCES,
  RESOURCE_UNITS,
  validatePriceEntry,
} from "./pricing.js";

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
  /**
   * The BASIC-tier quota version of this release: the base resource ceilings
   * every account of the scope carries regardless of subscription. A release
   * cannot go on sale without it — missing base ceilings are an unfillable
   * promise, exactly like a missing price.
   */
  basicQuotaVersionId: string;
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

/**
 * The completeness a price version must satisfy to enter (or keep serving) a
 * release: EVERY closed priced resource carries a POSITIVE price in its
 * canonical measurement unit. A catalog that is missing one price or grants no
 * credits can never yield a sellable quote — the gap fails the publish and,
 * defensively, fails any current selection closed instead of quoting a partial
 * price list.
 */
function assertCompletePriceContent(
  id: string,
  resources: {
    resource: string;
    measurementUnit: string;
    unitSize: bigint;
    numerator: bigint;
    denominator: bigint;
  }[],
): void {
  const byResource = new Map(resources.map((r) => [r.resource, r]));
  if (byResource.size !== PRICED_RESOURCES.length) {
    throw new CatalogConfigurationError(
      `price version ${id} must price exactly the closed resource set once per resource`,
    );
  }
  for (const key of PRICED_RESOURCES) {
    const row = byResource.get(key);
    if (!row) {
      throw new CatalogConfigurationError(
        `price version ${id} does not price required resource ${key}`,
      );
    }
    if (row.measurementUnit !== RESOURCE_UNITS[key]) {
      throw new CatalogConfigurationError(
        `price version ${id} prices ${key} in ${row.measurementUnit}, but the canonical unit for ${key} is ${RESOURCE_UNITS[key]}`,
      );
    }
    if (row.numerator <= 0n) {
      throw new CatalogConfigurationError(
        `price version ${id} prices ${key} with a non-positive unit price`,
      );
    }
    validatePriceEntry({
      numerator: row.numerator,
      denominator: row.denominator,
      unitSize: row.unitSize,
      measurementUnit: row.measurementUnit as MeasurementUnit,
    });
  }
}

async function loadPriceVersion(
  tx: TxLike,
  id: string,
  scope: ScopeKey,
  releaseInterval: { fromUs: bigint; toUs: bigint | null },
) {
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
  if (row.status !== "active") {
    throw new CatalogConfigurationError(
      `price version ${id} is ${row.status}; only an active version may enter a release`,
    );
  }
  // The price must be valid across the whole release interval it is pinned
  // for: an open release demands an open price interval, and a bounded price
  // must cover the bounded release.
  if (row.effectiveFromUs > releaseInterval.fromUs) {
    throw new CatalogConfigurationError(
      `price version ${id} becomes effective after the release interval starts`,
    );
  }
  if (
    releaseInterval.toUs === null
      ? row.effectiveToUs !== null
      : row.effectiveToUs === null || row.effectiveToUs < releaseInterval.toUs
  ) {
    throw new CatalogConfigurationError(
      `price version ${id}'s valid interval does not cover the release interval`,
    );
  }
  const resources = await tx
    .select()
    .from(billingPriceResources)
    .where(eq(billingPriceResources.priceVersionId, id))
    .orderBy(asc(billingPriceResources.resource));
  assertCompletePriceContent(id, resources);
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
  if (cap.status !== "active") {
    throw new CatalogConfigurationError(
      `price version ${id} references a ${cap.status} run cap version`,
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
    // Serialize publishes per scope so interval bookkeeping cannot race. The
    // SAME scope lock is taken by every freeze trigger (see migration 0095),
    // so a concurrent guarded content write blocks until this transaction
    // commits — validation and commit are atomic against catalog writes.
    const slot = `${input.organizationId}|${input.billingAccountId ?? "-"}|${input.environment}`;
    await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${slot}))`);

    // The release-level BASIC quota: validated with the same strictness as
    // the per-product bindings, inside the same serialized transaction.
    const basicQuota = await loadQuotaVersion(
      tx,
      input.basicQuotaVersionId,
      input,
      "basic",
      "release basic quota version",
    );

    const seen = new Set<string>();
    const seenProductIds = new Set<string>();
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
      if (product.status !== "active") {
        throw new CatalogConfigurationError(
          `product version ${item.productVersionId} is ${product.status}; only an active version may enter a release`,
        );
      }
      // One version of each sellable product per release: two versions of the
      // same product_id would let selection pick one at random.
      if (seenProductIds.has(product.productId)) {
        throw new CatalogConfigurationError(
          `product ${product.productId} appears in more than one version of this release`,
        );
      }
      seenProductIds.add(product.productId);
      // A sellable product ALWAYS grants a benefit: a monthly plan without
      // granted credits or a pack without a positive grant is not a price
      // mistake, it is an unfillable promise — publish rejects it.
      if (product.grantedMicrocredits === null) {
        throw new CatalogConfigurationError(
          `product ${product.productId} grants no credits and cannot be sold`,
        );
      }
      if (
        product.productType === "credit_pack" &&
        product.grantedMicrocredits <= 0n
      ) {
        throw new CatalogConfigurationError(
          `credit pack ${product.productId} must grant a positive credit amount`,
        );
      }
      const price = await loadPriceVersion(tx, item.priceVersionId, input, {
        fromUs: input.effectiveFromUs,
        toUs: input.effectiveToUs,
      });
      if (item.quotaVersionId !== null) {
        const quota = await loadQuotaVersion(
          tx,
          item.quotaVersionId,
          input,
          "subscription",
          "quota version",
        );
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

    // The basic quota is part of the release's CONTENT: its id, revision and
    // spec all feed the digest so selection can detect drift on the base
    // ceilings exactly like on a price.
    digestParts.push(
      JSON.stringify([
        "basic_quota",
        basicQuota.id,
        basicQuota.revision.toString(),
        basicQuota.tier,
        basicQuota.spec,
      ]),
    );
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
        basicQuotaVersionId: basicQuota.id,
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
/** Contract decimal lexeme: a quota limit is never "1e3", " 5" or "+5". */
const QUOTA_LIMIT_RE = /^(0|[1-9][0-9]{0,18})$/;

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
    if (typeof q.limit !== "string" || !QUOTA_LIMIT_RE.test(q.limit)) {
      throw new CatalogConfigurationError(
        `quota limit ${String(q.limit)} is not a contract decimal lexeme`,
      );
    }
    const limit = BigInt(q.limit);
    if (limit > 9223372036854775807n) {
      throw new CatalogConfigurationError(
        `quota limit ${q.limit} outside the int64 range`,
      );
    }
    if (q.unit !== "count") {
      throw new CatalogConfigurationError(`quota unit must be count`);
    }
  }
}

/**
 * A quota version entering (or keeping serving) a release must carry the
 * WHOLE closed key set exactly once — the base ceilings are a bundle, and a
 * quota missing `automatic_task_seats` (for example) is not a smaller quota,
 * it is a missing entitlement.
 */
function assertCompleteQuotaContent(
  id: string,
  tier: "basic" | "subscription",
  spec: BillingQuotaSpec,
): void {
  validateQuotaSpec(spec);
  for (const key of QUOTA_KEYS) {
    if (!spec.quotas.some((q) => q.resource_key === key)) {
      throw new CatalogConfigurationError(
        `${tier} quota version ${id} does not define required quota ${key}`,
      );
    }
  }
}

/**
 * Resolve and validate the quota version a release or product references:
 * same scope, active, the expected tier, and the complete closed key set.
 */
async function loadQuotaVersion(
  tx: TxLike,
  id: string,
  scope: ScopeKey,
  expectedTier: "basic" | "subscription",
  role: string,
) {
  const [quota] = await tx
    .select()
    .from(billingQuotaVersions)
    .where(eq(billingQuotaVersions.id, id));
  if (!quota) {
    throw new CatalogConfigurationError(`${role} ${id} does not exist`);
  }
  if (
    quota.organizationId !== scope.organizationId ||
    quota.billingAccountId !== scope.billingAccountId ||
    quota.environment !== scope.environment
  ) {
    throw new CatalogConfigurationError(
      `${role} ${id} is outside the release scope (cross-scope references are rejected)`,
    );
  }
  if (quota.status !== "active") {
    throw new CatalogConfigurationError(
      `${role} ${id} is ${quota.status}; only an active quota may enter a release`,
    );
  }
  if (quota.tier !== expectedTier) {
    throw new CatalogConfigurationError(
      `${role} ${id} has tier ${quota.tier}, but this binding requires a ${expectedTier}-tier quota`,
    );
  }
  assertCompleteQuotaContent(quota.id, quota.tier, quota.spec);
  return quota;
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
        basicQuota: typeof billingQuotaVersions.$inferSelect | null;
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
      const resolved = await resolveReleaseItems(
        db,
        covering[0].id,
        "selection",
      );
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
  const resolved = await resolveReleaseItems(db, covering[0].id, "selection");
  if (!resolved.ok) return resolved;
  return {
    ok: true,
    release: { ...resolved.release, scopeIsAccountSpecific: false },
  };
}

/**
 * How a release's referenced versions are being read:
 * - "selection": the release is about to back a CURRENT quote — every
 *   referenced version must still be active and COMPLETE (full positive price
 *   coverage, granted credits, quota). A gap fails the quote closed; it is
 *   never served at a zero price or with a missing benefit.
 * - "history": the release snapshot is read for replay/audit — retired
 *   versions answer forever; only vanished references fail.
 */
type ResolutionMode = "selection" | "history";

async function resolveReleaseItems(
  db: DatabaseLike,
  releaseId: string,
  mode: ResolutionMode,
): Promise<
  | {
      ok: true;
      release: {
        id: string;
        contentDigest: string;
        scopeIsAccountSpecific: boolean;
        basicQuota: typeof billingQuotaVersions.$inferSelect | null;
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
  // The release-level basic quota: history mode resolves it for the snapshot
  // (missing is answered null by the caller); selection mode REQUIRES it —
  // a release without base ceilings is not sellable.
  const [basicQuota] = release.basicQuotaVersionId
    ? await db
        .select()
        .from(billingQuotaVersions)
        .where(eq(billingQuotaVersions.id, release.basicQuotaVersionId))
    : [];
  if (mode === "selection") {
    if (
      basicQuota?.status !== "active" ||
      (() => {
        try {
          assertCompleteQuotaContent(
            basicQuota.id,
            basicQuota.tier,
            basicQuota.spec,
          );
        } catch {
          return true;
        }
        return basicQuota.tier !== "basic";
      })()
    ) {
      return { ok: false, reason: "release_incomplete" };
    }
  }
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
    if (mode === "selection") {
      // A current quote may only be backed by active content. Retirement (or
      // any other inactive status) stops the sale closed; history still reads.
      if (
        productVersion.status !== "active" ||
        priceVersion.status !== "active" ||
        runCap.status !== "active" ||
        (quotaVersion !== null && quotaVersion.status !== "active")
      ) {
        return { ok: false, reason: "release_incomplete" };
      }
      try {
        assertCompletePriceContent(priceVersion.id, priceResources);
      } catch {
        return { ok: false, reason: "release_incomplete" };
      }
      if (
        productVersion.grantedMicrocredits === null ||
        (productVersion.productType === "credit_pack" &&
          productVersion.grantedMicrocredits <= 0n) ||
        (productVersion.productType === "monthly_plan" &&
          (quotaVersion === null || item.quotaVersionId === null))
      ) {
        return { ok: false, reason: "release_incomplete" };
      }
      // The subscription quota a monthly plan sells must be a complete
      // SUBSCRIPTION-tier quota — a basic-tier binding or a quota missing one
      // of the closed keys is an unfillable entitlement, never a smaller one.
      if (quotaVersion !== null) {
        try {
          assertCompleteQuotaContent(
            quotaVersion.id,
            quotaVersion.tier,
            quotaVersion.spec,
          );
        } catch {
          return { ok: false, reason: "release_incomplete" };
        }
        if (
          quotaVersion.tier !== "subscription" ||
          productVersion.productType !== "monthly_plan"
        ) {
          return { ok: false, reason: "release_incomplete" };
        }
      }
      if (
        runCap.capMicrocredits !== priceVersion.defaultRootRunCapMicrocredits
      ) {
        return { ok: false, reason: "release_incomplete" };
      }
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
      basicQuota: basicQuota ?? null,
      items: resolved,
    },
  };
}

/**
 * Historical replay: resolve a PUBLISHED price version by id regardless of
 * its current status or effective interval. "Published" means some release
 * has pinned it at least once — a draft, a never-released future version or
 * another environment's configuration was never a sellable price, and replay
 * refuses it exactly like a missing row (no existence leak). Retired versions
 * stay quotable forever — pinned steps and orders recompute their exact cost
 * from the same rows after restarts, repricing and retirement. A version of
 * another organization is invisible (resource_not_found at the service
 * boundary, never an existence leak), and so is a version scoped to another
 * billing account: `allowedBillingAccountIds` carries the caller's trusted
 * account authorization (null = unrestricted within the organization); a
 * version bound to an account outside it answers null exactly like a missing
 * row. `environment` is the caller's trusted deployment environment: a
 * production settlement never replays a test-environment price (and a test
 * run never replays production prices).
 */
export async function loadPriceVersionForReplay(
  db: DatabaseLike,
  organizationId: string,
  priceVersionId: string,
  allowedBillingAccountIds: string[] | null,
  environment: ScopeKey["environment"],
): Promise<{
  priceVersion: typeof billingPriceVersions.$inferSelect;
  resources: (typeof billingPriceResources.$inferSelect)[];
} | null> {
  const accountFilter =
    allowedBillingAccountIds === null
      ? undefined
      : or(
          isNull(billingPriceVersions.billingAccountId),
          inArray(
            billingPriceVersions.billingAccountId,
            allowedBillingAccountIds,
          ),
        );
  const [priceVersion] = await db
    .select()
    .from(billingPriceVersions)
    .where(
      and(
        eq(billingPriceVersions.id, priceVersionId),
        eq(billingPriceVersions.organizationId, organizationId),
        eq(billingPriceVersions.environment, environment),
        ...(accountFilter ? [accountFilter] : []),
      ),
    );
  if (!priceVersion) return null;
  // Replay resolves only versions a release has pinned at least once: an
  // arbitrary id that was never a sellable configuration must not become one
  // through the replay path (drafts and never-published future versions are
  // 404 here, indistinguishable from a missing row).
  const [pinned] = await db
    .select({ x: billingCatalogReleaseItems.id })
    .from(billingCatalogReleaseItems)
    .innerJoin(
      billingCatalogReleases,
      eq(billingCatalogReleases.id, billingCatalogReleaseItems.releaseId),
    )
    .where(
      and(
        eq(billingCatalogReleaseItems.priceVersionId, priceVersionId),
        eq(billingCatalogReleases.organizationId, organizationId),
        eq(billingCatalogReleases.environment, environment),
      ),
    )
    .limit(1);
  if (!pinned) return null;
  const resources = await db
    .select()
    .from(billingPriceResources)
    .where(eq(billingPriceResources.priceVersionId, priceVersionId));
  if (resources.length === 0) return null;
  return { priceVersion, resources };
}

/**
 * Full immutable version bundle by release id, for the history endpoint.
 * Environment-scoped like every other read: a release of another deployment
 * environment is invisible (a production settlement can never read a test
 * release's amounts, and vice versa — the test catalog stays behind the same
 * test-catalog authorization as the quote path). Account-scoped like replay:
 * a release bound to another billing account is invisible (404 at the service
 * boundary, never an existence leak); organization-global releases stay
 * readable.
 */
export async function loadReleaseSnapshot(
  db: DatabaseLike,
  organizationId: string,
  releaseId: string,
  allowedBillingAccountIds: string[] | null,
  environment: ScopeKey["environment"],
) {
  const accountFilter =
    allowedBillingAccountIds === null
      ? undefined
      : or(
          isNull(billingCatalogReleases.billingAccountId),
          inArray(
            billingCatalogReleases.billingAccountId,
            allowedBillingAccountIds,
          ),
        );
  const [release] = await db
    .select()
    .from(billingCatalogReleases)
    .where(
      and(
        eq(billingCatalogReleases.id, releaseId),
        eq(billingCatalogReleases.organizationId, organizationId),
        eq(billingCatalogReleases.environment, environment),
        ...(accountFilter ? [accountFilter] : []),
      ),
    );
  if (!release) return null;
  const resolved = await resolveReleaseItems(db, releaseId, "history");
  if (!resolved.ok) return null;
  return {
    release,
    basicQuota: resolved.release.basicQuota,
    items: resolved.release.items,
  };
}
