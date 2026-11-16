# Money flow: how a price becomes an order total

Author: Money reviewer, Claude Opus 5.5 (claude-opus-5-5), high. Date: 2026-11-16.
Scope: read-only trace through `products`, `tax`, `discount`, `cart`, `coupons`, `shipping-zones`, `order`, `payment`, `returns`, `analytics`. Module findings: `modules/discount.md` (DISC-*), `modules/coupons.md` (CPN-*), `modules/tax.md` (TAX-*), `modules/currency.md` (CUR-*). Cross-module findings are MONEY-* below.

## 1. Answers to the headline questions

| Question | Answer |
|---|---|
| Is any price taken from client input at checkout? | **No item price is.** `createOrder` takes no amounts; line prices come from `Product.price` in the DB. **But the charge currency is client input** (CUR-01), and `validateCoupon` previews against a client-supplied `orderTotal` (preview only, CPN-10). |
| Is every total recomputed server-side at order time from current DB prices? | **Partly.** Subtotal = Σ current `Product.price` × qty (read before the transaction; stock is re-checked inside it, price is not). Product discounts are **not** applied (MONEY-01); variants are ignored (DISC-08); tax is only implicit in `Product.price` (TAX-03); shipping comes from a zone lookup with a silent 0 fallback (MONEY-02). After creation, `finalizeOrder` lets the customer re-price the order (DISC-01). |
| Number vs Decimal | Decimal in the DB, `Number()` everywhere in code, float arithmetic, a single `toFixed(2)` at the end of `buildOrderDetails`. No written rounding rule. See §3. |
| Does `totalAmount` include shipping and tax? | At creation: yes, shipping is added; tax is "included" only because `Product.price` is tax-inclusive. Neither is stored separately. After `finalizeOrder`: shipping and coupon are removed (DISC-01). |
| Pesewas conversion for Paystack | `Math.round(Number(totalAmount) * 100)`. Safe for `Decimal(10,2)` values (e.g. 4.35 × 100 = 434.99999999999994 → 435). No defect (MONEY-08). |

## 2. Step-by-step trace

