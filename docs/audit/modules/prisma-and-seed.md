# Prisma schema, migrations, seed and PrismaService
Verdict: NEEDS WORK
Reviewed by: Schema & Data-Integrity reviewer, Opus 5.5 (claude-opus-5-5), high effort
Files reviewed:
- `prisma/schema.prisma`
- `prisma/migrations/20260412120208_first_migration/migration.sql`
- `prisma/migrations/20260413212251_drop_tax_rate_and_created_tax_table/migration.sql`
- `prisma/migrations/migration_lock.toml`
- deleted migrations, via git history (commit `6b649e6`)
- `prisma/seeders/main.ts`, `prisma/seeders/seed-context.ts`
- `src/prisma/prisma.service.ts`
- all 20 `src/**/*.repository.ts` (index and query cross-check)
- the service paths cited in the findings

The full analysis, with the multi-vertical options and ER diagram, is in `docs/audit/01-database-schema-review.md`. This file is the module-template view, and its IDs are shared with that report.

## Summary
The schema is valid and the migration SQL matches it exactly (no drift by reading). Core money columns are `Decimal(10,2)`, and orders `Restrict` deletion of products and users.

The defects are in what the schema does **not** hold:
- **Payments.** One mutable, deletable `Payment` per order. There are no attempts, events or refund records, and the Paystack reference has no unique index.
- **Order history.** There are no tax, shipping, subtotal, currency or product-name snapshots.
- **Stock.** It is a single unguarded counter (no CHECK, no reservations), which lets cancel, delete and refund paths each restore the same stock.
- **Variants.** They exist but are never sold.
- **Migration history.** It was squashed after 23 migrations had shipped, and the order-number sequence silently changed from 10001 to 1.
- **Seeder.** It is unsafe for production: no environment guard, 500 fake products per run, and an un-normalised admin email.

None of this requires a full rewrite to fix for today's single-shop behaviour. The multi-vertical target, however, needs the redesign options in section 11 of the main report.

