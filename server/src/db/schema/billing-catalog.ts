/**
 * Versioned billing catalog (#65): products, quotas, prices, run caps and the
 * immutable release that binds them.
 *
 * Money and time live in bigint columns mapped 1:1 to the contract's decimal
 * strings (microcredits, CNY fen, epoch microseconds); nothing is ever stored
 * or transported as a JS number. Published business content is immutable:
 * releases, and the versions they reference, are never updated in place — a
 * price change appends a successor version and a new release. `retired`
 * stops NEW selection only; historical quotes, steps and orders keep
 * resolving their pinned version ids forever.
 *
 * Scope model: `organization_id` is the configuration isolation boundary and
 * `billing_account_id` (null = organization-global) narrows a version to one
 * account's专属 pricing. The environment column separates `production` from
 * explicitly-marked `test` configurations; a test-only catalog can never be
 * selected for a production sale. The organization being in scope does NOT
 * imply a shared balance — balance ownership stays with the ledger (#64).
 */
import { sql } from "drizzle-orm";
import {
  bigint,
  check,
  index,
  integer,
  pgEnum,
  pgTable,
  text,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import { jsonb } from "./json";

export const billingConfigStatus = pgEnum("billing_config_status", [
  "draft",
  "active",
  "retired",
]);

export const billingEnvironment = pgEnum("billing_environment", [
  "production",
  "test",
]);

export const billingProductType = pgEnum("billing_product_type", [
  "monthly_plan",
  "credit_pack",
]);

export const billingQuotaTier = pgEnum("billing_quota_tier", [
  "basic",
  "subscription",
]);

export const billingMeasurementUnit = pgEnum("billing_measurement_unit", [
  "token",
  "request",
  "call",
  "millisecond",
]);

export const billingPricedResource = pgEnum("billing_priced_resource", [
  "model_input_tokens",
  "model_output_tokens",
  "model_cache_read_tokens",
  "model_cache_write_tokens",
  "model_web_search_requests",
  "model_request_count",
  "tool_call_count",
  "tool_call_duration_ms",
]);

/** bigint columns hold contract decimal strings exactly (mode: "bigint"). */
const contractInteger = (name: string) => bigint(name, { mode: "bigint" });

/**
 * Resource quotas of one tier. Closed keys only — a key outside this set is a
 * schema error, not extra configuration.
 */
export type BillingQuotaSpec = {
  quotas: {
    /** Concurrent run slots, or automatic-task seats, etc. Closed keys. */
    resource_key: "concurrent_runs" | "automatic_task_seats";
    /** Non-negative integer limit in the key's unit. */
    limit: string;
    unit: "count";
  }[];
};

export const billingQuotaVersions = pgTable(
  "billing_quota_versions",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    schemaVersion: text("schema_version").notNull().default("billing.v1"),
    organizationId: uuid("organization_id").notNull(),
    /** null = organization-global. */
    billingAccountId: uuid("billing_account_id"),
    environment: billingEnvironment("environment")
      .notNull()
      .default("production"),
    tier: billingQuotaTier("tier").notNull(),
    spec: jsonb("spec").$type<BillingQuotaSpec>().notNull(),
    status: billingConfigStatus("status").notNull().default("draft"),
    createdAtUs: contractInteger("created_at_us").notNull(),
    updatedAtUs: contractInteger("updated_at_us").notNull(),
    revision: contractInteger("revision").notNull().default(sql`1`),
  },
  (table) => [
    index("billing_quota_versions_scope_idx").on(
      table.organizationId,
      table.billingAccountId,
      table.environment,
    ),
    check(
      "billing_quota_versions_revision_positive",
      sql`${table.revision} >= 1`,
    ),
  ],
);

export const billingRunCapVersions = pgTable(
  "billing_run_cap_versions",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    schemaVersion: text("schema_version").notNull().default("billing.v1"),
    organizationId: uuid("organization_id").notNull(),
    billingAccountId: uuid("billing_account_id"),
    environment: billingEnvironment("environment")
      .notNull()
      .default("production"),
    /** Default root-run ceiling in whole microcredits; a Run pins it at creation. */
    capMicrocredits: contractInteger("cap_microcredits").notNull(),
    status: billingConfigStatus("status").notNull().default("draft"),
    createdAtUs: contractInteger("created_at_us").notNull(),
    updatedAtUs: contractInteger("updated_at_us").notNull(),
    revision: contractInteger("revision").notNull().default(sql`1`),
  },
  (table) => [
    index("billing_run_cap_versions_scope_idx").on(
      table.organizationId,
      table.billingAccountId,
      table.environment,
    ),
    check(
      "billing_run_cap_versions_cap_positive",
      sql`${table.capMicrocredits} > 0`,
    ),
  ],
);