| # | Step | Code | What happens to the money | Problems |
|---|---|---|---|---|
| 1 | Admin creates product | `products.service.ts:26-33, 101-105` | `basePrice` (string) → `Number` → `price = basePrice × (1 + Σ active Tax.rate)` in float → `toFixed(2)` → stored in `Product.price Decimal(10,2)`. `currency` stored but unused. | Float + toFixed (TAX-05); currency ignored at checkout (CUR-02). |
| 2 | Admin edits product | `products.service.ts:40-46, 107-121`; `schema.gql:1630` | GraphQL injects `isTaxable = false` if omitted → price reset to `basePrice` (or 0.00 when `basePrice` is null). | TAX-01. |
| 3 | Admin changes a tax | `tax.service.ts:15-35, 55-63` | Tax row saved; then raw SQL re-prices all taxable products: `ROUND(basePrice × float_param, 2)`. | Likely SQL error after commit (TAX-02); non-atomic (TAX-06); variants untouched (TAX-07). |
| 4 | Catalogue shows price | `products.resolver.ts:127-137`; `products/loaders/discount.loader.ts` | `discountedPrice` = price − best(product + category discounts), float, not capped, minimumPurchase ignored. | DISC-02, DISC-03, DISC-04. |
| 5 | Add to cart | `cart.service.ts:33-39, 112-130`; `cart.repository.ts:35-48` | Stores `CartItem.originalPrice = product.price`; no `variantId` accepted. | Variants unreachable (DISC-08). |
| 6 | View cart with discounts | `cart.resolver.ts:57-61`; `discount.service.ts:191-197, 300-354` | `total = Σ product.price × qty`, `discountTotal = Σ discountAmount × qty`, `finalTotal = total − discountTotal` (floats, unrounded, can be negative); writes `discountedPrice` to each CartItem; throws if any discount's minimum isn't met. No shipping, coupon or tax lines. | DISC-03..06. |
| 7 | Preview coupon | `coupons.resolver.ts:46-54` | Discount computed on client `orderTotal`. | CPN-04, CPN-10. |
| 8 | Create order | `order.service.ts:53-117, 290-343` | (a) shipping fee = `ShippingZone.fee` for `address.city` or **0** if no zone matches; (b) each line `priceAtOrder = originalPrice = product.price` (no discount, no variant, `discountAmount` null); (c) `subtotal = Σ Number(priceAtOrder) × qty` (float); (d) coupon validated outside the tx, `discountAmount` on subtotal (unrounded); (e) `totalAmount = Decimal(max(0, subtotal + shipping − coupon).toFixed(2))`. | MONEY-01, MONEY-02, CPN-01, CPN-05. |
| 9 | Persist order | `order.service.ts:345-391`; `order.repository.ts:43-79` | One transaction: decrement stock, create Order (`totalAmount`, `couponDiscount`; no subtotal/shipping/tax/discount columns written), record coupon usage (unconditional increment), clear cart. | CPN-01, MONEY-03. |
| 10 | (Documented) "finalize" | `order.resolver.ts:124-129`; `discount.service.ts:205-209`; `discount.repository.ts:152-162` | Overwrites `totalAmount` = gross current-price subtotal; writes `discountTotal`, inverted `totalWithOutDiscount`; overwrites `OrderItem.originalPrice`. Any status, repeatable. | DISC-01. |
| 11 | Initiate payment | `payment.service.ts:41-60, 261-305` | Amount = `Number(order.totalAmount)` → pesewas; **currency from request body**; no order-status check (cancelled orders can be paid); any PENDING Payment row is deleted and recreated. | CUR-01, MONEY-04. |
| 12 | Verify / webhook | `payment.service.ts:68-73, 347-363` | `status === 'success'` → Payment COMPLETED, Order PROCESSING. Paid amount and currency not compared with the order. | MONEY-04, CUR-01. |
| 13 | COD collection | `payment.service.ts:133-157` | Payment amount = `order.totalAmount` (whatever finalize left there), currency hard-coded GHS. | Inherits DISC-01. |
| 14 | Cancel / expire | `order.service.ts:193-217, 407-423`; `tasks/expired-orders.task.ts` | Stock restored; coupon usage not released; paid online orders get a system return request with no refund amount. | CPN-02. |
| 15 | Refund | `returns.service.ts:58-64, 88-110, 135-156` | Admin types `refundAmount` (≥ 0, no upper bound); Paystack refund in pesewas; then status → REFUNDED in a separate tx. | MONEY-05. |
| 16 | Revenue reporting | `analytics.service.ts:18-34, 116-131` | Σ `totalAmount` of all non-cancelled, non-deleted orders, including unpaid PENDING, VAT and shipping. | MONEY-07. |

## 3. Decimal → number conversion points (all arithmetic after these is binary float)

`products.service.ts:29, 104, 112` · `tax.repository.ts:30` · `discount.service.ts:172, 176, 259-260, 271-272, 310, 314, 348, 372, 376` · `discount.loader.ts:70, 86-87, 96` · `products.resolver.ts:129` · `coupons.service.ts:96, 104-105` · `order.service.ts:73, 342, 460` · `shipping-zones.service.ts:69` · `payment.service.ts:53, 148 (cast)` · `returns.service.ts:104, 137` · `analytics.service.ts:31, 33, 131`.
Rounding happens in five different ways: `toFixed(2)` (products, order total), Postgres numeric half-away-from-zero on insert into `Decimal(10,2)` columns (couponDiscount, CartItem prices), SQL `ROUND` (tax re-price), `Math.round(x*100)` (Paystack, refunds, CurrencyService), and **no rounding at all** for `DECIMAL(65,30)` columns (`Order.discountTotal`, `Order.totalWithOutDiscount`, `Discount.value`).

## 4. Worked example (current behaviour)

Setup: taxes VAT 15% + NHIL 2.5% + GETFund 2.5% active (summed ×1.20); product basePrice GHS 100, `isTaxable` → `price` 120.00; active product discount 10%; customer buys 2; delivery city "Accra" in a zone with fee GHS 25; coupon `SAVE10` = 10% PERCENTAGE.

