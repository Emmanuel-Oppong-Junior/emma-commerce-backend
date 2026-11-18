# ADR-0002 — Catalogue attribute model for multiple verticals

Status: **Accepted** (Emmanuel, 2026-11-18) · Date: 2026-11-16

## Context
`Variant` hard-codes `size` and `color` (`prisma/schema.prisma:133-153`); `Product` carries `expiryDate`, `deliveryOptions`, `selectedDeliveryRegions` as one-off columns. Pharmacy needs prescription flags and dosage forms; electronics needs IMEI/warranty/condition; furniture needs dimensions/weight/lead time; food needs unit-of-measure, storage conditions, expiry/batch; digital goods need entitlements and no shipping. Filters/facets must be driven by attributes (prompt §3.1, §3.6).

## Options
1. **Typed extension tables per vertical** (`PharmacyProductDetails`, `ElectronicsDetails`, …). Strong typing and constraints, but every new vertical needs a migration, and generic faceting is hard.
2. **EAV** (`AttributeDefinition`, `AttributeValue(productId, attributeId, valueText/valueNumber/...)`). Infinitely flexible and filterable with indexes, but queries are verbose and slow at scale, validation lives in app code, and Prisma ergonomics are poor.
3. **Product types + attribute definitions + JSONB values** — `ProductType` (e.g. "Phone", "Medicine", "Apparel") owns `AttributeDefinition[]` (key, label, data type, unit, required, allowed values, `isVariantAxis`, `isFilterable`). `Product.attributes JSONB` and `Sku.optionValues JSONB` are validated against the type's definitions in the service layer. GIN indexes plus generated columns cover the hot filters.
4. **Hybrid of 3 + a few first-class capability columns** for fields that drive business rules (not just display): `requiresPrescription`, `isPerishable`/`shelfLifeDays`, `trackLots`, `trackSerials`, `fulfilmentKind` (PHYSICAL/DIGITAL/SERVICE), `weightGrams`, dimensions, `unitOfMeasure`.

## Recommendation
**Option 4.** Display and filter attributes go in validated JSONB, governed by `ProductType`/`AttributeDefinition`. Capabilities that the checkout, inventory, tax, delivery or compliance code must branch on stay as typed columns or typed config, so they get DB constraints and are hard to get wrong.
- Variant axes come from `AttributeDefinition.isVariantAxis` (size × colour × material; storage × colour), so a SKU's `optionValues` is a validated map, not `size`/`color` columns.
- Faceting: Postgres JSONB GIN plus materialised `ProductFacet` rows refreshed on write if needed; a search engine indexes the same document later (ADR-0010).
- Verticals are enabled per store as "vertical packs": seed `ProductType`s and attribute sets, plus feature flags that enable capability logic (ADR-0001 settings).

## Consequences
- The schema-reviewer's option A (`01-database-schema-review.md` §11.1) is compatible with this. This ADR adds the capability-column rule.
- Attribute validation must be one pure, well-tested module (no I/O), used by admin create/update and bulk import.

## Reversibility
Moving JSONB attributes into typed tables later is a mechanical migration (moderate). Choosing EAV and leaving it later is expensive. Capability columns are cheap to add.
