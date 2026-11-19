CREATE TABLE "payment_channel_notification" (
	"id" text PRIMARY KEY NOT NULL,
	"channel" text NOT NULL,
	"app_id" text NOT NULL,
	"dedupe_key" text NOT NULL,
	"payload_digest" text NOT NULL,
	"raw_payload_b64" text NOT NULL,
	"trade_no" text,
	"out_trade_no" text,
	"trade_status" text,
	"paid_at_us" text,
	"state" text NOT NULL,
	"received_at_us" text NOT NULL,
	"metadata" jsonb,
	CONSTRAINT "payment_channel_notification_identity" UNIQUE("channel","app_id","dedupe_key")
);
--> statement-breakpoint
CREATE INDEX "payment_channel_notification_state_idx" ON "payment_channel_notification" USING btree ("state","received_at_us");