| Where | What the customer sees / what is stored |
|---|---|
| Product page | price 120.00, `discountedPrice` 108.00 |
| `cartWithDiscount` | total 240.00, discountTotal 24.00, finalTotal 216.00 (no shipping/coupon/tax lines) |
| `validateCoupon(orderTotal: 216)` | "You save 21.6" |
| Customer's reasonable expectation | 216.00 + 25.00 − 21.60 = **219.40** |
| `createOrder` → `totalAmount` | 240.00 + 25.00 − 24.00 = **241.00** (discount ignored; coupon on the undiscounted subtotal); `couponDiscount` 24.00; no tax, shipping or discount stored |
| `POST /payment/initialize` | amount 24100 in whatever `currency` the client sent |
| If `finalizeOrder` is called first (as docs instruct) | `totalAmount` 240.00 (shipping and coupon gone), `discountTotal` 24, `totalWithOutDiscount` 216 — customer pays 240.00 |
| Tax actually collected / reportable | Unknown: 40.00 of tax is embedded in the 240 gross, the coupon reduces it by an unrecorded amount, nothing is stored |

Result: the customer is overcharged GHS 21.60 against the advertised price; if `finalizeOrder` runs, the merchant loses the GHS 25 shipping fee instead. No record allows either to be reconstructed.

## 5. Cross-module findings

| ID | Severity | Category | Description | Evidence (file:line) | Confirmation | Business impact | Recommended fix |
|---|---|---|---|---|---|---|---|
| MONEY-01 | Critical | Business logic | Product/category discounts are shown in the catalogue (`discountedPrice`) and cart (`cartWithDiscount.finalTotal`) but never applied to the charged amount. `OrdersService` doesn't depend on `DiscountService`; `createOrderItems` sets `priceAtOrder = originalPrice = product.price` and leaves `discountAmount`/`discountId` null; `computeSubtotal` uses `priceAtOrder`. | `order.service.ts:290-343` (no discount call), `order.module.ts` imports DiscountModule only for the resolver; `products.resolver.ts:127-131`; `cart.resolver.ts:57-61` | Confirmed by reading | Every promotion overcharges customers versus the displayed price (worked example: GHS 21.60 on a GHS 219.40 basket); refunds, chargebacks, consumer-protection exposure, loss of trust. | Shared pricing function applied inside `createOrder`, with line-level discount snapshots (see DISC definition of done). |
| MONEY-02 | High | Business logic | Shipping fee falls back silently to **GHS 0** when no active zone lists the address city. `Address.city` is free text typed by the customer; matching is exact after trim/lowercase ("Accra" ≠ "Accra Central" ≠ "Acra"). If two active zones contain the same city, `findFirst` with no `orderBy` returns an arbitrary one. | `shipping-zones.service.ts:9, 53-60`; `shipping-zones.repository.ts:32-37`; `order.service.ts:72-73` | Confirmed by reading | Free delivery for any unmatched or mistyped city, abusable on purpose; inconsistent fees for overlapping zones. | Reject checkout (or require a pickup) when no zone matches, or use an explicit "rest of country" zone; pick cities from a controlled list (region/district, Ghana Post GPS); enforce unique city across active zones; snapshot `shippingFee` and zone on the order. |
| MONEY-03 | Medium | Data integrity | The order stores only `totalAmount` and `couponDiscount`. No `subtotal`, `shippingFee`, `discountTotal` (only written by `finalizeOrder`), `taxTotal`, `currency`. GraphQL `Order.finalTotal` has no column and is always null; `totalWithOutDiscount` is not exposed and is semantically inverted when written. | `schema.prisma:306-341`; `order.repository.ts:61-77`; `order/entities/order.entity.ts:20-30` | Confirmed by reading | No itemised receipt/invoice; shipping can't be refunded separately; finance can't reconcile. | Persist the full breakdown at creation; make it immutable; expose it in GraphQL. |
| MONEY-04 | High | Security / Data integrity | The last money check is missing: `updatePaymentStatus` marks COMPLETED on Paystack `status === 'success'` without comparing `data.amount` (pesewas) and `data.currency` with the order, and `initiatePayment` accepts orders in any status (including CANCELLED) and re-reads a `totalAmount` that `finalizeOrder` can change between order creation and payment. | `payment.service.ts:41-60, 347-363` | Confirmed by reading | Underpaid or wrong-currency payments accepted as full payment; payments taken for cancelled orders. Payment module report owns the full analysis. | Verify amount + currency + order status inside a transaction before marking paid; lock the order total at creation. |
| MONEY-05 | Medium | Business logic / Concurrency | `refundAmount` is only `@Min(0)`: not bounded by the captured payment amount or remaining refundable balance. Only one non-rejected return per order, so partial-then-more refunds aren't possible. `processRefund` calls Paystack before flipping status in a separate transaction, so two concurrent clicks both pass the `APPROVED` check and both call Paystack. Full stock is restored regardless of refund size. Coupon usage is not released. | `returns/dto/review-return.input.ts:10-13`; `returns.service.ts:58-64, 88-110` | Confirmed by reading; whether Paystack rejects a refund above the remaining transaction amount is Suspected (needs verification) | Over-refunds or double refunds on double-click; inventory inflated on partial refunds. | Claim the return row atomically (`updateMany where status = APPROVED → PROCESSING`) before calling Paystack; cap at `payment.amount − Σ previous refunds`; idempotency key; restore stock per returned line. Returns module report owns the details. |
| MONEY-06 | Medium | Bug | No defined rounding policy and float arithmetic across the chain (§3). Demonstrated pesewa errors: coupon (CPN-05: 20.10 @ 25% → couponDiscount 5.03, total 15.08), product tax (TAX-05: 10.10 @ 15% → 11.61 vs 11.62), cart discount (DISC-05: 3 × 19.99 @ 15% → finalTotal 50.9745, lines 50.97). | see §3 | Confirmed by computation and test (probes) | Totals that don't add up; reconciliation breaks; amounts differ by a pesewa between screens, DB and Paystack. | Integer pesewas (or `Prisma.Decimal`) end to end; one rounding rule (per line, half-up, 2 dp); round once per component; all money columns `Decimal(12,2)`. |
| MONEY-07 | Low | Business logic | "Revenue" in analytics sums `totalAmount` of every non-cancelled, non-deleted order, including unpaid PENDING online orders, and includes VAT/levies and shipping; values are affected by `finalizeOrder` rewrites. | `analytics.service.ts:18-34, 110-131` | Confirmed by reading | Overstated revenue and AOV in admin dashboards. | Report on captured payments; split net sales, tax, shipping, discounts using the snapshot columns. Analytics report owns the details. |
| MONEY-08 | Info | — | Paystack subunit conversion `Math.round(amount * 100)` on a `Decimal(10,2)` value is safe (probe: 4.35, 1.15, 19.99, 8.95 all round to the right integer). Refund conversion is the same. Keep it, but compute from Decimal (`totalAmount.mul(100).toNumber()`) once money moves to Decimal. | `payment.service.ts:281-283`; `returns.service.ts:137` | Confirmed by computation | None today. | Optional hardening. |
| MONEY-09 | Low | Concurrency | Line prices are read before the order transaction (`checkProductAvailability`) and not re-read inside it; an admin price change (or a tax re-price) between read and commit is not reflected. Product `isActive`/`status` are not checked at order time. | `order.service.ts:316-339, 362-390` | Confirmed by reading | Small window of stale-price orders; archived/draft products orderable (order module report owns the status check). | Read price and status inside the transaction (`SELECT … FOR UPDATE` together with the stock decrement). |