export const billingPriceVersions = pgTable(
  "billing_price_versions",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    schemaVersion: text("schema_version").notNull().default("billing.v1"),
    organizationId: uuid("organization_id").notNull(),
    billingAccountId: uuid("billing_account_id"),
    environment: billingEnvironment("environment")
      .notNull()
      .default("production"),
    /** Half-open [effective_from_us, effective_to_us); null end = open until retired. */
    effectiveFromUs: contractInteger("effective_from_us").notNull(),
    effectiveToUs: contractInteger("effective_to_us"),
    /** Kept in sync with the referenced run cap version; never diverges. */
    defaultRootRunCapVersionId: uuid("default_root_run_cap_version_id")
      .notNull()
      .references(() => billingRunCapVersions.id, { onDelete: "restrict" }),
    defaultRootRunCapMicrocredits: contractInteger(
      "default_root_run_cap_microcredits",
    ).notNull(),
    status: billingConfigStatus("status").notNull().default("draft"),
    createdAtUs: contractInteger("created_at_us").notNull(),
    updatedAtUs: contractInteger("updated_at_us").notNull(),
    revision: contractInteger("revision").notNull().default(sql`1`),
  },
  (table) => [
    index("billing_price_versions_scope_idx").on(
      table.organizationId,
      table.billingAccountId,
      table.environment,
      table.effectiveFromUs,
    ),
    check(
      "billing_price_versions_interval_check",
      sql`${table.effectiveToUs} IS NULL OR ${table.effectiveToUs} > ${table.effectiveFromUs}`,
    ),
    check(
      "billing_price_versions_cap_positive",
      sql`${table.defaultRootRunCapMicrocredits} > 0`,
    ),
  ],
);

export const billingPriceResources = pgTable(
  "billing_price_resources",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    priceVersionId: uuid("price_version_id")
      .notNull()
      .references(() => billingPriceVersions.id, { onDelete: "restrict" }),
    resource: billingPricedResource("resource").notNull(),
    measurementUnit: billingMeasurementUnit("measurement_unit").notNull(),
    /** Price is per THIS many measurement units (the contract's U). */
    unitSize: contractInteger("unit_size").notNull(),
    numerator: contractInteger("numerator").notNull(),
    denominator: contractInteger("denominator").notNull(),
  },
  (table) => [
    // One price per resource per version — a duplicated resource key is a
    // configuration error, never "whichever the query finds first".
    uniqueIndex("billing_price_resources_unique_resource_idx").on(
      table.priceVersionId,
      table.resource,
    ),
    check(
      "billing_price_resources_unit_size_check",
      sql`${table.unitSize} > 0`,
    ),
    check(
      "billing_price_resources_denominator_check",
      sql`${table.denominator} > 0`,
    ),
    check(
      "billing_price_resources_numerator_check",
      sql`${table.numerator} >= 0`,
    ),
  ],
);

export const billingProductVersions = pgTable(
  "billing_product_versions",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    schemaVersion: text("schema_version").notNull().default("billing.v1"),
    organizationId: uuid("organization_id").notNull(),
    billingAccountId: uuid("billing_account_id"),
    environment: billingEnvironment("environment")
      .notNull()
      .default("production"),
    productId: text("product_id").notNull(),
    productType: billingProductType("product_type").notNull(),
    displayName: text("display_name").notNull(),
    /** CNY integer fen. Independent of credits; never implicitly converted. */
    priceFen: contractInteger("price_fen").notNull(),
    currency: text("currency").notNull().default("CNY"),
    /** Whole microcredits granted. Null for subscription tiers that only grant rights. */
    grantedMicrocredits: contractInteger("granted_microcredits"),
    /** 1 for monthly plans; null for long-lived packs (no monthly validity). */
    periodMonths: integer("period_months"),
    /** Subscription tiers reference their entitlement quota version. */
    quotaVersionId: uuid("quota_version_id").references(
      () => billingQuotaVersions.id,
      {
        onDelete: "restrict",
      },
    ),
    status: billingConfigStatus("status").notNull().default("draft"),
    createdAtUs: contractInteger("created_at_us").notNull(),
    updatedAtUs: contractInteger("updated_at_us").notNull(),
    revision: contractInteger("revision").notNull().default(sql`1`),
  },
  (table) => [
    index("billing_product_versions_scope_idx").on(
      table.organizationId,
      table.billingAccountId,
      table.environment,
      table.productId,
    ),
    check(
      "billing_product_versions_period_months_check",
      sql`${table.periodMonths} IS NULL OR ${table.periodMonths} = 1`,
    ),
    check(
      "billing_product_versions_type_shape_check",
      sql`(${table.productType} = 'monthly_plan' AND ${table.periodMonths} = 1 AND ${table.quotaVersionId} IS NOT NULL) OR (${table.productType} = 'credit_pack' AND ${table.periodMonths} IS NULL AND ${table.grantedMicrocredits} IS NOT NULL)`,
    ),
    check(
      "billing_product_versions_price_fen_check",
      sql`${table.priceFen} >= 0`,
    ),
  ],
);

