CREATE TYPE "public"."billing_config_status" AS ENUM('draft', 'active', 'retired');--> statement-breakpoint
CREATE TYPE "public"."billing_environment" AS ENUM('production', 'test');--> statement-breakpoint
CREATE TYPE "public"."billing_measurement_unit" AS ENUM('token', 'request', 'call', 'millisecond');--> statement-breakpoint
CREATE TYPE "public"."billing_priced_resource" AS ENUM('model_input_tokens', 'model_output_tokens', 'model_cache_read_tokens', 'model_cache_write_tokens', 'model_web_search_requests', 'model_request_count', 'tool_call_count', 'tool_call_duration_ms');--> statement-breakpoint
CREATE TYPE "public"."billing_product_type" AS ENUM('monthly_plan', 'credit_pack');--> statement-breakpoint
CREATE TYPE "public"."billing_quota_tier" AS ENUM('basic', 'subscription');--> statement-breakpoint
CREATE TABLE "billing_catalog_release_handovers" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"billing_account_id" uuid,
	"environment" "billing_environment" DEFAULT 'production' NOT NULL,
	"previous_release_id" uuid NOT NULL,
	"successor_release_id" uuid NOT NULL,
	"boundary_us" bigint NOT NULL,
	"created_at_us" bigint NOT NULL
);
--> statement-breakpoint
CREATE TABLE "billing_catalog_release_items" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"release_id" uuid NOT NULL,
	"product_version_id" uuid NOT NULL,
	"price_version_id" uuid NOT NULL,
	"quota_version_id" uuid
);
--> statement-breakpoint
CREATE TABLE "billing_catalog_releases" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"schema_version" text DEFAULT 'billing.v1' NOT NULL,
	"organization_id" uuid NOT NULL,
	"billing_account_id" uuid,
	"environment" "billing_environment" DEFAULT 'production' NOT NULL,
	"effective_from_us" bigint NOT NULL,
	"effective_to_us" bigint,
	"content_digest" text NOT NULL,
	"status" "billing_config_status" DEFAULT 'draft' NOT NULL,
	"created_at_us" bigint NOT NULL,
	"updated_at_us" bigint NOT NULL,
	"revision" bigint DEFAULT 1 NOT NULL,
	CONSTRAINT "billing_catalog_releases_interval_check" CHECK ("billing_catalog_releases"."effective_to_us" IS NULL OR "billing_catalog_releases"."effective_to_us" > "billing_catalog_releases"."effective_from_us")
);
--> statement-breakpoint
CREATE TABLE "billing_price_resources" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"price_version_id" uuid NOT NULL,
	"resource" "billing_priced_resource" NOT NULL,
	"measurement_unit" "billing_measurement_unit" NOT NULL,
	"unit_size" bigint NOT NULL,
	"numerator" bigint NOT NULL,
	"denominator" bigint NOT NULL,
	CONSTRAINT "billing_price_resources_unit_size_check" CHECK ("billing_price_resources"."unit_size" > 0),
	CONSTRAINT "billing_price_resources_denominator_check" CHECK ("billing_price_resources"."denominator" > 0),
	CONSTRAINT "billing_price_resources_numerator_check" CHECK ("billing_price_resources"."numerator" >= 0)
);
--> statement-breakpoint
CREATE TABLE "billing_price_versions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"schema_version" text DEFAULT 'billing.v1' NOT NULL,
	"organization_id" uuid NOT NULL,
	"billing_account_id" uuid,
	"environment" "billing_environment" DEFAULT 'production' NOT NULL,
	"effective_from_us" bigint NOT NULL,
	"effective_to_us" bigint,
	"default_root_run_cap_version_id" uuid NOT NULL,
	"default_root_run_cap_microcredits" bigint NOT NULL,
	"status" "billing_config_status" DEFAULT 'draft' NOT NULL,
	"created_at_us" bigint NOT NULL,
	"updated_at_us" bigint NOT NULL,
	"revision" bigint DEFAULT 1 NOT NULL,
	CONSTRAINT "billing_price_versions_interval_check" CHECK ("billing_price_versions"."effective_to_us" IS NULL OR "billing_price_versions"."effective_to_us" > "billing_price_versions"."effective_from_us"),
	CONSTRAINT "billing_price_versions_cap_positive" CHECK ("billing_price_versions"."default_root_run_cap_microcredits" > 0)
);
--> statement-breakpoint
CREATE TABLE "billing_product_versions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"schema_version" text DEFAULT 'billing.v1' NOT NULL,
	"organization_id" uuid NOT NULL,
	"billing_account_id" uuid,
	"environment" "billing_environment" DEFAULT 'production' NOT NULL,
	"product_id" text NOT NULL,
	"product_type" "billing_product_type" NOT NULL,
	"display_name" text NOT NULL,
	"price_fen" bigint NOT NULL,
	"currency" text DEFAULT 'CNY' NOT NULL,
	"granted_microcredits" bigint,
	"period_months" integer,
	"quota_version_id" uuid,
	"status" "billing_config_status" DEFAULT 'draft' NOT NULL,
	"created_at_us" bigint NOT NULL,
	"updated_at_us" bigint NOT NULL,
	"revision" bigint DEFAULT 1 NOT NULL,
	CONSTRAINT "billing_product_versions_period_months_check" CHECK ("billing_product_versions"."period_months" IS NULL OR "billing_product_versions"."period_months" = 1),
	CONSTRAINT "billing_product_versions_type_shape_check" CHECK (("billing_product_versions"."product_type" = 'monthly_plan' AND "billing_product_versions"."period_months" = 1 AND "billing_product_versions"."quota_version_id" IS NOT NULL) OR ("billing_product_versions"."product_type" = 'credit_pack' AND "billing_product_versions"."period_months" IS NULL AND "billing_product_versions"."granted_microcredits" IS NOT NULL)),
	CONSTRAINT "billing_product_versions_price_fen_check" CHECK ("billing_product_versions"."price_fen" >= 0)
);
--> statement-breakpoint
CREATE TABLE "billing_quota_versions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"schema_version" text DEFAULT 'billing.v1' NOT NULL,
	"organization_id" uuid NOT NULL,
	"billing_account_id" uuid,
	"environment" "billing_environment" DEFAULT 'production' NOT NULL,
	"tier" "billing_quota_tier" NOT NULL,
	"spec" jsonb NOT NULL,
	"status" "billing_config_status" DEFAULT 'draft' NOT NULL,
	"created_at_us" bigint NOT NULL,
	"updated_at_us" bigint NOT NULL,
	"revision" bigint DEFAULT 1 NOT NULL,
	CONSTRAINT "billing_quota_versions_revision_positive" CHECK ("billing_quota_versions"."revision" >= 1)
);
--> statement-breakpoint
CREATE TABLE "billing_run_cap_versions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"schema_version" text DEFAULT 'billing.v1' NOT NULL,
	"organization_id" uuid NOT NULL,
	"billing_account_id" uuid,
	"environment" "billing_environment" DEFAULT 'production' NOT NULL,
	"cap_microcredits" bigint NOT NULL,
	"status" "billing_config_status" DEFAULT 'draft' NOT NULL,
	"created_at_us" bigint NOT NULL,
	"updated_at_us" bigint NOT NULL,
	"revision" bigint DEFAULT 1 NOT NULL,
	CONSTRAINT "billing_run_cap_versions_cap_positive" CHECK ("billing_run_cap_versions"."cap_microcredits" > 0)
);
--> statement-breakpoint
ALTER TABLE "billing_catalog_release_handovers" ADD CONSTRAINT "billing_catalog_release_handovers_previous_release_id_billing_catalog_releases_id_fk" FOREIGN KEY ("previous_release_id") REFERENCES "public"."billing_catalog_releases"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "billing_catalog_release_handovers" ADD CONSTRAINT "billing_catalog_release_handovers_successor_release_id_billing_catalog_releases_id_fk" FOREIGN KEY ("successor_release_id") REFERENCES "public"."billing_catalog_releases"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "billing_catalog_release_items" ADD CONSTRAINT "billing_catalog_release_items_release_id_billing_catalog_releases_id_fk" FOREIGN KEY ("release_id") REFERENCES "public"."billing_catalog_releases"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "billing_catalog_release_items" ADD CONSTRAINT "billing_catalog_release_items_product_version_id_billing_product_versions_id_fk" FOREIGN KEY ("product_version_id") REFERENCES "public"."billing_product_versions"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "billing_catalog_release_items" ADD CONSTRAINT "billing_catalog_release_items_price_version_id_billing_price_versions_id_fk" FOREIGN KEY ("price_version_id") REFERENCES "public"."billing_price_versions"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "billing_catalog_release_items" ADD CONSTRAINT "billing_catalog_release_items_quota_version_id_billing_quota_versions_id_fk" FOREIGN KEY ("quota_version_id") REFERENCES "public"."billing_quota_versions"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "billing_price_resources" ADD CONSTRAINT "billing_price_resources_price_version_id_billing_price_versions_id_fk" FOREIGN KEY ("price_version_id") REFERENCES "public"."billing_price_versions"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "billing_price_versions" ADD CONSTRAINT "billing_price_versions_default_root_run_cap_version_id_billing_run_cap_versions_id_fk" FOREIGN KEY ("default_root_run_cap_version_id") REFERENCES "public"."billing_run_cap_versions"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "billing_product_versions" ADD CONSTRAINT "billing_product_versions_quota_version_id_billing_quota_versions_id_fk" FOREIGN KEY ("quota_version_id") REFERENCES "public"."billing_quota_versions"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "billing_catalog_release_handovers_unique_idx" ON "billing_catalog_release_handovers" USING btree ("previous_release_id","successor_release_id");--> statement-breakpoint
CREATE UNIQUE INDEX "billing_catalog_release_items_unique_product_idx" ON "billing_catalog_release_items" USING btree ("release_id","product_version_id");--> statement-breakpoint
CREATE INDEX "billing_catalog_release_items_release_idx" ON "billing_catalog_release_items" USING btree ("release_id");--> statement-breakpoint
CREATE INDEX "billing_catalog_releases_scope_idx" ON "billing_catalog_releases" USING btree ("organization_id","billing_account_id","environment","effective_from_us");--> statement-breakpoint
CREATE UNIQUE INDEX "billing_price_resources_unique_resource_idx" ON "billing_price_resources" USING btree ("price_version_id","resource");--> statement-breakpoint
CREATE INDEX "billing_price_versions_scope_idx" ON "billing_price_versions" USING btree ("organization_id","billing_account_id","environment","effective_from_us");--> statement-breakpoint
CREATE INDEX "billing_product_versions_scope_idx" ON "billing_product_versions" USING btree ("organization_id","billing_account_id","environment","product_id");--> statement-breakpoint
CREATE INDEX "billing_quota_versions_scope_idx" ON "billing_quota_versions" USING btree ("organization_id","billing_account_id","environment");--> statement-breakpoint
CREATE INDEX "billing_run_cap_versions_scope_idx" ON "billing_run_cap_versions" USING btree ("organization_id","billing_account_id","environment");