## 6. Severity summary (all money findings)

| Severity | IDs |
|---|---|
| Critical | DISC-01, MONEY-01 |
| High | DISC-02, CPN-01, TAX-01, TAX-02 (suspected), TAX-03, CUR-01, CUR-02, MONEY-02, MONEY-04 |
| Medium | DISC-03, DISC-04, DISC-05, DISC-06, DISC-07, DISC-11, CPN-02, CPN-03, CPN-04, CPN-06, CPN-11, TAX-04, TAX-05, TAX-06, TAX-08, TAX-09, CUR-03, MONEY-03, MONEY-05, MONEY-06 |
| Low / Info | DISC-08, DISC-09, DISC-10, DISC-12, CPN-05, CPN-07, CPN-08, CPN-09, CPN-10, TAX-07, TAX-10, CUR-04, CUR-05, CUR-06, MONEY-07, MONEY-08, MONEY-09 |

## 7. Probes used (scratch, not committed)

Run from the repo root with `TS_NODE_TRANSPILE_ONLY=1 node -r ts-node/register <probe>.js` (files deleted afterwards; to recreate, `require` `src/discount/discount.service` / `src/coupons/coupons.service` and construct them with plain-object fake repositories returning the fixtures named in each finding); they instantiate the real `DiscountService`/`CouponsService` with in-memory fake repositories. Outputs quoted in the module reports (DISC-01..05, CPN-01/03/04/05). Rounding comparisons were computed in Node with `Prisma.Decimal` emulating Postgres numeric rounding. No database was touched.
