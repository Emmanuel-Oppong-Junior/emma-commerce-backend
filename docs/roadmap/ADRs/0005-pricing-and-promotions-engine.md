# ADR-0005 — Pricing and promotions engine

Status: **Accepted** (Emmanuel, 2026-11-18) · Date: 2026-11-16

## Context
Today, discounts are computed in three places that disagree:
- the product discount loader, for display;
- `DiscountService.applyDiscountsToCart`, for `cartWithDiscount`;
- `finalizeOrder`, which is customer-callable, rewrites the total and drops shipping and the coupon (DISC-01).

`createOrder` ignores discounts altogether (MONEY-01). The "best discount" picker compares raw values across PERCENTAGE and FLAT (DISC-02). Coupons are validated outside the order transaction and `usedCount` is incremented unconditionally (CPN-01). There are no stacking rules, no BXGY, no tiered/volume pricing, no price history.

## Decision drivers
Deterministic, explainable totals. The quote shown to the customer must equal the amount charged. No client influence on prices. Concurrency-safe limits. Easy to unit-test.

## Recommendation
1. **Pure pricing engine module** (no I/O): `price(cart, context) → Quote`. The input is a snapshot of SKUs, prices, applicable promotions, coupon, customer segment, shipping quote, tax config and the clock. The output has line-level breakdowns (list price, each adjustment with its source promotion ID, tax components), order-level adjustments, shipping, tax, grand total and a `quoteHash`.
2. **Promotion model**: `Promotion { scope: SKU|PRODUCT|CATEGORY|COLLECTION|BRAND|CART, type: PERCENT|AMOUNT_OFF|FIXED_PRICE|BXGY|TIERED|FREE_SHIPPING, conditions (min spend, min qty, first order, segment, channel), schedule, priority, stackingGroup, exclusive: bool, usage limits (global/per-customer), budget/quantity cap for flash sales }`. A coupon is a code that unlocks a promotion.
3. **Stacking rule (default, configurable per store):**
   - Within a stacking group, pick the adjustment with the largest monetary saving, computed with the `Money` type. This fixes DISC-02.
   - Groups apply in priority order: item-level, then cart-level, then shipping.
   - An `exclusive` promotion blocks the others.
   - Ties go to the lowest priority number, then to the oldest promotion.
   - Line prices never go below zero.
   - Cart-level amounts are allocated to lines with largest-remainder allocation (ADR-0004), so refunds are exact.
4. **Server-side quote → order**: `createOrder` recomputes the quote inside the transaction. The client never sends prices. The order stores the full breakdown as an immutable snapshot (line prices, adjustments, tax lines, shipping, currency, quote version). `finalizeOrder` is deleted.
5. **Limits**: coupon and promotion usage is reserved inside the order transaction with a conditional update (`UPDATE ... SET used = used + 1 WHERE id = ? AND used < limit`) and a unique `(promotionId, customerId, orderId)` redemption row. The redemption is released when the order is cancelled or expires before payment. Refund handling is per store policy.
6. **Price history**: `PriceChange(skuId, oldPrice, newPrice, actorId, reason, at)`, written in the same transaction as the price change. Audit-logged.
7. **B2B / wholesale**: a `PriceList` (per customer group, with quantity tiers) overrides the SKU list price. It is a later phase that plugs into the same engine.

## Reversibility
Moderate. Order snapshots make the engine replaceable without rewriting history.
