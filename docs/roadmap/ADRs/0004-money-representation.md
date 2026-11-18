# ADR-0004 — Money representation

Status: **Accepted** (Emmanuel, 2026-11-18) · Date: 2026-11-16

## Context
- **Mixed column types.** Money is stored as Prisma `Decimal`, sometimes without precision (`Order.discountTotal`, `Order.totalWithOutDiscount`, `Discount.value` default to `DECIMAL(65,30)`).
- **Floating-point arithmetic.** Values are converted to JS `number` and summed in floating point (`order.service.ts:341-343`, `discount.service.ts:300-322`, `currency.service.ts`).
- **Currency ignored.** Checkout ignores currency (CUR-02). FX rates are hard-coded.
- **Float on the wire.** GraphQL exposes money as `Float` (`schema.gql:433,863,884,925`).
- **Paystack conversion.** Amounts sent to Paystack are computed with `Math.round(amount * 100)`.
- **Tax rounding.** Ghana tax is computed per component and rounded (ADR-0006). Prices are entered tax-inclusive, so the net is back-calculated (100 / 1.20).

## Options

| | 1. `Decimal` (Postgres numeric) behind a `Money` type | 2. Integer minor units (`BigInt` pesewas) |
|---|---|---|
| Existing data | Already Decimal: widen precision only, no value conversion | Every column ×100; a missed /100 is a 100× error |
| Rates, units of measure, inclusive-tax back-calculation | Natural | Needs a decimal library for intermediates anyway |
| JS safety | Must ban `Number()` on money; Prisma returns `Decimal` objects | Prisma `BigInt` → JS `bigint`, awkward in JSON/GraphQL |
| Paystack | `amount.mul(100)` in the adapter | Native |

## Recommendation
**Option 1**, the gap analysis's recommendation (`_work/gap-analysis.md` D7a). The orchestrator's first draft proposed option 2. It was dropped because the data is already Decimal, and back-calculating tax-inclusive prices needs decimals anyway.
- **Columns:** `Decimal(14,2)` for money, `Decimal(9,6)` for rates, `Decimal(12,3)` for quantities (weighable goods). Every money column sits next to a `currency` char(3) (on the order or price-list level, not per field).
- **`Money` value object (pure, no I/O)** over `Prisma.Decimal`: `add`, `subtract`, `times(qty)`, `applyRate(rate, rounding)`, and `allocate(parts)` with largest-remainder allocation, so order-level discounts and taxes split exactly across lines. One documented rounding rule: default half-up, per component, per line. A tax adviser must confirm it (GRA's rule is not verified).
- **Lint/architecture test** banning `Number(`, `parseFloat`, `+`, `*` on money-typed values in the pricing, tax, checkout, payment and refund paths.
- **GraphQL wire type:** `Money { amount: String!, currency: Currency! }` replaces `Float`. This breaks every frontend, so it ships once, in Phase 1, with a deprecation window.
- **FX:** `ExchangeRate(base, quote, rate, source, fetchedAt)`, refreshed by a job, used for display only. The settlement currency is the store currency (GHS), and orders store `currency` and the FX rate used.

## Reversibility
The stored meaning and the GraphQL wire format are very expensive to change after real orders exist. Decide before Phase 1.
