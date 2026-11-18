CREATE SCHEMA IF NOT EXISTS "billing";
--> statement-breakpoint
CREATE TABLE "billing"."account" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"owner_subject_id" text NOT NULL,
	"personal_workspace_id" text NOT NULL,
	"status" text DEFAULT 'active' NOT NULL,
	"revision" bigint DEFAULT 1 NOT NULL,
	"created_at_us" bigint NOT NULL,
	"updated_at_us" bigint NOT NULL,
	CONSTRAINT "billing_account_owner_uq" UNIQUE("owner_subject_id"),
	CONSTRAINT "billing_account_workspace_uq" UNIQUE("personal_workspace_id"),
	CONSTRAINT "billing_account_org_id_uq" UNIQUE("organization_id","id"),
	CONSTRAINT "billing_account_status_check" CHECK ("billing"."account"."status" IN ('active', 'suspended', 'closed'))
);
--> statement-breakpoint
CREATE TABLE "billing"."adjustment" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"account_id" uuid NOT NULL,
	"original_event_id" uuid NOT NULL,
	"adjustment_type" text NOT NULL,
	"source_namespace" text NOT NULL,
	"source_event_id" text NOT NULL,
	"signed_delta_microcredits" bigint NOT NULL,
	"reason" text NOT NULL,
	"actor_subject_id" text NOT NULL,
	"original_period_id" text,
	"effective_at_us" bigint NOT NULL,
	"compensation_lot_id" uuid,
	"created_at_us" bigint NOT NULL,
	CONSTRAINT "billing_adjustment_org_account_id_uq" UNIQUE("organization_id","account_id","id"),
	CONSTRAINT "billing_adjustment_scope_uq" UNIQUE("account_id","original_event_id","adjustment_type"),
	CONSTRAINT "billing_adjustment_source_uq" UNIQUE("source_namespace","source_event_id"),
	CONSTRAINT "billing_adjustment_type_check" CHECK ("billing"."adjustment"."adjustment_type" IN ('charge_correction', 'compensation', 'late_usage_attribution', 'expiry_correction', 'revocation')),
	CONSTRAINT "billing_adjustment_zero_only_attribution_check" CHECK ("billing"."adjustment"."signed_delta_microcredits" <> 0 OR "billing"."adjustment"."adjustment_type" = 'late_usage_attribution'),
	CONSTRAINT "billing_adjustment_negative_no_lot_check" CHECK ("billing"."adjustment"."signed_delta_microcredits" >= 0 OR "billing"."adjustment"."compensation_lot_id" IS NULL)
);
--> statement-breakpoint
CREATE TABLE "billing"."business_event" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"account_id" uuid NOT NULL,
	"source_namespace" text NOT NULL,
	"source_event_id" text NOT NULL,
	"content" jsonb NOT NULL,
	"first_result" jsonb NOT NULL,
	"created_at_us" bigint NOT NULL,
	CONSTRAINT "billing_business_event_key_uq" UNIQUE("source_namespace","source_event_id")
);
--> statement-breakpoint
CREATE TABLE "billing"."credit_lot" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"account_id" uuid NOT NULL,
	"source_type" text NOT NULL,
	"source_event_id" text NOT NULL,
	"source_period_id" text,
	"granted_microcredits" bigint NOT NULL,
	"available_microcredits" bigint DEFAULT 0 NOT NULL,
	"reserved_microcredits" bigint DEFAULT 0 NOT NULL,
	"refund_frozen_microcredits" bigint DEFAULT 0 NOT NULL,
	"consumed_microcredits" bigint DEFAULT 0 NOT NULL,
	"expired_microcredits" bigint DEFAULT 0 NOT NULL,
	"revoked_microcredits" bigint DEFAULT 0 NOT NULL,
	"valid_from_us" bigint NOT NULL,
	"expires_at_us" bigint,
	"status" text DEFAULT 'active' NOT NULL,
	"revision" bigint DEFAULT 1 NOT NULL,
	"compensation_for_event_id" uuid,
	"created_at_us" bigint NOT NULL,
	"updated_at_us" bigint NOT NULL,
	CONSTRAINT "billing_credit_lot_org_account_id_uq" UNIQUE("organization_id","account_id","id"),
	CONSTRAINT "billing_credit_lot_source_check" CHECK ("billing"."credit_lot"."source_type" IN ('subscription', 'pack', 'compensation')),
	CONSTRAINT "billing_credit_lot_status_check" CHECK ("billing"."credit_lot"."status" IN ('scheduled', 'active', 'frozen', 'exhausted', 'expired', 'revoked')),
	CONSTRAINT "billing_credit_lot_nonnegative_check" CHECK ("billing"."credit_lot"."available_microcredits" >= 0 AND "billing"."credit_lot"."reserved_microcredits" >= 0 AND "billing"."credit_lot"."refund_frozen_microcredits" >= 0
          AND "billing"."credit_lot"."consumed_microcredits" >= 0 AND "billing"."credit_lot"."expired_microcredits" >= 0 AND "billing"."credit_lot"."revoked_microcredits" >= 0
          AND "billing"."credit_lot"."granted_microcredits" >= 0),
	CONSTRAINT "billing_credit_lot_conservation_check" CHECK ("billing"."credit_lot"."granted_microcredits" = "billing"."credit_lot"."available_microcredits" + "billing"."credit_lot"."reserved_microcredits" + "billing"."credit_lot"."refund_frozen_microcredits"
          + "billing"."credit_lot"."consumed_microcredits" + "billing"."credit_lot"."expired_microcredits" + "billing"."credit_lot"."revoked_microcredits"),
	CONSTRAINT "billing_credit_lot_pack_lifetime_check" CHECK ("billing"."credit_lot"."source_type" <> 'pack' OR ("billing"."credit_lot"."source_period_id" IS NULL AND "billing"."credit_lot"."expires_at_us" IS NULL)),
	CONSTRAINT "billing_credit_lot_subscription_period_check" CHECK ("billing"."credit_lot"."source_type" <> 'subscription' OR ("billing"."credit_lot"."source_period_id" IS NOT NULL AND "billing"."credit_lot"."expires_at_us" IS NOT NULL AND "billing"."credit_lot"."expires_at_us" > "billing"."credit_lot"."valid_from_us")),
	CONSTRAINT "billing_credit_lot_compensation_expiry_check" CHECK ("billing"."credit_lot"."source_type" <> 'compensation' OR ("billing"."credit_lot"."expires_at_us" IS NOT NULL AND "billing"."credit_lot"."expires_at_us" > "billing"."credit_lot"."valid_from_us")),
	CONSTRAINT "billing_credit_lot_compensation_origin_check" CHECK ("billing"."credit_lot"."source_type" <> 'compensation' OR "billing"."credit_lot"."compensation_for_event_id" IS NOT NULL)
);
--> statement-breakpoint
CREATE TABLE "billing"."idempotency" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"account_id" uuid NOT NULL,
	"operation" text NOT NULL,
	"logical_resource_id" text NOT NULL,
	"key" text NOT NULL,
	"request" jsonb NOT NULL,
	"request_hash" text NOT NULL,
	"response" jsonb NOT NULL,
	"schema_version" text NOT NULL,
	"created_at_us" bigint NOT NULL,
	CONSTRAINT "billing_idempotency_scope_uq" UNIQUE("organization_id","account_id","operation","logical_resource_id","key")
);
--> statement-breakpoint
CREATE TABLE "billing"."ledger_event" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"account_id" uuid NOT NULL,
	"event_type" text NOT NULL,
	"account_seq" bigint NOT NULL,
	"source_namespace" text,
	"source_event_id" text,
	"adjustment_id" uuid,
	"actor_subject_id" text,
	"reason" text,
	"original_period_id" text,
	"occurred_at_us" bigint NOT NULL,
	"committed_at_us" bigint NOT NULL,
	CONSTRAINT "billing_ledger_event_org_account_id_uq" UNIQUE("organization_id","account_id","id"),
	CONSTRAINT "billing_ledger_event_account_seq_uq" UNIQUE("account_id","account_seq"),
	CONSTRAINT "billing_ledger_event_type_check" CHECK ("billing"."ledger_event"."event_type" IN ('credit.granted', 'credit.adjusted', 'credit.expired'))
);
--> statement-breakpoint
CREATE TABLE "billing"."ledger_line" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"account_id" uuid NOT NULL,
	"event_id" uuid NOT NULL,
	"lot_id" uuid NOT NULL,
	"delta_granted_microcredits" bigint DEFAULT 0 NOT NULL,
	"delta_available_microcredits" bigint DEFAULT 0 NOT NULL,
	"delta_reserved_microcredits" bigint DEFAULT 0 NOT NULL,
	"delta_refund_frozen_microcredits" bigint DEFAULT 0 NOT NULL,
	"delta_consumed_microcredits" bigint DEFAULT 0 NOT NULL,
	"delta_expired_microcredits" bigint DEFAULT 0 NOT NULL,
	"delta_revoked_microcredits" bigint DEFAULT 0 NOT NULL,
	"balances_after" jsonb NOT NULL,
	"created_at_us" bigint NOT NULL,
	CONSTRAINT "billing_ledger_line_org_account_id_uq" UNIQUE("organization_id","account_id","id"),
	CONSTRAINT "billing_ledger_line_event_lot_uq" UNIQUE("event_id","lot_id"),
	CONSTRAINT "billing_ledger_line_identity_check" CHECK ("billing"."ledger_line"."delta_granted_microcredits" = "billing"."ledger_line"."delta_available_microcredits" + "billing"."ledger_line"."delta_reserved_microcredits"
          + "billing"."ledger_line"."delta_refund_frozen_microcredits" + "billing"."ledger_line"."delta_consumed_microcredits" + "billing"."ledger_line"."delta_expired_microcredits"
          + "billing"."ledger_line"."delta_revoked_microcredits")
);
--> statement-breakpoint
CREATE TABLE "billing"."outbox_delivery" (
	"outbox_event_id" uuid PRIMARY KEY NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"attempts" bigint DEFAULT 0 NOT NULL,
	"lease_until_us" bigint,
	"published_at_us" bigint,
	"updated_at_us" bigint NOT NULL,
	CONSTRAINT "billing_outbox_delivery_status_check" CHECK ("billing"."outbox_delivery"."status" IN ('pending', 'sent', 'failed'))
);
--> statement-breakpoint
CREATE TABLE "billing"."outbox_event" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"account_id" uuid NOT NULL,
	"ledger_event_id" uuid NOT NULL,
	"account_seq" bigint NOT NULL,
	"event_type" text NOT NULL,
	"schema_version" text NOT NULL,
	"payload" jsonb NOT NULL,
	"created_at_us" bigint NOT NULL,
	CONSTRAINT "billing_outbox_event_org_account_id_uq" UNIQUE("organization_id","account_id","id"),
	CONSTRAINT "billing_outbox_event_ledger_uq" UNIQUE("ledger_event_id")
);
--> statement-breakpoint
ALTER TABLE "billing"."adjustment" ADD CONSTRAINT "billing_adjustment_account_fk" FOREIGN KEY ("organization_id","account_id") REFERENCES "billing"."account"("organization_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "billing"."adjustment" ADD CONSTRAINT "billing_adjustment_original_fk" FOREIGN KEY ("organization_id","account_id","original_event_id") REFERENCES "billing"."ledger_event"("organization_id","account_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "billing"."adjustment" ADD CONSTRAINT "billing_adjustment_compensation_lot_fk" FOREIGN KEY ("organization_id","account_id","compensation_lot_id") REFERENCES "billing"."credit_lot"("organization_id","account_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "billing"."business_event" ADD CONSTRAINT "billing_business_event_account_fk" FOREIGN KEY ("organization_id","account_id") REFERENCES "billing"."account"("organization_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "billing"."credit_lot" ADD CONSTRAINT "billing_credit_lot_account_fk" FOREIGN KEY ("organization_id","account_id") REFERENCES "billing"."account"("organization_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "billing"."credit_lot" ADD CONSTRAINT "billing_credit_lot_origin_fk" FOREIGN KEY ("organization_id","account_id","compensation_for_event_id") REFERENCES "billing"."ledger_event"("organization_id","account_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "billing"."idempotency" ADD CONSTRAINT "billing_idempotency_account_fk" FOREIGN KEY ("organization_id","account_id") REFERENCES "billing"."account"("organization_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "billing"."ledger_event" ADD CONSTRAINT "billing_ledger_event_account_fk" FOREIGN KEY ("organization_id","account_id") REFERENCES "billing"."account"("organization_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "billing"."ledger_line" ADD CONSTRAINT "billing_ledger_line_account_fk" FOREIGN KEY ("organization_id","account_id") REFERENCES "billing"."account"("organization_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "billing"."ledger_line" ADD CONSTRAINT "billing_ledger_line_event_fk" FOREIGN KEY ("organization_id","account_id","event_id") REFERENCES "billing"."ledger_event"("organization_id","account_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "billing"."ledger_line" ADD CONSTRAINT "billing_ledger_line_lot_fk" FOREIGN KEY ("organization_id","account_id","lot_id") REFERENCES "billing"."credit_lot"("organization_id","account_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "billing"."outbox_delivery" ADD CONSTRAINT "billing_outbox_delivery_event_fk" FOREIGN KEY ("outbox_event_id") REFERENCES "billing"."outbox_event"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "billing"."outbox_event" ADD CONSTRAINT "billing_outbox_event_account_fk" FOREIGN KEY ("organization_id","account_id") REFERENCES "billing"."account"("organization_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "billing"."outbox_event" ADD CONSTRAINT "billing_outbox_event_ledger_fk" FOREIGN KEY ("organization_id","account_id","ledger_event_id") REFERENCES "billing"."ledger_event"("organization_id","account_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "billing_credit_lot_consumption_idx" ON "billing"."credit_lot" USING btree ("account_id","expires_at_us","created_at_us","id");