import { Injectable } from '@nestjs/common';
import { Prisma } from '../../generated/prisma/client';
import { DayRange, dayKey } from '../domain/report-range';

type Tx = Prisma.TransactionClient;

/**
 * A payment accepted for its order: a settled online attempt, or a recorded cash collection (which also writes a
 * CAPTURED cash-on-delivery attempt). Captured payments held for review are queued for refund, never revenue.
 */
const ACCEPTED = Prisma.sql`pa.status = 'CAPTURED' AND pa."reviewReason" IS NULL AND pa.deleted = false`;

// An attempt has no settled-at column: updatedAt is written by the settling update and only touched again by an
// admin soft delete or restore. Cash is recognised when it was collected.
const RECOGNISED_AT = Prisma.sql`COALESCE(cc."collectedAt", pa."updatedAt")`;

// Tax-exclusive net of a line: what it was charged (its share of the cart adjustments included) minus its tax. The
// pricing engine taxes the line before cart promotions, so its stored tax stands.
const LINE_CHARGED = Prisma.sql`(oi."lineTotal" + oi."orderAdjustmentShare")`;
const LINE_EX_TAX = Prisma.sql`(${LINE_CHARGED} - COALESCE(oi."unitTax", 0) * oi.quantity)`;
// The same share of a refunded line amount.
const REFUND_EX_TAX = Prisma.sql`(CASE WHEN ${LINE_CHARGED} = 0 THEN 0 ELSE rl.amount * ${LINE_EX_TAX} / ${LINE_CHARGED} END)`;

const CUSTOMER_KEY = Prisma.sql`COALESCE(o."userId", 'guest:' || encode(sha256(convert_to(o."guestPhone", 'UTF8')), 'hex'))`;

/** Orders whose first accepted payment falls in the range, with when. */
function paidOrders({ from, to }: DayRange): Prisma.Sql {
  return Prisma.sql`
    SELECT intent."orderId", MIN(${RECOGNISED_AT}) AS "paidAt"
    FROM "PaymentAttempt" pa
    JOIN "PaymentIntent" intent ON intent.id = pa."intentId"
    LEFT JOIN "CashCollection" cc ON cc."attemptId" = pa.id
    WHERE ${ACCEPTED}
    GROUP BY intent."orderId"
    HAVING MIN(${RECOGNISED_AT}) >= ${dayKey(from)}::date AND MIN(${RECOGNISED_AT}) < ${dayKey(to)}::date
  `;
}

/** Refunds of accepted payments processed in the range, with their day and order. */
function processedRefunds({ from, to }: DayRange): Prisma.Sql {
  return Prisma.sql`
    SELECT r.id, r.amount, r."shippingAmount", r."taxAmount", r."updatedAt"::date AS day, intent."orderId"
    FROM "Refund" r
    JOIN "PaymentAttempt" pa ON pa.id = r."attemptId"
    JOIN "PaymentIntent" intent ON intent.id = pa."intentId"
    WHERE r.status = 'PROCESSED' AND ${ACCEPTED}
      AND r."updatedAt" >= ${dayKey(from)}::date AND r."updatedAt" < ${dayKey(to)}::date
  `;
}

/**
 * Rebuilds the daily rollups of whole UTC days (P8-A) from the order, payment, refund and stock tables. Each table is
 * rewritten for the range, so a re-run gives the same rows. Day boundaries are UTC: stored timestamps are UTC and
 * Ghana keeps UTC all year. Every value is computed in SQL numeric, never in floating point.
 */
@Injectable()
export class AnalyticsRollupRepository {
  async rebuild(tx: Tx, range: DayRange, computedAt: Date): Promise<void> {
    await this.rebuildSales(tx, range, computedAt);
    await this.rebuildVariants(tx, range);
    await this.rebuildPromotions(tx, range);
    await this.rebuildCustomers(tx, range);
  }

