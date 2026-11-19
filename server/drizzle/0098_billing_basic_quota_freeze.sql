-- The release-level BASIC quota is publish-referenced content (#65 rework).
--
-- Migration 0094 made billing_catalog_releases.basic_quota_version_id part of
-- a release's published content (its id, revision and spec feed the content
-- digest), but the publish-reference predicate below only looked at release
-- ITEMS (direct quota bindings and the quota_via_product indirection). A
-- quota bound ONLY as a release's basic tier therefore was not "published" in
-- the freeze guards' eyes: the UPDATE trigger queued on the scope advisory
-- lock, then accepted the write, so a published release's base ceilings could
-- be rewritten under a version id and digest that history had already
-- recorded. History re-reads the row by id, so the same version id and digest
-- would answer a DIFFERENT entitlement — replay could no longer restore the
-- original benefit.
--
-- This migration adds the missing reference branch. After it applies, a
-- quota pinned by ANY release — via an item or as the release basic quota —
-- is immutable content: the freeze trigger rejects the UPDATE with
-- restrict_violation, and the digest can never drift from the content it
-- covers. (The 0095 scope advisory lock still serializes the write against an
-- in-flight publish, so a quota whose publish transaction is mid-flight
-- cannot be rewritten "in between" either: the writer waits, the publish
-- commits, the writer is rejected.)
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
  OR (tbl = 'quota' AND EXISTS (
        SELECT 1
        FROM "billing_catalog_releases" r
        WHERE r."basic_quota_version_id" = rid))
$$ LANGUAGE sql STABLE;