## Findings
| ID | Severity | Category | Description | Evidence (file:line) | Confirmation | Business impact | Recommended fix |
|---|---|---|---|---|---|---|---|
| DB-01 | High | Data integrity | One `Payment` per order. Retrying payment hard-deletes the pending row, so a later success on the old reference cannot be matched. | `prisma/schema.prisma:366`; `src/payment/payment.service.ts:248-259, 301, 365-367, 68-70, 335-337` | Confirmed by reading | Customer charged while the order stays unpaid or is auto-cancelled | `PaymentAttempt` model (unique reference). Never delete attempts. |
| DB-02 | High | Data integrity | Admin `removePayment` hard-deletes payments. `Order → Payment` cascades. | `src/payment/payment.resolver.ts:68-72`; `src/payment/payment.service.ts:231-234`; `prisma/schema.prisma:367` | Confirmed by reading | Lost financial records, insider-fraud vector, reconciliation impossible | Remove the hard delete. Make the FK `Restrict`. Append-only payments. |
| DB-03 | Medium | Data integrity | `Payment.transactionId` is not unique or indexed. There are no `WebhookEvent` or `Refund` tables. | `prisma/schema.prisma:372`; `src/payment/payment.repository.ts:20-24`; `src/returns/returns.service.ts:104-109` | Confirmed by reading | Double processing or double refund, plus sequential-scan webhook lookups | Unique reference. `WebhookEvent(eventId @unique)`. `Refund` with idempotency key. |
| DB-04 | High | Business logic | Order has no tax, subtotal, shipping fee or currency. Tax is baked into `Product.price` and rates are not recorded per order. | `prisma/schema.prisma:306-341, 549-556`; `src/order/order.service.ts:312`; `src/tax/tax.service.ts:55-63` | Confirmed by reading | Cannot report VAT and levies per invoice, and cannot refund shipping separately | Add totals breakdown and currency to Order. Add line tax snapshots. |
| DB-05 | Medium | Data integrity | `OrderItem` lacks name, SKU, options and image snapshots. Analytics use the live product name and category. | `prisma/schema.prisma:343-362`; `src/analytics/analytics.service.ts:44-56, 73-85` | Confirmed by reading | Product edits rewrite invoices and past reports | Snapshot the columns at checkout. |
| DB-06 | High | Data integrity | Cancel can be repeated on a CANCELLED order, and each call restores stock. Soft delete restores stock for any status. Refunding a cancelled order restores stock again. | `src/order/order.service.ts:193-198, 401-405, 407-422, 437-443`; `src/returns/returns.service.ts:106-109` | Confirmed by reading | Any customer can inflate stock, which leads to overselling | Conditional status transitions, reservation and ledger model, CHECK `quantity >= 0`. |
| DB-07 | Medium | Data integrity | `updateStatus`/`softDelete` use the root client inside a transaction callback. Some stock changes write no InventoryLog. READ COMMITTED check-then-act everywhere. | `src/order/order.repository.ts:100-121`; `src/order/order.service.ts:421, 442`; `src/returns/returns.repository.ts:51-58` | Confirmed by reading | Ledger cannot reconcile, and partial failures are possible | Pass `tx` through. Mandatory movement log. Locks or Serializable where needed. |
| DB-08 | High | Data integrity | Migration history squashed. Existing DBs cannot `migrate deploy`. Order numbers now start at 1 rather than 10001. | commit `6b649e6`; `first_migration/migration.sql:254`; deleted `20260411220000_add_order_number_sequence` | Confirmed by reading; env impact Suspected | Failed deploys or data-losing resets. Order volume exposed to customers. | Baseline each env (`migrate diff`, then `migrate resolve --applied`). Restart the sequence if wanted. |
| DB-09 | Medium | Business logic | Coupon limit is check-then-increment. `@@unique([couponId,userId])` allows one use per customer forever, and cancelled orders burn the use. | `src/coupons/coupons.service.ts:93-100`; `src/coupons/coupons.repository.ts:61-64`; `prisma/schema.prisma:458, 480` | Confirmed by reading | Over-redemption, and customers lose coupons on cancel | Conditional increment. `perCustomerLimit`. Release on cancel. |
| DB-10 | Medium | Data integrity | Nullable `price`/`basePrice`. No `basePrice` backfill. Toggling `isTaxable` on legacy or seeded products sets price to 0. | `prisma/schema.prisma:162-165`; `prisma/migrations/20260413212251_drop_tax_rate_and_created_tax_table/migration.sql:9-10`; `src/products/products.service.ts:111-115` | Confirmed by reading | Products sold at GHS 0 | Backfill, NOT NULL, CHECK ≥ 0, drop `currentPrice`. |
| DB-11 | Medium | Business logic | `Product.currency` is ignored in totals. Order has no currency. `Payment.currency` is free text. | `prisma/schema.prisma:164, 369`; `src/order/order.service.ts:341-343` | Confirmed by reading | Mispricing of non-GHS products | Restrict to GHS for now. Store the currency enum on order, line and payment. |
| DB-12 | Medium | Business logic | Variants are never used by cart or order. Second stock counter. No variant SKU or uniqueness. | `prisma/schema.prisma:133-153`; `src/cart/cart.repository.ts:35-48`; `src/order/order.service.ts:316-327` | Confirmed by reading | Fashion and electronics cannot be sold correctly | Variant as the sellable unit (main report 11.2). |
| DB-13 | Medium | Business logic | `Product.status` is never filtered. DRAFT products are listable. The index is dead. | `prisma/schema.prisma:179, 208`; `src/products/products.service.ts:200-219` | Confirmed by reading | Draft and seed products exposed | Single lifecycle field, filtered in storefront queries. |
| DB-14 | Medium | Data integrity | Address FK on Order is `Restrict`, so a used address cannot be deleted and the user gets a generic 500. | `prisma/schema.prisma:317`; `src/addresses/addresses.service.ts:74-77`; `src/commons/filters/all-exceptions.filter.ts:12-17` | Confirmed by reading | Customer-facing errors | `SetNull` (the snapshot exists). Map Prisma error codes. |
| DB-15 | Low | Data integrity | `CouponUsage.orderId` has no FK. | `prisma/schema.prisma:475` | Confirmed by reading | Orphans possible | Add the relation. |
| DB-16 | Low | Data integrity | No review uniqueness per user and product. No score CHECK. Soft-delete columns unused. | `prisma/schema.prisma:238-253`; `src/review/review.repository.ts:13-15, 78-87` | Confirmed by reading | Rating manipulation, lost moderation history | Unique, CHECK, a consistent delete policy. |
| DB-17 | Medium | Security | The seeder has no prod guard, is not idempotent (uuid SKUs mean +500 products per run) and does not normalise the admin email. It logs success even when skipped. | `prisma/seeders/main.ts:115-147, 128, 150-170, 178` | Confirmed by reading | Fake orderable products in prod. Super admin locked out. | Split `seed:admin` (prod-safe) from `seed:demo` (dev only). |
| DB-18 | Low | Data integrity | `DECIMAL(65,30)` on `Discount.value`, `Order.discountTotal` and `totalWithOutDiscount`. | `prisma/schema.prisma:260, 311-312` | Confirmed by reading | Inconsistent rounding | `@db.Decimal(10,2)`. |
| DB-19 | Medium | Business logic | Discount targets are m:n for Product but 1:n for Variant and Category. Deleting a discount nulls `OrderItem.discountId`. | `prisma/schema.prisma:95-96, 143-144, 264-268, 356-357` | Confirmed by reading | Promotions silently detach, and attribution is lost | Explicit join tables. Snapshot discount on the line. |
| DB-20 | Medium | Bug | The tax reprice raw SQL binds a JS float into `ROUND(numeric * $1, 2)`, which may resolve to `round(float8,int)` (non-existent). It runs outside a transaction with the tax write. | `src/tax/tax.service.ts:15-35, 55-63`; `src/tax/tax.repository.ts:28-31` | Suspected | Tax saved but prices stale | `::numeric` cast, a single transaction, or compute tax at checkout. |
| DB-21 | Low | Performance | Redundant indexes (sku, code, tokenHash, couponId, Order.userId) and unused ones (isActive+status, deleted, trackingNumber, ReturnRequest.status, InventoryLog.action). | main report section 5 | Confirmed by reading | Write overhead | Drop them. |
| DB-22 | Medium | Performance | Missing indexes for the payment reference, expiry sweep, user orders by date, analytics, inventory history, reset token and full-text search. | main report section 5 | Confirmed by reading | Latency grows with data. Possible tsquery syntax 500s. | Add the indexes. Use `websearch_to_tsquery` with a GIN index. |
| DB-23 | Medium | Data integrity | Product delete cascades `InventoryLog` and `Review`. | `prisma/schema.prisma:247, 513`; `src/products/products.service.ts:51-55` | Confirmed by reading | Stock audit trail destroyed | `Restrict`, and archive instead of delete. |
| DB-24 | Medium | Data integrity | No anonymisation path. Users with orders cannot be deleted. | `prisma/schema.prisma:310, 496`; `src/users/users.service.ts:215-219` | Confirmed by reading | Cannot honour erasure requests | `anonymizedAt` and PII scrub. |
| DB-25 | Low | Data integrity | `AuthProvider.providerId` is globally unique. `provider` is a free string. | `prisma/schema.prisma:61-62, 66` | Confirmed by reading | Edge-case sign-up block | Per-provider unique, enum. |
| DB-26 | Low | Data integrity | No unique on cart lines. Shipping zone cities can overlap. No pickup snapshot. | `prisma/schema.prisma:285-304, 537-547`; `src/cart/cart.repository.ts:18-48`; `src/shipping-zones/shipping-zones.repository.ts:32-37` | Confirmed by reading | Duplicate lines, arbitrary fee | Uniques, `ShippingZoneCity`, snapshot JSON. |
| DB-27 | Low | Docs | `CLAUDE.md` says Prisma errors are mapped by the filter. They are not. | `CLAUDE.md:71`; `src/commons/filters/all-exceptions.filter.ts:12-29` | Confirmed by reading | Opaque 500s, misleading docs | Map P2002, P2003, P2025, or fix the doc. |
| DB-28 | Low | Tests | The e2e DB helper uses the dropped `taxRate` and misses the new tables. No seed or migration tests. | `test/helpers/db.helper.ts:49` | Confirmed by reading + baseline typecheck | E2E cannot run | Fix the helper. Add `migrate diff --exit-code` in CI. |
| DB-29 | Info | Data integrity | `PrismaService` has no logging, transaction timeout or soft-delete extension. Deprecated `package.json#prisma`. `prisma format` fails. Seed depends on devDependencies. | `src/prisma/prisma.service.ts:1-14`; `package.json:70-117` | Confirmed by reading | Invisible slow queries, prod seed fails | Configure the client, `prisma.config.ts`, format. |