  /** One row per day of the range, zeros included, so a report can tell a quiet day from a day never computed. */
  private async rebuildSales(tx: Tx, range: DayRange, computedAt: Date): Promise<void> {
    const { from, to } = range;
    await tx.$executeRaw`
      WITH paid AS (${paidOrders(range)}),
      order_days AS (
        SELECT p."paidAt"::date AS day,
          count(*)::int AS "paidOrders",
          sum(o."grandTotal") AS "grossRevenue",
          sum(COALESCE(o."shippingTotal", 0)) AS shipping,
          sum(COALESCE(o."taxTotal", 0)) AS tax,
          COALESCE(sum(l.units), 0)::int AS "unitsSold",
          COALESCE(sum(l.sales), 0) AS "itemSales",
          COALESCE(sum(l.discounts), 0) AS "itemDiscounts",
          sum(a."orderDiscounts") AS "orderDiscounts",
          sum(a.loyalty) AS "loyaltyDiscounts",
          sum(a."shippingDiscounts") AS "shippingDiscounts"
        FROM paid p
        JOIN "Order" o ON o.id = p."orderId"
        CROSS JOIN LATERAL (
          SELECT sum(oi.quantity) AS units, sum(${LINE_CHARGED}) AS sales, sum(oi."unitDiscount" * oi.quantity) AS discounts
          FROM "OrderItem" oi WHERE oi."orderId" = o.id
        ) l
        CROSS JOIN LATERAL (
          SELECT
            -COALESCE(sum(a.amount) FILTER (
              WHERE a."orderItemId" IS NULL AND a.target = 'MERCHANDISE' AND a.type <> 'LOYALTY_POINTS'
            ), 0) AS "orderDiscounts",
            -COALESCE(sum(a.amount) FILTER (WHERE a.type = 'LOYALTY_POINTS'), 0) AS loyalty,
            -COALESCE(sum(a.amount) FILTER (WHERE a.target = 'SHIPPING'), 0) AS "shippingDiscounts"
          FROM "OrderAdjustment" a WHERE a."orderId" = o.id
        ) a
        GROUP BY 1
      ),
      refund_days AS (
        SELECT r.day,
          count(*)::int AS "refundCount",
          sum(r.amount) AS refunds,
          sum(r."shippingAmount") AS "refundedShipping",
          sum(COALESCE(r."taxAmount", 0)) AS "refundedTax",
          sum(r.amount - r."shippingAmount" - COALESCE(
            (SELECT sum(rl.amount) FROM "RefundLine" rl WHERE rl."refundId" = r.id), 0
          )) AS "unallocatedRefunds"
        FROM (${processedRefunds(range)}) r
        GROUP BY 1
      ),
      placed_days AS (
        SELECT o."createdAt"::date AS day, count(*)::int AS "ordersPlaced"
        FROM "Order" o
        WHERE o.deleted = false AND o."createdAt" >= ${dayKey(from)}::date AND o."createdAt" < ${dayKey(to)}::date
        GROUP BY 1
      )
      INSERT INTO "AnalyticsDailySales" (
        day, "paidOrders", "unitsSold", "grossRevenue", "itemSales", "itemDiscounts", "orderDiscounts",
        "loyaltyDiscounts", shipping, "shippingDiscounts", tax, "refundCount", refunds, "refundedShipping",
        "refundedTax", "unallocatedRefunds", "ordersPlaced", "computedAt"
      )
      SELECT d.day,
        COALESCE(od."paidOrders", 0), COALESCE(od."unitsSold", 0), COALESCE(od."grossRevenue", 0),
        COALESCE(od."itemSales", 0), COALESCE(od."itemDiscounts", 0), COALESCE(od."orderDiscounts", 0),
        COALESCE(od."loyaltyDiscounts", 0), COALESCE(od.shipping, 0), COALESCE(od."shippingDiscounts", 0),
        COALESCE(od.tax, 0), COALESCE(rd."refundCount", 0), COALESCE(rd.refunds, 0),
        COALESCE(rd."refundedShipping", 0), COALESCE(rd."refundedTax", 0), COALESCE(rd."unallocatedRefunds", 0),
        COALESCE(pd."ordersPlaced", 0), ${computedAt}
      FROM (
        SELECT g.ts::date AS day
        FROM generate_series(${dayKey(from)}::timestamp, ${dayKey(to)}::timestamp - interval '1 day', interval '1 day') AS g(ts)
      ) d
      LEFT JOIN order_days od ON od.day = d.day
      LEFT JOIN refund_days rd ON rd.day = d.day
      LEFT JOIN placed_days pd ON pd.day = d.day
      ON CONFLICT (day) DO UPDATE SET
        "paidOrders" = EXCLUDED."paidOrders", "unitsSold" = EXCLUDED."unitsSold",
        "grossRevenue" = EXCLUDED."grossRevenue", "itemSales" = EXCLUDED."itemSales",
        "itemDiscounts" = EXCLUDED."itemDiscounts", "orderDiscounts" = EXCLUDED."orderDiscounts",
        "loyaltyDiscounts" = EXCLUDED."loyaltyDiscounts", shipping = EXCLUDED.shipping,
        "shippingDiscounts" = EXCLUDED."shippingDiscounts", tax = EXCLUDED.tax,
        "refundCount" = EXCLUDED."refundCount", refunds = EXCLUDED.refunds,
        "refundedShipping" = EXCLUDED."refundedShipping", "refundedTax" = EXCLUDED."refundedTax",
        "unallocatedRefunds" = EXCLUDED."unallocatedRefunds", "ordersPlaced" = EXCLUDED."ordersPlaced",
        "computedAt" = EXCLUDED."computedAt"
    `;
  }

