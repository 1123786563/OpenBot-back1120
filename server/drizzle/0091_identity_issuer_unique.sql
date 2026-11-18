CREATE UNIQUE INDEX "accounts_provider_issuer_account_idx" ON "accounts" USING btree ("provider_id","issuer","account_id");--> statement-breakpoint
CREATE UNIQUE INDEX "accounts_provider_account_legacy_idx" ON "accounts" USING btree ("provider_id","account_id") WHERE "accounts"."issuer" is null;--> statement-breakpoint
DROP INDEX "accounts_provider_account_idx";
