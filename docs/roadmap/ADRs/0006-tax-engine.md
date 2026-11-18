# ADR-0006 — Tax engine

Status: **Accepted** (Emmanuel, 2026-11-18; building P2-T waits for the Ghanaian tax adviser sign-off) · Date: 2026-11-16 · Needs confirmation from a Ghanaian tax adviser before implementation

## Context
Today `Tax{name, rate, isActive}` rows are summed into a multiplier. `Product.price` is then rewritten by a raw SQL update whenever a rate changes (`tax.service.ts:55-63`). The update probably fails, and it runs after the Tax row is saved (TAX-02, suspected). Product edits can silently drop tax (TAX-01). Orders store no tax at all, so VAT cannot be invoiced or reported (TAX-03 / DB-04).

The research notes (`docs/audit/_work/ghana-research.md`, sourced, needs adviser sign-off) give the structure in force from 2026-01-01 (Act 1151):
- **VAT** 15%, **NHIL** 2.5% and **GETFund** 2.5%, all charged on the same net value, with no compounding.
- The COVID-19 levy has been abolished.
- NHIL and GETFund are input-deductible.
- Worked example: GHS 100.00 net → 15.00 + 2.50 + 2.50 = GHS 120.00.

Exempt and zero-rated supplies are relevant to this platform (certain medicines, unprocessed food, books). GRA's rounding rule is not confirmed, and a 2026 VAT (Amendment) Act exists whose contents are not fully confirmed.

## Recommendation
- Model **tax components** (`TaxComponent { code: VAT|NHIL|GETFUND|..., rate Decimal, base: NET|NET_PLUS_COMPONENTS[...], creditable: bool, effectiveFrom, effectiveTo, jurisdiction }`). Compounding is a data choice: today every component's base is NET.
- **Tax classes** per SKU/product type (`STANDARD`, `EXEMPT`, `ZERO_RATED`, plus custom). Each `(jurisdiction, taxClass)` maps to a set of components.
- **Store setting `pricesIncludeTax`.** Ghanaian retail usually displays tax-inclusive prices, and Act 772 requires all-in price disclosure. With inclusive pricing, derive the net as the remainder after the rounded components, so the lines foot to the shelf price.
- **Tax is computed by the pricing engine** (ADR-0005): per line, per component, rounded per component (default half-up, to be confirmed), on the post-discount amount. Whether shipping is taxable is a configuration setting.
- **Snapshot** an `OrderTaxLine(orderLineId?, component, rate, base, amount)` on every order. Refunds and credit notes reverse the stored lines and never recompute them.
- **Stop rewriting `Product.price`** when rates change. The list price is stored once, and tax is computed at quote time.
- Plan for GRA E-VAT invoice integration as a later epic. The ROADMAP flags it as a regulatory dependency.

## Reversibility
Moderate. The snapshot lines are the irreversible part, and they are the correct default.