## Test assessment
- No tests cover `PrismaService`, the seeder, or the migrations. Repository specs mock Prisma, so they cannot detect constraint, cascade or index problems.
- E2E, the only place FK and cascade behaviour would be exercised, cannot run. There is no `.env.test`, and `test/helpers/db.helper.ts:49` fails typecheck because it references `prisma.taxRate` (baseline).
- No test exercises a concurrent path (double cancel, coupon limit, duplicate webhook), and no test asserts a DB constraint.

## Definition of done to close this module
1. **Payments**
   - Never hard-deleted.
   - `Payment.order` is `Restrict`.
   - Attempts and events modelled, with `reference` and provider `eventId` unique.
   - A `Refund` model with an idempotency key (DB-01, DB-02, DB-03).
2. **Orders**
   - Store `subtotal`, `shippingFee`, `discountTotal`, `taxTotal` and `currency`.
   - Lines snapshot name, SKU, options and tax.
   - Analytics read the snapshots (DB-04, DB-05).
3. **Stock**
   - Changes go through conditional state transitions in one transaction, each with a movement row.
   - CHECK constraints for non-negative quantity and prices, and for review score.
   - An e2e test proves that double cancel, delete-after-cancel and refund-after-cancel do not inflate stock (DB-06, DB-07, DB-10).
4. **Migrations**
   - Every environment baselined against `first_migration`, with the result recorded.
   - The order-number start decided and migrated.
   - CI runs `prisma migrate diff --exit-code` against a shadow DB and `prisma format --check` (DB-08, DB-28, DB-29).
5. **Seed**
   - Split into a prod-safe, idempotent admin seed (normalised email) and a dev-only demo seed that refuses to run in production (DB-17).
6. **Constraints and indexes**
   - Missing uniques added: review, cart line, variant combo/SKU, shipping-zone city, `CouponUsage.order` FK.
   - Redundant indexes dropped and missing hot-path indexes added (DB-15, DB-16, DB-21, DB-22, DB-26).
7. **Product and coupon rules**
   - `Product.status` enforced in storefront queries.
   - `Product.currency` either removed or honoured end-to-end.
   - Coupon limit enforced atomically (DB-09, DB-11, DB-13).
8. **E2E**
   - The e2e helper compiles and the suite runs green against a fresh migrated database.
