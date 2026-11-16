# ADR-0012 — API surface and field-level authorization

Status: **Proposed** · Date: 2026-11-16

## Context
GraphQL is the only application API. REST exists for upload, health and the Paystack webhook, and is entirely broken today (PLAT-01, IAM-07). Field resolvers run without guards, so a public `product` query exposes customer PII through `reviews.user` (SEC-01). There are no depth or complexity limits on a cyclic schema (PLAT-05/PERF-01). Error codes are flattened to `BAD_USER_INPUT` (DOC-06). There are no subscriptions.

## Recommendation
1. **Keep GraphQL as the API for first-party apps** (storefront, admin, mobile).
2. **REST for machine integrations only:** `/webhooks/*` (raw body), health/readiness, upload signing, and `/integrations/v1/*` with API keys and generated OpenAPI. Add an integration endpoint only when a real integration needs it: courier callbacks, POS/ERP stock sync, or a link to the national e-pharmacy platform. **Do not publish a speculative public API**; once external parties depend on it, it must be versioned forever (SUMMARY decision 5).
3. **Execution-context-aware infrastructure:** guards, interceptors and `@ActiveUser` must handle `http` and `graphql` contexts (one `getRequest(context)` helper). A test boots the app and hits every REST route.
4. **Field-level authorization by design, not by enabling global field guards** (that would mean one DB lookup per field):
   - Public types never expose `User`. `Review.author` returns a `PublicProfile { displayName, avatarUrl }`.
   - Sensitive fields (`User.email`, `User.addresses`, `User.orders`, `Order.user`, cost price) use a cheap `@FieldAuth(policy)` decorator. It reads the already-authenticated `req.user` from context and checks owner-or-permission, with no DB call.
   - A schema test fails the build if a type reachable from an `@Auth(None)` root exposes a field tagged `@Sensitive` without a policy.
5. **Hardening:** query depth limit (around 8), cost/complexity limit (`graphql-query-complexity`), alias and batch limits, landing page and introspection off in production, persisted queries for anonymous traffic (also enables CDN caching).
6. **Errors:** standard codes (`UNAUTHENTICATED`, `FORBIDDEN`, `NOT_FOUND`, `CONFLICT`, `BAD_USER_INPUT`, `INTERNAL`) plus a stable business `reason` (e.g. `OUT_OF_STOCK`, `COUPON_EXHAUSTED`). Map Prisma P2002/P2003/P2025 to these.
7. **Real-time order tracking:** not now. SMS milestones plus polling are more reliable on Ghanaian mobile data. Revisit with live rider tracking, where server-sent events (SSE) are simpler than `graphql-ws` (gap analysis D5).
8. **Schema evolution:** `schema.gql` is committed and CI checks it for breaking changes (`graphql-inspector`). Fields are deprecated before removal.

## Reversibility
Moderate.