  /**
   * Sales on the order's paid day, line refunds on the refund's day, restocks (a paid order cancelled before
   * dispatch, or returned goods put back on the shelf) on the movement's day at the line's snapshotted cost.
   */
  private async rebuildVariants(tx: Tx, range: DayRange): Promise<void> {
    const { from, to } = range;
    await tx.$executeRaw`DELETE FROM "AnalyticsDailyVariant" WHERE day >= ${dayKey(from)}::date AND day < ${dayKey(to)}::date`;
    await tx.$executeRaw`
      WITH paid AS (${paidOrders(range)}),
      refunds AS (${processedRefunds(range)}),
      facts AS (
        SELECT p."paidAt"::date AS day, oi."variantId", oi."productId",
          oi.quantity AS "unitsSold", ${LINE_CHARGED} AS sales, 0 AS "unitsRefunded", 0::numeric AS refunds,
          0 AS "unitsRestocked",
          CASE WHEN oi."unitCost" IS NOT NULL THEN ${LINE_EX_TAX} ELSE 0 END AS "costedNetSales",
          COALESCE(oi."unitCost" * oi.quantity, 0) AS cogs,
          CASE WHEN oi."unitCost" IS NULL THEN oi.quantity ELSE 0 END AS "unknownCostUnits",
          CASE WHEN oi."unitCost" IS NULL THEN ${LINE_EX_TAX} ELSE 0 END AS "unknownCostNetSales"
        FROM paid p JOIN "OrderItem" oi ON oi."orderId" = p."orderId"
        UNION ALL
        SELECT r.day, oi."variantId", oi."productId",
          0, 0, rl.quantity, rl.amount, 0,
          CASE WHEN oi."unitCost" IS NOT NULL THEN -${REFUND_EX_TAX} ELSE 0 END,
          0, 0,
          CASE WHEN oi."unitCost" IS NULL THEN -${REFUND_EX_TAX} ELSE 0 END
        FROM refunds r
        JOIN "RefundLine" rl ON rl."refundId" = r.id
        JOIN "OrderItem" oi ON oi.id = rl."orderItemId"
        UNION ALL
        SELECT m."createdAt"::date, m."variantId", line."productId",
          0, 0, 0, 0, m."onHandDelta",
          0, -COALESCE(m."onHandDelta" * line."unitCost", 0), 0, 0
        FROM "StockMovement" m
        LEFT JOIN "ReturnRequest" rr ON m."refType" = 'ReturnRequest' AND rr.id = m."refId"
        CROSS JOIN LATERAL (
          SELECT oi."productId", MAX(oi."unitCost") AS "unitCost"
          FROM "OrderItem" oi
          WHERE oi."orderId" = COALESCE(rr."orderId", m."refId") AND oi."variantId" = m."variantId"
          GROUP BY oi."productId"
        ) line
        WHERE m.reason = 'RETURN_RESTOCK' AND m."refType" IN ('Order', 'ReturnRequest')
          AND m."createdAt" >= ${dayKey(from)}::date AND m."createdAt" < ${dayKey(to)}::date
          AND EXISTS (
            SELECT 1 FROM "PaymentIntent" intent JOIN "PaymentAttempt" pa ON pa."intentId" = intent.id
            WHERE intent."orderId" = COALESCE(rr."orderId", m."refId") AND ${ACCEPTED}
          )
      )
      INSERT INTO "AnalyticsDailyVariant" (
        day, "variantId", "productId", "unitsSold", sales, "unitsRefunded", refunds, "unitsRestocked",
        "costedNetSales", cogs, "unknownCostUnits", "unknownCostNetSales"
      )
      SELECT day, "variantId", MIN("productId"), sum("unitsSold")::int, sum(sales), sum("unitsRefunded")::int,
        sum(refunds), sum("unitsRestocked")::int, ROUND(sum("costedNetSales"), 2), sum(cogs),
        sum("unknownCostUnits")::int, ROUND(sum("unknownCostNetSales"), 2)
      FROM facts
      GROUP BY day, "variantId"
    `;
  }

