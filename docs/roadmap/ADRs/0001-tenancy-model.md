# ADR-0001 — Tenancy model

Status: **Proposed** · Date: 2026-11-16 · Decision owner: Emmanuel

## Context
The schema has no notion of a store, tenant or seller. Every table is global: one catalogue, one Paystack key in env, and one admin population. The target (prompt §3, §3.8) must be able to power any Ghanaian store type, possibly many stores, possibly a marketplace. This choice shapes every table, every query, authorization, payments (who is merchant of record) and hosting.

Ghana-specific constraints (`docs/audit/_work/ghana-research.md`, needs legal confirmation):
- **Bank of Ghana Notice BG/GOV/SEC/2026/43:** payment service providers may not hold merchant funds. A platform that collects for many merchants is drifting into regulated territory.
- **Pharmacy Council e-pharmacy policy:** pharmacy data must be stored and processed locally.
- **Data controller registration:** each client is a data controller and registers with the Data Protection Commission.

## Options

| | A. Silo: one deployment per client | B. Pooled multi-tenant SaaS (`storeId` + enforcement/RLS) | C. Multi-vendor marketplace | D. Silo now, pooled later |
|---|---|---|---|---|
| Schema | Today's schema + a `Store` settings row | `storeId` on ~22 tables, composite uniques, RLS or enforced repository scoping, per-transaction `SET LOCAL` | B + `Seller`, sub-orders, commissions, payouts, disputes | As A, plus global IDs and per-store counters so a later merge is scripted |
| Payments | Client's own Paystack account; client is merchant of record | Per-store keys (encrypted) or platform account with subaccounts | Platform collects and splits: BoG/PSP licensing question | As A |
| Hosting | Per client (pharmacy client in Ghana) | One location for all tenants | One location | As A |
| Main risk | Ops cost per deployment (needs CI/CD + IaC before client #2) | Cross-tenant leak (SEC-01 shows field-level authz is weak today) | Legal + financial-flow complexity | Same as A |
| Time to first client | Shortest | +4–8 weeks, and must precede the Phase 1 refactor | +3–6 months, after legal sign-off | Shortest |

## Recommendation
**D: silo per deployment now, kept pool-ready. No marketplace without legal sign-off.**
- Add a `Store` row holding legal name, TIN, VAT status, `pricesIncludeTax`, currency, enabled verticals/feature flags, an order-number counter and encrypted provider config. Move per-store configuration from env into it.
- Keep globally unique `cuid()` IDs. Business keys such as order numbers come from the per-store counter, never from a global sequence. This keeps a later merge into a pooled database mechanical.
- Staff and customer identities are per deployment.
- **Revisit trigger:** about 10 live clients, or when per-deployment ops cost exceeds roughly one engineer-week a month. Revisit sooner if a marketplace becomes a 12-month goal: then say so now, because order splitting and payouts touch the core order model.

### Alternative considered (orchestrator's first draft)
Add a non-null `storeId` to tenant-owned tables now (defaulting to one store), without RLS. **Rejected for now.** Unenforced scope columns give false safety and cost a column plus composite uniques everywhere, while giving no isolation guarantee until enforcement exists. If option B is chosen, do it properly (`storeId` + RLS + tests) **before** the Phase 1 schema refactor, so the refactor isn't done twice.

## Consequences
- Phase 1 needs deployment automation (IaC, a per-client migration job in CD) before client #2.
- Migrations fan out per client database. Releases must reach every deployment within a bounded window.

## Reversibility
Silo to pooled costs one migration project, and is feasible because the IDs are global. Pooled to silo leaves dead complexity. Marketplace is the costliest to retrofit.
