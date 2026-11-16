# Analytics
Verdict: NEEDS WORK
Reviewed by: Admin/Analytics/Platform reviewer, Sonnet 5.5, medium
Files reviewed: src/analytics/analytics.service.ts, analytics.resolver.ts, analytics.module.ts, analytics.service.spec.ts, dto/*.ts, entities/*; prisma/schema.prisma (Order, OrderItem, ReturnRequest, Payment enums)

## Summary
Admin-only (class-level `@Roles(ADMIN, SUPER_ADMIN)`, resolver.ts:12) and SQL is safe (tagged `$queryRaw`, parameterised `LIMIT`). But "revenue" is defined as "every non-cancelled, non-deleted order", so unpaid PENDING orders, COD orders never collected, and refunded orders all count as sales. Two different revenue definitions (order total vs item subtotal) will not reconcile. Category/top-product reports are all-time with no date filter, uncached, and run on the request path.

## Findings
| ID | Severity | Category | Description | Evidence | Confirmation | Business impact | Recommended fix |
|---|---|---|---|---|---|---|---|
| ANA-01 | High | Business logic | Revenue counts unpaid orders. Filter is only `status != CANCELLED AND deleted = false`; PENDING (unpaid online checkout, until the hourly expiry) and COD orders not yet delivered/collected are summed into revenue, AOV, order count and "revenueToday". | analytics.service.ts:21-23, 53, 83, 112-115 | Confirmed by reading | Dashboard overstates revenue; owner makes stock/cash decisions on money not received. | Define "recognised revenue": paid online (Payment.status COMPLETED) or COD with payment recorded / DELIVERED. Join Payment; show PENDING separately as pipeline. |
| ANA-02 | High | Business logic | Refunds are never deducted. A REFUNDED `ReturnRequest` (returns.service.ts:104-108) does not change Order.status, and analytics never reads ReturnRequest.refundAmount. Partial refunds invisible. | analytics.service.ts:18-35 vs returns.service.ts:88-109 | Confirmed by reading | Gross revenue reported as net; will not match Paystack settlements. | Subtract SUM(refundAmount) of REFUNDED returns; show gross, refunds, net. |
| ANA-03 | Medium | Business logic | Inconsistent revenue definitions: salesReport sums `Order.totalAmount` (post-coupon, incl. tax/shipping), topProducts/revenueByCategory sum `priceAtOrder*quantity` (item subtotal, ignores order-level coupon, shipping, tax). Category totals never equal the sales report. | analytics.service.ts:25 vs 49, 77 | Confirmed by reading | Two "revenue" numbers that disagree; erodes trust. | Pick one definition (net of discounts, excl. tax/shipping for product analytics), document it, allocate coupon discount pro-rata. |
| ANA-04 | Medium | Bug | Date range: `lte endDate` means a date-only endDate (`2026-01-31` -> 00:00) excludes the whole last day. No check start <= end, no max span. Dashboard "today" uses server-local `setHours(0,0,0,0)`; correct only while the host TZ is UTC (Ghana is UTC+0) and wrong on any other host/market. | analytics.service.ts:23, 102-103; dto/sales-report.args.ts:6-14 | Confirmed by reading | Daily reports miss the final day; wrong "today" if host TZ changes. | Half-open `[start, end+1d)`; validate and cap range; compute "today" in explicit configured timezone. |
| ANA-05 | Medium | Performance | Unbounded all-time aggregates on request path, no caching: topProducts and revenueByCategory scan all OrderItem rows joined to Order/Product with no date predicate; salesReport filters `Order.createdAt` which has no index (Order indexes: userId, [userId,status], deleted, trackingNumber). dashboardSummary runs 5 queries per call. CacheModule exists but unused. | analytics.service.ts:44-57, 73-86, 19-28; schema.prisma:337-340 | Index absence Confirmed by reading; load impact Suspected (needs verification) | Dashboard slows linearly with history; heavy admin page can hurt checkout on the same DB. | Add `@@index([createdAt])` / `[status, deleted, createdAt]`; date params on all reports; cache 60-300s; later rollup table or replica. |
| ANA-06 | Low | Business logic | Low-stock: variant count ignores whether parent product is active (service.ts:122-125); product count lumps out-of-stock with low-stock. | analytics.service.ts:118-125 | Confirmed by reading | Inflated alerts. | Join variant->product, filter isActive; report out-of-stock separately. |
| ANA-07 | Low | Business logic | No currency on Order; all sums assumed GHS. Archived products still appear in topProducts via JOIN. | analytics.service.ts:44-57 | Confirmed by reading | Rework needed for multi-currency / multi-vertical reporting. | Snapshot currency on Order when needed; add vertical/category-tree rollups. |
| ANA-08 | Low | Tests | Spec mocks `$queryRaw`/`aggregate` and asserts only on result mapping; cannot detect ANA-01..05. Redundant `as unknown as number` casts. | analytics.service.spec.ts:28-143; service.ts:132-133 | Confirmed by reading | False confidence. | Integration tests with seeded PENDING/CANCELLED/refunded orders. |
| ANA-09 | Info | Security | Positive: class-level admin guard; tagged-template raw SQL with bound limit (1..100); no `$queryRawUnsafe`. | resolver.ts:12; service.ts:44-57; dto/top-products.args.ts | Confirmed by reading | - | - |

## Test assessment
Unit spec passes per baseline (not in failing list) but is mock-mapping only. No resolver/guard or e2e tests.

## Definition of done to close this module
1. Revenue = collected, net of refunds, one definition (ANA-01/02/03).
2. Half-open, validated, explicit-timezone ranges (ANA-04).
3. createdAt index, date params, caching (ANA-05).
4. Integration tests on a real test DB for PENDING/CANCELLED/deleted/refunded/COD orders.