/**
 * The release: one immutable bundle of version references valid for a scope,
 * environment and half-open effective interval. Selection at quote time reads
 * ONLY active releases covering the trusted now; a production request never
 * selects a test release, and an incomplete or overlapping release set fails
 * closed as not sellable instead of falling back to something older.
 */
export const billingCatalogReleases = pgTable(
  "billing_catalog_releases",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    schemaVersion: text("schema_version").notNull().default("billing.v1"),
    organizationId: uuid("organization_id").notNull(),
    billingAccountId: uuid("billing_account_id"),
    environment: billingEnvironment("environment")
      .notNull()
      .default("production"),
    effectiveFromUs: contractInteger("effective_from_us").notNull(),
    effectiveToUs: contractInteger("effective_to_us"),
    /**
     * Digest over the referenced versions' business content, fixed at publish.
     * Quotes return it so callers can detect configuration drift.
     */
    contentDigest: text("content_digest").notNull(),
    status: billingConfigStatus("status").notNull().default("draft"),
    createdAtUs: contractInteger("created_at_us").notNull(),
    updatedAtUs: contractInteger("updated_at_us").notNull(),
    revision: contractInteger("revision").notNull().default(sql`1`),
  },
  (table) => [
    index("billing_catalog_releases_scope_idx").on(
      table.organizationId,
      table.billingAccountId,
      table.environment,
      table.effectiveFromUs,
    ),
    check(
      "billing_catalog_releases_interval_check",
      sql`${table.effectiveToUs} IS NULL OR ${table.effectiveToUs} > ${table.effectiveFromUs}`,
    ),
  ],
);

export const billingCatalogReleaseItems = pgTable(
  "billing_catalog_release_items",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    releaseId: uuid("release_id")
      .notNull()
      .references(() => billingCatalogReleases.id, { onDelete: "restrict" }),
    productVersionId: uuid("product_version_id")
      .notNull()
      .references(() => billingProductVersions.id, { onDelete: "restrict" }),
    /**
     * The price version pinned for this product by the release. Kept separate
     * from the product version so a reprice appends a price version plus a new
     * release without cloning unchanged product rows.
     */
    priceVersionId: uuid("price_version_id")
      .notNull()
      .references(() => billingPriceVersions.id, { onDelete: "restrict" }),
    quotaVersionId: uuid("quota_version_id").references(
      () => billingQuotaVersions.id,
      {
        onDelete: "restrict",
      },
    ),
  },
  (table) => [
    uniqueIndex("billing_catalog_release_items_unique_product_idx").on(
      table.releaseId,
      table.productVersionId,
    ),
    index("billing_catalog_release_items_release_idx").on(table.releaseId),
  ],
);

/**
 * Audited selection-boundary record: when a successor release is appended and
 * the previous release had no effective_to_us, publish closes it implicitly at
 * the successor's start and records that routing change here. Existing price
 * snapshots are never rewritten; this is the boundary auditors read to explain
 * why a quote switched versions at a given microsecond.
 */
export const billingCatalogReleaseHandovers = pgTable(
  "billing_catalog_release_handovers",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    organizationId: uuid("organization_id").notNull(),
    billingAccountId: uuid("billing_account_id"),
    environment: billingEnvironment("environment")
      .notNull()
      .default("production"),
    previousReleaseId: uuid("previous_release_id")
      .notNull()
      .references(() => billingCatalogReleases.id, { onDelete: "restrict" }),
    successorReleaseId: uuid("successor_release_id")
      .notNull()
      .references(() => billingCatalogReleases.id, { onDelete: "restrict" }),
    boundaryUs: contractInteger("boundary_us").notNull(),
    createdAtUs: contractInteger("created_at_us").notNull(),
  },
  (table) => [
    uniqueIndex("billing_catalog_release_handovers_unique_idx").on(
      table.previousReleaseId,
      table.successorReleaseId,
    ),
  ],
);
