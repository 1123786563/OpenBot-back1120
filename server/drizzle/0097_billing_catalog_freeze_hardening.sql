-- Hardening of the published-catalog freeze (#65 rework).
--
-- Three gaps closed, all in the same direction: no write path may make a
-- published release's content diverge from the digest that publish computed.
--
-- 1. Scope-wide serialization: every content write guarded by a freeze
--    trigger first takes the SAME transaction advisory lock the publish
--    transaction takes (hashtext("<org>|<account|-|<env>")). A publish
--    therefore validates and commits atomically against ALL guarded writes:
--    a resource row inserted concurrently into a version that is mid-publish
--    blocks until the publish commits, and is then rejected as a write into a
--    published version — the digest and the content can no longer disagree.
-- 2. Row moves: the price-resource guard checks BOTH the source and the
--    target version of an UPDATE, so a row can never be moved out of a
--    published set, into one, or between two published versions.
-- 3. Append-once release items: the guard compares against the release's
--    PERSISTED creating-transaction id (billing_catalog_releases.created_by_xact_id)
--    instead of the live xmin. An UPDATE (the successor handover that closes
--    the interval) replaces the row's xmin, which made the old guard unable
--    to distinguish the creating transaction from any later one inside that
--    transaction; the stored id never changes, so append-once holds across
--    handovers and forever after. Pre-existing releases (created before the
--    column existed) were filled by 0094 with the 0094 transaction's own xid,
--    which no future transaction can ever match — they are permanently
--    append-blocked, which is the correct fail-closed behavior for releases
--    that predate the guard.
CREATE OR REPLACE FUNCTION "billing_catalog_scope_lock"(org uuid, acct uuid, env text) RETURNS void AS $$
  -- Re-entrant within a transaction: the publish transaction already holds
  -- this lock and its own guarded writes simply proceed.
  SELECT pg_advisory_xact_lock(
    hashtext(org::text || '|' || coalesce(acct::text, '-') || '|' || env)
  );
$$ LANGUAGE sql;--> statement-breakpoint
CREATE OR REPLACE FUNCTION "billing_catalog_freeze_update"() RETURNS trigger AS $$
DECLARE
  mutable text[] := TG_ARGV[1]::text[];
BEGIN
  PERFORM "billing_catalog_scope_lock"(NEW."organization_id", NEW."billing_account_id", NEW."environment"::text);
  IF "billing_catalog_published_ref"(TG_ARGV[0], OLD."id")
     AND (to_jsonb(OLD) - mutable) IS DISTINCT FROM (to_jsonb(NEW) - mutable) THEN
    RAISE EXCEPTION 'billing catalog content is immutable once published (table %, id %): append a successor version instead of mutating history', TG_TABLE_NAME, OLD."id"
      USING ERRCODE = 'restrict_violation';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;--> statement-breakpoint
CREATE OR REPLACE FUNCTION "billing_price_resources_freeze"() RETURNS trigger AS $$
DECLARE
  src uuid := CASE WHEN TG_OP = 'INSERT' THEN NEW."price_version_id" ELSE OLD."price_version_id" END;
  dst uuid := CASE WHEN TG_OP = 'DELETE' THEN OLD."price_version_id" ELSE NEW."price_version_id" END;
BEGIN
  -- Serialize against publish for BOTH sides of a possible row move.
  PERFORM "billing_catalog_scope_lock"(v."organization_id", v."billing_account_id", v."environment"::text)
    FROM "billing_price_versions" v
    WHERE v."id" IN (src, dst);
  IF TG_OP = 'INSERT' THEN
    IF "billing_catalog_published_ref"('price', NEW."price_version_id") THEN
      RAISE EXCEPTION 'a published price version cannot gain resources; append a successor price version instead'
        USING ERRCODE = 'restrict_violation';
    END IF;
    RETURN NEW;
  END IF;
  IF TG_OP = 'UPDATE'
     AND "billing_catalog_published_ref"('price', NEW."price_version_id")
     AND NEW."price_version_id" IS DISTINCT FROM OLD."price_version_id" THEN
    RAISE EXCEPTION 'a published price version cannot gain resources by moving a row in; append a successor price version instead'
      USING ERRCODE = 'restrict_violation';
  END IF;
  IF "billing_catalog_published_ref"('price', OLD."price_version_id") THEN
    RAISE EXCEPTION 'published price rows are immutable: in-place changes would rewrite historical replay amounts; append a successor price version instead'
      USING ERRCODE = 'restrict_violation';
  END IF;
  RETURN COALESCE(NEW, OLD);
END;
$$ LANGUAGE plpgsql;--> statement-breakpoint
CREATE OR REPLACE FUNCTION "billing_release_items_freeze"() RETURNS trigger AS $$
BEGIN
  IF TG_OP <> 'INSERT' THEN
    RAISE EXCEPTION 'release items are immutable: publish appends them once and nothing may rewrite or remove them'
      USING ERRCODE = 'restrict_violation';
  END IF;
  IF EXISTS (
    SELECT 1 FROM "billing_catalog_releases" r
    WHERE r."id" = NEW."release_id"
      AND r."created_by_xact_id" <> pg_current_xact_id()::text::bigint
  ) THEN
    RAISE EXCEPTION 'release items may only be inserted inside the transaction that creates the release'
      USING ERRCODE = 'restrict_violation';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;--> statement-breakpoint
CREATE OR REPLACE FUNCTION "billing_catalog_releases_freeze"() RETURNS trigger AS $$
BEGIN
  PERFORM "billing_catalog_scope_lock"(NEW."organization_id", NEW."billing_account_id", NEW."environment"::text);
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
$$ LANGUAGE plpgsql;
