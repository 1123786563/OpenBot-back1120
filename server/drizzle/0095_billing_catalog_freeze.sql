ALTER TABLE "billing_product_versions" DROP CONSTRAINT "billing_product_versions_type_shape_check";--> statement-breakpoint
ALTER TABLE "billing_product_versions" ADD CONSTRAINT "billing_product_versions_type_shape_check" CHECK (("billing_product_versions"."product_type" = 'monthly_plan' AND "billing_product_versions"."period_months" = 1 AND "billing_product_versions"."quota_version_id" IS NOT NULL AND "billing_product_versions"."granted_microcredits" IS NOT NULL) OR ("billing_product_versions"."product_type" = 'credit_pack' AND "billing_product_versions"."period_months" IS NULL AND "billing_product_versions"."granted_microcredits" IS NOT NULL AND "billing_product_versions"."granted_microcredits" > 0));--> statement-breakpoint
CREATE OR REPLACE FUNCTION "billing_catalog_published_ref"(tbl text, rid uuid) RETURNS boolean AS $$
  SELECT EXISTS (
    SELECT 1
    FROM "billing_catalog_release_items" i
    WHERE (tbl = 'product' AND i."product_version_id" = rid)
       OR (tbl = 'price' AND i."price_version_id" = rid)
       OR (tbl = 'quota' AND i."quota_version_id" = rid)
       OR (tbl = 'quota_via_product' AND EXISTS (
             SELECT 1
             FROM "billing_product_versions" p
             JOIN "billing_catalog_release_items" pi ON pi."product_version_id" = p."id"
             WHERE p."quota_version_id" = rid))
       OR (tbl = 'run_cap' AND EXISTS (
             SELECT 1
             FROM "billing_price_versions" pv
             JOIN "billing_catalog_release_items" pi ON pi."price_version_id" = pv."id"
             WHERE pv."default_root_run_cap_version_id" = rid))
  )
$$ LANGUAGE sql STABLE;--> statement-breakpoint
CREATE OR REPLACE FUNCTION "billing_catalog_freeze_update"() RETURNS trigger AS $$
DECLARE
  mutable text[] := TG_ARGV[1]::text[];
BEGIN
  IF "billing_catalog_published_ref"(TG_ARGV[0], OLD."id")
     AND (to_jsonb(OLD) - mutable) IS DISTINCT FROM (to_jsonb(NEW) - mutable) THEN
    RAISE EXCEPTION 'billing catalog content is immutable once published (table %, id %): append a successor version instead of mutating history', TG_TABLE_NAME, OLD."id"
      USING ERRCODE = 'restrict_violation';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;--> statement-breakpoint
CREATE TRIGGER "billing_product_versions_freeze" BEFORE UPDATE ON "billing_product_versions"
  FOR EACH ROW EXECUTE FUNCTION "billing_catalog_freeze_update"('product', '{status,updated_at_us,revision}');--> statement-breakpoint
CREATE TRIGGER "billing_quota_versions_freeze" BEFORE UPDATE ON "billing_quota_versions"
  FOR EACH ROW EXECUTE FUNCTION "billing_catalog_freeze_update"('quota', '{status,updated_at_us,revision}');--> statement-breakpoint
CREATE TRIGGER "billing_run_cap_versions_freeze" BEFORE UPDATE ON "billing_run_cap_versions"
  FOR EACH ROW EXECUTE FUNCTION "billing_catalog_freeze_update"('run_cap', '{status,updated_at_us,revision}');--> statement-breakpoint
CREATE TRIGGER "billing_price_versions_freeze" BEFORE UPDATE ON "billing_price_versions"
  FOR EACH ROW EXECUTE FUNCTION "billing_catalog_freeze_update"('price', '{status,updated_at_us,revision}');--> statement-breakpoint
CREATE OR REPLACE FUNCTION "billing_price_resources_freeze"() RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF "billing_catalog_published_ref"('price', NEW."price_version_id") THEN
      RAISE EXCEPTION 'a published price version cannot gain resources; append a successor price version instead'
        USING ERRCODE = 'restrict_violation';
    END IF;
    RETURN NEW;
  END IF;
  IF "billing_catalog_published_ref"('price', OLD."price_version_id") THEN
    RAISE EXCEPTION 'published price rows are immutable: in-place changes would rewrite historical replay amounts; append a successor price version instead'
      USING ERRCODE = 'restrict_violation';
  END IF;
  RETURN COALESCE(NEW, OLD);
END;
$$ LANGUAGE plpgsql;--> statement-breakpoint
CREATE TRIGGER "billing_price_resources_freeze_guard" BEFORE INSERT OR UPDATE OR DELETE ON "billing_price_resources"
  FOR EACH ROW EXECUTE FUNCTION "billing_price_resources_freeze"();--> statement-breakpoint
CREATE OR REPLACE FUNCTION "billing_release_items_freeze"() RETURNS trigger AS $$
BEGIN
  IF TG_OP <> 'INSERT' THEN
    RAISE EXCEPTION 'release items are immutable: publish appends them once and nothing may rewrite or remove them'
      USING ERRCODE = 'restrict_violation';
  END IF;
  IF EXISTS (
    SELECT 1 FROM "billing_catalog_releases" r
    WHERE r."id" = NEW."release_id" AND r."xmin" <> pg_current_xact_id()::xid
  ) THEN
    RAISE EXCEPTION 'release items may only be inserted inside the transaction that creates the release'
      USING ERRCODE = 'restrict_violation';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;--> statement-breakpoint
CREATE TRIGGER "billing_catalog_release_items_freeze_guard" BEFORE INSERT OR UPDATE OR DELETE ON "billing_catalog_release_items"
  FOR EACH ROW EXECUTE FUNCTION "billing_release_items_freeze"();--> statement-breakpoint
CREATE OR REPLACE FUNCTION "billing_catalog_releases_freeze"() RETURNS trigger AS $$
BEGIN
  IF (to_jsonb(OLD) - '{status,effective_to_us,updated_at_us,revision}'::text[])
     IS DISTINCT FROM (to_jsonb(NEW) - '{status,effective_to_us,updated_at_us,revision}'::text[]) THEN
    RAISE EXCEPTION 'a release is immutable once created: content digest, scope and effective start never change'
      USING ERRCODE = 'restrict_violation';
  END IF;
  IF NEW."effective_to_us" IS DISTINCT FROM OLD."effective_to_us"
     AND (NEW."effective_to_us" IS NULL OR OLD."effective_to_us" IS NOT NULL) THEN
    RAISE EXCEPTION 'a release interval may only be closed once at a successor boundary, never re-opened or moved'
      USING ERRCODE = 'restrict_violation';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;--> statement-breakpoint
CREATE TRIGGER "billing_catalog_releases_freeze_guard" BEFORE UPDATE ON "billing_catalog_releases"
  FOR EACH ROW EXECUTE FUNCTION "billing_catalog_releases_freeze"();
