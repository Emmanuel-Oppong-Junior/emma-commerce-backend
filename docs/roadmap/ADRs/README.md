# Architecture Decision Records

All 17 ADRs are **Accepted** (0007 on 2026-11-17, the rest on 2026-11-18). ADR-0006 implementation waits for a Ghanaian tax adviser; ADR-0016 pharmacy deployments wait for legal sign-off. New ADRs start **Proposed**; once Emmanuel approves one, change its status line to `Accepted (YYYY-MM-DD)`. Superseded ADRs keep their file and get `Superseded by ADR-NNNN`.

| ADR | Decision | Reversibility | Needed before |
|---|---|---|---|
| [0001](0001-tenancy-model.md) | Tenancy: one deployment per client now (pool-ready: global IDs, `Store` row); marketplace only after legal sign-off | Expensive | Before Phase 1 |
| [0002](0002-catalogue-attribute-model.md) | Product types + typed attribute definitions stored as validated JSONB | Expensive | Phase 1 schema refactor |
| [0003](0003-sellable-unit-sku.md) | Every purchasable thing is a SKU (variant); products without options get one default SKU | Expensive | Phase 1 schema refactor |
| [0004](0004-money-representation.md) | Money as `Decimal(14,2)` behind a `Money` value object; GraphQL `Money` string type replaces `Float` | Very expensive | Phase 1 |
| [0005](0005-pricing-and-promotions-engine.md) | Pure pricing engine, explicit stacking rules, server-side quote → order snapshot | Moderate | Phase 2 |
| [0006](0006-tax-engine.md) | Component-based, effective-dated tax engine modelled on Ghana VAT/NHIL/GETFund | Moderate | Phase 2 |
| [0007](0007-payment-provider-abstraction.md) | Provider port + payment-attempt ledger + idempotent webhook inbox; Paystack first | Moderate | Phase 0 (ledger shape), Phase 3 (second provider) |
| [0008](0008-inventory-model.md) | Stock per SKU per location, reservations with expiry, append-only ledger, optional lots/serials | Expensive | Phase 1/4 |
| [0009](0009-jobs-events-outbox.md) | BullMQ on Redis + transactional outbox for domain events | Moderate | Phase 1 |
| [0010](0010-search-engine.md) | Postgres FTS + trigram now behind a search port; Meilisearch when facets/typo tolerance needed | Cheap | Phase 6 |
| [0011](0011-caching-and-redis.md) | Redis is required infrastructure in production; no silent in-memory fallback | Cheap | Phase 1 |
| [0012](0012-api-surface.md) | GraphQL for apps + REST for webhooks/integrations; explicit field-level authorization | Moderate | Phase 0 (authz), Phase 7 (public REST) |
| [0013](0013-authorization-rbac.md) | Permission-based RBAC (roles = bundles of permissions), scoped to store/location | Moderate | Phase 1 |
| [0014](0014-order-state-machine.md) | Explicit order/payment/fulfilment state machines with guarded, conditional transitions | Moderate | Phase 0 |
| [0015](0015-notifications.md) | Notification service with templates, preferences and channels (email, SMS, WhatsApp, in-app) on the job queue | Cheap | Phase 1/5 |
| [0016](0016-hosting-and-data-residency.md) | Hosting region per client deployment; pharmacy data hosted in Ghana | Expensive | Before launch |
| [0017](0017-prisma-upgrade-and-migration-baseline.md) | Upgrade to Prisma 7 right after Phase 0 and re-baseline migrations once (done: P1-P.1/P.2) | Moderate | Phase 1 start |
