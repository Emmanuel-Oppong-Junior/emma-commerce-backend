-- Reconciliation report of the promotions migration, P2-B.1 (prisma/migrations/20261126000000_promotions and its
-- contract). Read-only and safe to re-run: ids and counts only, no personal data.
--   psql "$DATABASE_URL" -f scripts/reports/promotions-migration-report.sql
--
-- The migration itself prints the totals (promotions from discounts and coupons, codes, redemptions, percentages
-- capped at 100) as a NOTICE; the contract refuses to run while anything is left to copy. This report lists what is
-- worth a look afterwards.

-- Discounts that targeted several kinds of things at once and became one promotion per kind (same name, value and
-- dates): "<id>_product" and "<id>_category" are the extra pieces of discount "<id>".
SELECT p.id AS "promotionId", p.scope, p.name
FROM "Promotion" p
WHERE p.id LIKE '%\_product' OR p.id LIKE '%\_category'
ORDER BY p.id;

-- Item promotions without a target: they apply to nothing (a migrated discount without products, variants or
-- categories applied to nothing either). Give them targets or delete them.
SELECT p.id AS "promotionId", p.scope, p."isActive"
FROM "Promotion" p
WHERE p.scope <> 'CART'
  AND NOT EXISTS (SELECT 1 FROM "_PromotionToVariant" t WHERE t."A" = p.id)
  AND NOT EXISTS (SELECT 1 FROM "_ProductToPromotion" t WHERE t."B" = p.id)
  AND NOT EXISTS (SELECT 1 FROM "_CategoryToPromotion" t WHERE t."B" = p.id)
  AND NOT EXISTS (SELECT 1 FROM "_BrandToPromotion" t WHERE t."B" = p.id)
ORDER BY p."createdAt";

-- Promotions and coupon codes whose usedCount differs from their RESERVED redemptions. A coupon's usedCount was copied
-- as it was; a difference means the old counter had drifted (uses recorded without a CouponUsage row, or the reverse).
-- Nightly check afterwards: any row here is a bug.
SELECT 'Promotion' AS entity, p.id, p."usedCount", count(r.id) AS reserved
FROM "Promotion" p LEFT JOIN "Redemption" r ON r."promotionId" = p.id AND r.status = 'RESERVED'
GROUP BY p.id
HAVING p."usedCount" <> count(r.id)
UNION ALL
SELECT 'CouponCode', c.id, c."usedCount", count(r.id)
FROM "CouponCode" c LEFT JOIN "Redemption" r ON r."couponCodeId" = c.id AND r.status = 'RESERVED'
GROUP BY c.id
HAVING c."usedCount" <> count(r.id)
ORDER BY 1, 2;

-- Limits already overspent before the migration (the old coupon check raced, CPN-01): no further use is accepted.
SELECT id AS "promotionId", "usageLimit", "usedCount" FROM "Promotion" WHERE "usedCount" > "usageLimit"
ORDER BY id;

-- Order adjustments whose source promotion no longer exists (the discount or coupon was deleted before the
-- migration); the adjustment keeps its amount and code.
SELECT a.type, count(*) AS adjustments
FROM "OrderAdjustment" a
WHERE a."sourceId" IS NOT NULL AND NOT EXISTS (SELECT 1 FROM "Promotion" p WHERE p.id = a."sourceId")
GROUP BY a.type;