  private async rebuildPromotions(tx: Tx, range: DayRange): Promise<void> {
    const { from, to } = range;
    await tx.$executeRaw`DELETE FROM "AnalyticsDailyPromotion" WHERE day >= ${dayKey(from)}::date AND day < ${dayKey(to)}::date`;
    await tx.$executeRaw`
      WITH paid AS (${paidOrders(range)}),
      used AS (
        SELECT p."paidAt"::date AS day, a."orderId", a."sourceId" AS "promotionId",
          COALESCE(MAX(a.code), '') AS "couponCode", -sum(a.amount) AS discount
        FROM paid p JOIN "OrderAdjustment" a ON a."orderId" = p."orderId"
        WHERE a."sourceId" IS NOT NULL AND a.type <> 'LOYALTY_POINTS'
        GROUP BY 1, 2, 3
      )
      INSERT INTO "AnalyticsDailyPromotion" (day, "promotionId", "couponCode", orders, discount, revenue, units)
      SELECT u.day, u."promotionId", u."couponCode", count(*)::int, sum(u.discount), sum(o."grandTotal"),
        COALESCE(sum(red.units), 0)::int
      FROM used u
      JOIN "Order" o ON o.id = u."orderId"
      LEFT JOIN "Redemption" red ON red."orderId" = u."orderId" AND red."promotionId" = u."promotionId"
      GROUP BY 1, 2, 3
    `;
  }

  private async rebuildCustomers(tx: Tx, range: DayRange): Promise<void> {
    const { from, to } = range;
    await tx.$executeRaw`DELETE FROM "AnalyticsDailyCustomer" WHERE day >= ${dayKey(from)}::date AND day < ${dayKey(to)}::date`;
    await tx.$executeRaw`
      WITH paid AS (${paidOrders(range)}),
      facts AS (
        SELECT p."paidAt"::date AS day, ${CUSTOMER_KEY} AS "customerKey", 1 AS orders, o."grandTotal" AS revenue,
          0::numeric AS refunds
        FROM paid p JOIN "Order" o ON o.id = p."orderId"
        UNION ALL
        SELECT r.day, ${CUSTOMER_KEY}, 0, 0, r.amount
        FROM (${processedRefunds(range)}) r JOIN "Order" o ON o.id = r."orderId"
      )
      INSERT INTO "AnalyticsDailyCustomer" (day, "customerKey", orders, revenue, refunds)
      SELECT day, "customerKey", sum(orders)::int, sum(revenue), sum(refunds)
      FROM facts
      WHERE "customerKey" IS NOT NULL
      GROUP BY 1, 2
    `;
  }

  async setCounter(tx: Tx, column: 'cartsStarted' | 'checkoutQuotes', day: Date, count: number): Promise<void> {
    await tx.analyticsDailySales.updateMany({ where: { day }, data: { [column]: count } });
  }
}
