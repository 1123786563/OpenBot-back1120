CREATE TABLE "billing"."recovery_allocation" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"account_id" uuid NOT NULL,
	"original_event_id" uuid NOT NULL,
	"original_lot_id" uuid NOT NULL,
	"restored_microcredits" bigint NOT NULL,
	"restored_via" text NOT NULL,
	"restoration_event_id" uuid NOT NULL,
	"created_at_us" bigint NOT NULL,
	CONSTRAINT "billing_recovery_org_account_id_uq" UNIQUE("organization_id","account_id","id"),
	CONSTRAINT "billing_recovery_line_event_uq" UNIQUE("original_event_id","original_lot_id","restoration_event_id"),
	CONSTRAINT "billing_recovery_via_check" CHECK ("billing"."recovery_allocation"."restored_via" IN ('credit_grant', 'adjustment')),
	CONSTRAINT "billing_recovery_positive_check" CHECK ("billing"."recovery_allocation"."restored_microcredits" > 0),
	CONSTRAINT "billing_recovery_account_fk" FOREIGN KEY ("organization_id","account_id") REFERENCES "billing"."account"("organization_id","id") ON UPDATE NO ACTION ON DELETE NO ACTION,
	CONSTRAINT "billing_recovery_original_fk" FOREIGN KEY ("organization_id","account_id","original_event_id") REFERENCES "billing"."ledger_event"("organization_id","account_id","id") ON UPDATE NO ACTION ON DELETE NO ACTION,
	CONSTRAINT "billing_recovery_lot_fk" FOREIGN KEY ("organization_id","account_id","original_lot_id") REFERENCES "billing"."credit_lot"("organization_id","account_id","id") ON UPDATE NO ACTION ON DELETE NO ACTION,
	CONSTRAINT "billing_recovery_event_fk" FOREIGN KEY ("organization_id","account_id","restoration_event_id") REFERENCES "billing"."ledger_event"("organization_id","account_id","id") ON UPDATE NO ACTION ON DELETE NO ACTION
);
--> statement-breakpoint
CREATE INDEX "billing_recovery_quota_idx" ON "billing"."recovery_allocation" ("original_event_id","original_lot_id");
