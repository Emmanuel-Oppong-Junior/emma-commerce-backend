# 03 — Performance & Scalability Review

> **Orchestrator note (final):** I re-verified PERF-01 (same root cause as SEC-01; repro test on `audit/repro-tests`), PERF-02 and PERF-03 (`schema.prisma:359,372`) and PERF-18 (the build emits `dist/src/main.js`, not `dist/main.js`, so `node dist/main` cannot start). PERF-05 overlaps ORD-01/ORD-03 (repro tests). Every latency and throughput figure is a **proposed target, not a measurement**. Index claims need `EXPLAIN (ANALYZE, BUFFERS)` at realistic data volume before any migration is written.

Reviewer: Quality & Performance agent (Sonnet, high). Date: 2026-11-16. Scope: whole backend, cross-cutting. Module-level defects belong to the module reports; items here are the ones that change latency, throughput, cost or the ability to run more than one instance.

**Evidence rules.** Every finding cites `path:line` and one of: *Confirmed by reading* (full path traced, no runtime check), *Confirmed by test* (a test I ran), or *Suspected (needs verification)*. **No performance measurement exists for this system and I ran none** (the brief forbids anything touching a database). Query counts below are derived by reading the code; latency numbers in section 7 are *proposed targets*, not observations. Nothing here has been measured against Postgres, so every index claim needs an `EXPLAIN (ANALYZE, BUFFERS)` check at realistic volume before the migration is written.

---

## 1. Summary

The data-access layer is *request-scoped DataLoaders for 9 field resolvers* plus *Prisma `select` built from the GraphQL selection* for products. That is a sound base and the loaders are scoped correctly. The performance risk is not in the loaders; it is in five places:

1. **The GraphQL surface has no protection at all** (no depth, complexity, alias or cost limits) and the schema is cyclic with a public path into `User` (`products → reviews → user → orders → …`). One anonymous query can fan out exponentially and also reads reviewer PII. This is both a DoS and a privacy defect (PERF-01).
2. **Missing indexes on the two hottest write/read paths:** no index leading with `OrderItem.orderId` (every order read), none on `Payment.transactionId` (every webhook) (PERF-02, PERF-03).
3. **Checkout is serial and holds a pooled connection for the whole transaction**, with default Prisma pool size (2×cores+1) and default 5 s transaction timeout. Throughput is bounded by connection hold time, which is dominated by DB round-trip latency (PERF-04, PERF-16).
4. **Nothing is safe to run on two instances**: in-process crons restore stock without a status guard, throttler and cache fall back to per-process memory, logs go to local disk, and the Docker `CMD` points at a file the build does not produce (PERF-05, 12, 11, 17, 18).
5. **External calls have no timeouts and run on the request path** (Paystack via the abandoned `request` library; Paystack verification done synchronously inside the webhook; sharp image processing on the event loop's thread pool) (PERF-06, 15).

For a Ghana SME launch (tens of concurrent users, a handful of orders per hour) items 1 to 3 are survivable *except* PERF-01, which is exploitable at any scale. At 10x (flash sale, 100–300 orders/hour, 5–10 checkouts/second on a few hot SKUs), PERF-02, 03, 04, 05, 16 become incidents.

Top issues by priority are listed at the end of the message that accompanied this file; the full register is section 2.

---

## 2. Finding register

Severity is about the effect at the *10x* target unless noted. IDs are PERF-NN.

| ID | Sev | Category | Finding | Evidence | Confirmation | Business impact | Fix |
|---|---|---|---|---|---|---|---|
| PERF-01 | **Critical** | Performance / Security | No depth, complexity, alias or cost limits. Schema is cyclic (`Product.reviews → Review.product → Product…`, `Review.user → User.orders → Order.user → User…`). Public `products` query (`@Auth(AuthType.None)`) can walk `reviews → user → { email phoneNumber addresses orders }`. Guards/interceptors do not run on `@ResolveField` resolvers (no `fieldResolverEnhancers` configured), so `Review.user`, `User.addresses`, `User.orders` have no auth of their own. | `src/app.module.ts:91-103` (no `validationRules`/plugins besides landing page); `src/products/products.resolver.ts:89-105,121-124`; `src/review/review.resolver.ts:88-91`; `src/users/users.resolver.ts:122-130`; `schema.gql` `type Review.user: User!`, `type User.orders/addresses`; `grep fieldResolverEnhancers src` → none; `package.json` has no `graphql-depth-limit`/`graphql-query-complexity`. | Confirmed by reading (framework default for field resolvers; not exercised at runtime — **orchestrator should verify with an anonymous query against the e2e app**). | Anonymous attacker takes the API down with one nested query (response size grows as R^depth) and/or scrapes customer emails, phone numbers, addresses and order history. Legal exposure under Data Protection Act 843. | (a) Add depth limit (≤8) + cost/complexity limit via Apollo `validationRules`; cap list fields. (b) Put `@Roles`/ownership checks in the field resolvers or return only `{id,name}` from `Review.user`; do not expose `User` through `Review`. (c) Consider `fieldResolverEnhancers: ['guards']`. Route (b) to Security agent. **Status: Fixed in c3000bf (P0-A.4): depth ≤ 8 and aliases ≤ 15 validation rules plus a `graphql-query-complexity` cost limit of 3000 (`src/commons/graphql/query-limits.ts`), introspection exempt; landing page off in production; unit + e2e. Field-level auth part closed in P0-A.2.** |
| PERF-02 | **High** | Performance (index) | No index with leading column `OrderItem.orderId`. Only `(productId, orderId)`, `(variantId)`, `(discountId)`. Every `include: { items }` filters `OrderItem` by `orderId` and cannot use the composite (leading column is `productId`). Postgres does not auto-index FKs. | `prisma/schema.prisma:359-361`; `prisma/migrations/20260412120208_first_migration/migration.sql:565-571`; consumers `src/order/order.repository.ts:21-41,61-78,100-120,165-177`, `src/users/loaders/orders.loader.ts:20-24`, `src/discount/discount.repository.ts` `findOrderById`. | Confirmed by reading (schema + migration). Seq-scan cost needs EXPLAIN. | Order list/detail/cancel/expiry degrade linearly with order history; at 500k order-items an order read becomes a full scan. Customer "my orders" page and admin order list are the slowest pages in the store. | `@@index([orderId])` on `OrderItem` (can replace `(productId, orderId)` if analytics doesn't need it; analytics joins by `orderId` too — `analytics.service.ts:50-53`). |
| PERF-03 | **High** | Performance (index) | `Payment.transactionId` (the Paystack reference) is unindexed and not unique; every webhook and `verifyPayment` does `findFirst({ where: { transactionId } })`. | `prisma/schema.prisma:364-378`; `src/payment/payment.repository.ts:20-24`; used at `payment.service.ts:68-73,335-339`. | Confirmed by reading. | Webhook latency grows with payment count; Paystack retries on slow ack; two payments with the same reference are possible. | `@@unique([transactionId])` (nullable unique is fine in Postgres) and `@@index([status])`. |
| PERF-04 | **High** | Performance / Concurrency | Checkout reads are serial N+1: one `findUnique(product)` per cart item sequentially (up to 50). Inside the transaction, per item: `UPDATE product … decrement` then `INSERT inventoryLog`, serial, then order+items insert, coupon usage, cart clear. No isolation level or timeout options set (Prisma defaults: Read Committed, `maxWait` 2 s, `timeout` 5 s). Product rows are locked in *cart order*, not sorted — two concurrent checkouts with overlapping products in different order can deadlock (Postgres aborts one, Prisma surfaces `P2034`; no retry). | `src/order/order.service.ts:316-339` (serial reads), `:345-391` (tx), `src/order/order.repository.ts:131-143,157-159`; no `$transaction(..., {…})` options anywhere (`grep isolationLevel\|maxWait src` → none). | Confirmed by reading (deadlock: Suspected — needs a 2-client test). | Derived query count: N=3 items ≈ 25 queries total, ≈ 14 inside the tx; N=50 ≈ 215 total, ≈ 108 inside the tx. At 5 ms RTT a 50-item tx holds a connection and 50 product row locks ≈ 0.5 s; at 150 ms RTT (app and DB on different continents) the same tx needs ≈ 16 s and **fails at Prisma's 5 s timeout**. Hot-SKU flash sales serialise on one row. | Batch the pre-checks (`findMany where id in`), sort items by `productId` before locking, make the decrement conditional (`UPDATE … SET quantity = quantity - $n WHERE id = $id AND quantity >= $n`) and drop the post-hoc negative check, batch inventory-log inserts with `createMany`, set explicit `{ maxWait, timeout }`, retry on `P2034`. Co-locate app and DB in one region. |
| PERF-05 | **High** | Scaling / Data integrity | Crons run in every process (`@nestjs/schedule`, no lock). `expireAbandonedOrders` loads all expired orders, then per order restores stock in a tx **without re-checking status**; two instances (or a cron overlapping a user cancel / admin cancel) restore the same stock twice. The same unguarded pattern exists in `cancelOrder`/`adminCancelOrder`/`deleteOrder` (status read outside the tx, unconditional `updateStatus`). | `src/order/tasks/expired-orders.task.ts:15-29`; `src/order/order.service.ts:150-157,193-199,204-217,234-244,407-423,437-444`; `src/order/order.repository.ts:100-113,165-177`; `src/inventory/tasks/low-stock.task.ts:13-39`. | Confirmed by reading. | Phantom stock (inventory inflated by every duplicate restore) → overselling later; double-click on "Cancel order" does the same on a single instance. | Make state transitions conditional (`updateMany where {id, status in (…)}` and restore stock only if `count===1`, inside one tx); run crons on one leader (`pg_try_advisory_lock`, or a separate worker/BullMQ repeatable job). Batch (`take`) the expiry scan. Owner: Order agent for the fix, listed here as a scaling blocker. |
| PERF-06 | **High** | Performance / Reliability | Paystack calls have no timeout: `paystack-api` uses `request-promise` and `index.js` sets none. `initiatePayment` awaits Paystack on the request path (fine for locks — it is outside any DB tx — but unbounded in time). The webhook does the verification **synchronously** (`verifyPayment` → Paystack HTTP → DB) and the controller **discards the result**: any failure still returns HTTP 200, so Paystack will not retry and the payment stays `PENDING`. | `node_modules/paystack-api/index.js:6,114-130` (no `timeout`); `src/payment/payment.service.ts:41-60,165-200,341-345,365-375`; `src/payment/payment.controller.ts:21-29`. | Confirmed by reading. | Slow Paystack = threads/sockets pile up, webhook p95 ≈ Paystack latency; a transient Paystack blip silently loses a paid order's confirmation (customer paid, order stays PENDING and, because a Payment row exists, `order.repository.ts:165-177` only expires orders with `payment: { is: null }`, so an order that has a `PENDING` Payment row is never expired and its stock stays reserved forever). | Wrap Paystack in a client with 5–8 s timeout + 1 retry on idempotent calls (replace `paystack-api` with `fetch`/`axios`). Webhook: verify signature on the raw body, persist the event row, respond 200, process async/idempotently; return non-2xx on processing failure so Paystack retries. Payment agent owns details. |
| PERF-07 | **High** | Performance (unbounded) | `findMany` with no `take` on tables that grow without bound, exposed through GraphQL list queries (see section 4 for the full list). Worst offenders: `InventoryLog` (a row per item per order *forever*), `Order.findAll` (admin, includes `items.product`, no `orderBy`), `Payment.findAll/findByUser` (include `order`), `OrdersLoader` (all orders + items + products per user), `ReviewsLoader`, `VariantsLoader`. | `src/inventory/inventory.repository.ts:23-41`; `src/order/order.repository.ts:28-41`; `src/payment/payment.repository.ts:30-43`; `src/users/loaders/orders.loader.ts:20-24`; `src/products/loaders/reviews.loader.ts:18-21`; `src/addresses/addresses.repository.ts:32`; `src/returns/returns.repository.ts:18-29`; `src/review/review.repository.ts:42-55`; `src/coupons/coupons.repository.ts:29`; `src/discount/discount.repository.ts:29`. | Confirmed by reading. | Admin dashboard timeouts and Node heap spikes once there are tens of thousands of rows; a single admin "all orders" click can allocate hundreds of MB. | Cursor pagination (reuse `PaginationArgs`/`PageInfo`, already used for products/users) on every list that is not a small config table; `take` caps in loaders (`reviews` top-N per product via window query or a separate paginated field). |
| PERF-08 | Medium | Performance | Product list (the hottest query): (a) `count()` runs on every request even when `totalCount` isn't selected; (b) default sort `createdAt DESC` has no index; (c) `search` builds `to_tsvector`/`to_tsquery` on `name` and `description` with no GIN index, plus `tags.some.name ILIKE '%…%'` which cannot use the unique btree; (d) category/brand/tag name filters use `mode: insensitive` (ILIKE/LOWER) so the unique indexes don't apply; (e) search string is joined with `' & '` without escaping — `to_tsquery` syntax errors on input like `foo!` or `a'b` (Suspected: surfaces as a 500). | `src/products/products.service.ts:75-83,183-227`; `prisma/schema.prisma:204-208`; `prisma/schema.prisma:9` (`fullTextSearchPostgres`); no GIN index in `prisma/migrations/**` (`grep -i gin` → none). | (a)(b)(c)(d) Confirmed by reading; (e) Suspected. | List and search latency scale with catalogue size; for a few thousand SKUs it is fine, for 50k+ it is a seq scan + sort per page view. | Only run `count` when `totalCount` is selected (or cache it per filter for 30–60 s); add `@@index([createdAt(sort: Desc)])`, `(isActive, createdAt)`; add expression GIN index(es) matching the SQL Prisma generates (capture via `log: ['query']`) and `pg_trgm` for tag/name contains; use `plainto_tsquery`-style input (escape or use `websearch` mode). |
| PERF-09 | Medium | Performance (N+1) | `Product.appliedDiscount` calls `discountService.findOneDiscount(id)` once per product (not batched; cache-mitigated only when warm — and the cache has no TTL control, see PERF-11). `Product.discountedPrice` and `appliedDiscount` both call the same loader with `cache: false`, so one product is requested twice per batch; the loader maps results with `products.find()` inside `ids.map` (O(n²)). | `src/products/products.resolver.ts:126-137`; `src/products/loaders/discount.loader.ts:66-68,80`; `src/discount/discount.service.ts:106-113`. | Confirmed by reading. | A 100-product page with discounts = up to 100 extra cache/DB reads; trivial CPU waste at n=100. | Resolve `appliedDiscount` inside the same loader (return the discount object, not only the id) or add a `DiscountByIdLoader`; use a `Map` in the loader. |
| PERF-10 | Medium | Performance / API | `cartWithDiscount` is a *query* that issues an `UPDATE` per cart item and several `SELECT`s per item (`getDiscountedPriceForProduct` → product+category/variant discounts) — N+1 plus writes in a read path; `finalizeOrder` does the same for order items. | `src/cart/cart.resolver.ts:58-62`; `src/discount/discount.service.ts:191-198,300-322,324-341,360-383`; `src/discount/discount.repository.ts` `updateCartItem/updateOrderItem`. | Confirmed by reading. | For a 20-item cart ≈ 80–120 queries per cart view, and every cart view writes rows (WAL, row bloat, lock contention with the checkout tx that deletes the same cart items). | Compute totals in memory with one batched discount read; persist only at checkout. Rename or turn into a mutation if it must write. |
| PERF-11 | Medium | Caching | Caching is thin and partly dead: (1) the category cache is only used when the GraphQL selection is empty (`Object.keys(requestedFields).length > 0` bypasses it) — every real query selects fields, so it is **never hit**; (2) only categories and discounts are cached — products, brands, tags, variants, shipping zones, taxes, pickup locations are not; (3) discount cache `findAllDiscounts` stores *every* discount (including inactive/expired) with the 5-min default TTL; (4) invalidation is `del` on the local store — with the in-memory fallback it only clears the local process; (5) values round-trip through Keyv/Redis as JSON (Dates become strings, Prisma `Decimal` becomes a string) — Suspected to change GraphQL serialisation; (6) no `try/catch` around cache calls — Redis outage behaviour is unknown (Suspected: errors propagate into queries); (7) per-user data in shared keys: **none found** (keys are `category:tree`, `discount:all`, `discount:<id>`). | `src/categories/categories.service.ts:10-11,39-54`; `src/categories/categories.resolver.ts:33-38` (level-1 select always non-empty); `src/discount/discount.service.ts:92-113,84,130,147,160`; `src/config/cache.config.ts:9-31`; `src/health/indicators/redis.health-indicator.ts`. | (1)-(4),(7) Confirmed by reading; (5)(6) Suspected. | Zero cache hits on the one cache that was meant to protect the catalogue; stale discounts/prices across instances; a Redis blip could 500 public queries. | Decide what to cache (see section 5), fix key/selection design (cache the full object and project in memory), add `try/catch` fallthrough to DB, add TTL jitter, invalidate by event, and refuse to boot without Redis in production (or log loudly — see PERF-12). |
| PERF-12 | Medium | Scaling / Security | Throttler uses default **in-memory storage** and the default tracker (`req.ip`), not the user — limits are per instance, and comments claiming "per user" (`app.module.ts:81,86`) are wrong. `trust proxy 1` is set. Behind mobile CGNAT (common in Ghana) many unrelated customers share one IP and can exhaust the global 120/min bucket. With N instances the effective limit is N×. Only `global` applies by default; the auth/payment/upload buckets apply only where a route opts in. | `src/app.module.ts:57-88`; `src/commons/guards/gql-throttler.guard.ts:32-107`; `src/main.ts:11`; `package.json` (no throttler Redis storage package). | Confirmed by reading (tracker default per library; CGNAT effect is Suspected for the real network). | Legit customers throttled during a promotion; brute-force limits on login weaker than documented when scaled out. | Redis-backed storage; track by user id when authenticated, by IP otherwise; raise global limit and use per-operation limits; load-test with a shared-IP scenario. |
| PERF-13 | Medium | Performance (over-fetch) | Heavy `include` trees on every call regardless of what the client selected: `include: { items: { include: { product: true } } }` on `findByUser`, `findAll`, `create` (returned), `updateStatus`, `updateShipping`, `softDelete`; `payment.findAll/findByUser/update` include `order`; `cart.findByUser` includes `items.product` (full rows incl. `description Text`, `images[]`, `attachments[]`); `UsersRepository.findWithRelations` loads all addresses and all orders; loaders (`UsersLoader`, `ProductsLoader`) `SELECT *` including `User.password`/reset-token columns. | `src/order/order.repository.ts:28-41,77,90,105,119`; `src/payment/payment.repository.ts:30-43,47`; `src/cart/cart.repository.ts:11-16`; `src/users/users.repository.ts:55-59`; `src/users/loaders/users.loader.ts:18-20`; `src/products/loaders/products.loader.ts:18-20`. | Confirmed by reading. | Wasted DB I/O and memory; a mutation like "update order status" returns and serialises the whole order tree. Password hashes are pulled into memory for every `Review.user` (not exposed by the GraphQL type, but not necessary either). | Reuse the `extractRequestedFieldsFromQuery` approach already used for products, or give loaders explicit `select`s. |
| PERF-14 | Medium | Reliability / Performance | Emails are fire-and-forget (good: off the request path) but: `void repo.findUserById().then(…)` has no `.catch` → a DB error is an unhandled rejection (Node ≥15 crashes the process by default); no queue, no retry, no dedupe — a restart or Resend rate-limit drops the email silently (only a log line); the user is re-fetched from DB per email. | `src/order/order.service.ts:457-470`; `src/notifications/notifications.service.ts:13-55`; `src/notifications/email/email.service.ts:47-62` (swallows errors). | Confirmed by reading. | Process crash under DB trouble; lost order-confirmation/shipping emails with no trace except logs. | Add `.catch`; move emails to a durable outbox/queue (BullMQ on Redis, or an `EmailOutbox` table + worker) with retry/backoff; pass the email address from the already-loaded user. |
| PERF-15 | Medium | Performance / Security | Image processing: `sharp` resizes up to 3 × 5 MB files per request in memory on the libuv pool, `limitInputPixels` not set (default is very high → decompression-bomb memory spike, Suspected), any authenticated user can call it (`@Auth(AuthType.Bearer)`, no role) — 10/min limit is per IP. Output is forced to 500×500 `contain` (product detail images will look soft; Info). On resize failure the original unprocessed buffer is uploaded. | `src/commons/cloudinary.service.ts:26-51`; `src/commons/upload.controller.ts:16-45`. | Confirmed by reading (DoS sizing: Suspected). | CPU/memory exhaustion by any registered customer; Cloudinary bill abuse. | Role-guard upload; set `sharp(buf, { limitInputPixels })`, `sharp.concurrency`, or push resizing to Cloudinary transformations; validate MIME by magic bytes. |
| PERF-16 | Medium | Capacity | Prisma pool is unconfigured: `DATABASE_URL` carries no `connection_limit`/`pool_timeout`; Prisma default is `num_physical_cpus × 2 + 1` (a 2-vCPU container → 5 connections). Every interactive tx pins a connection for its full duration. No PgBouncer config. With N instances the pool multiplies against the Postgres `max_connections`. | `.env.example:8`; `src/prisma/prisma.service.ts:5-13`; `grep connection_limit` → none. | Confirmed by reading (default formula per Prisma docs; verify against the installed engine). | Rough ceiling: 5 connections ÷ (≈15 ms tx for 3 items) ≈ 300 checkouts/s on paper, but any other query shares those 5, and at 5 ms RTT with 10-item carts (≈ 50 ms tx) it falls to ≈ 100/s; `P2024` ("timed out fetching a connection") appears long before CPU saturates. | Set `connection_limit` explicitly per instance (e.g. 10–20) and size `max_connections` for instances × limit + headroom; use PgBouncer (transaction mode) for >2 instances; alert on pool wait. |
| PERF-17 | Medium | Scaling / Ops | Local-disk side effects: Winston `DailyRotateFile` to `logs/` (14 d, 20 MB) + console; `MulterModule.register({ dest: './upload' })` creates a disk dir even though uploads use memory storage; `autoSchemaFile: 'schema.gql'` makes every instance **write** the schema file at boot (breaks on read-only root filesystems; races on a shared volume). Log lines also include full GraphQL variables (only `password`/`confirmPassword` masked) — PII in logs (Suspected for address/phone variables). | `src/commons/logger.service.ts:15-36`; `src/app.module.ts:109-111,100`; `src/commons/interceptors/graphql-logging.interceptor.ts:19-43`. | Confirmed by reading. | Lost logs on container replacement; boot failure on hardened images; PII retained 14 days on disk. | Log to stdout (JSON) only; `autoSchemaFile: true` in production (or `join(process.cwd(),…)` only in dev); drop unused Multer `dest`; mask PII variables. |
| PERF-18 | Medium | Ops / Scaling | **Container cannot start**: `nest build` outputs `dist/src/main.js` (because `prisma/seeders/*.ts` is inside the compilation root, rootDir becomes the repo root), but the Dockerfile `CMD` and `start:prod` run `node dist/main`. Observed in baseline: `dist/` contains `prisma/` and `src/`, no `dist/main.js`. Also the runner stage installs `--omit=dev` and copies `prisma/` but no Prisma CLI, so no migration step is possible in the image. | `Dockerfile` (`CMD ["node", "dist/main"]`), `package.json` `start:prod`, `tsconfig.build.json` (no `include`/`rootDir`), `ls dist` (baseline). | Confirmed by reading + observed build output. | Production deploy from this Dockerfile fails on start. | Set `rootDir: "./src"` + `include: ["src/**/*"]` in `tsconfig.build.json` (or point `CMD` at `dist/src/main`); add a migrate step (`prisma migrate deploy`) to the release process. Owner: Deps & Ops agent; listed because it blocks any load test on the container. **Status: Fixed in a98a123 (P0-O.1): `tsconfig.build.json` excludes prisma/scripts; build emits `dist/main.js`.** |
| PERF-19 | Low | Performance | `TaxService.recomputeAllTaxableProductPrices` is one `UPDATE "Product" … WHERE "isTaxable"` that row-locks every taxable product; it runs on every tax create/update/delete. It contends with checkout's `UPDATE product SET quantity`. | `src/tax/tax.service.ts:21,27,33,55-63`. | Confirmed by reading. | Admin edits a tax rate during trading hours → checkouts block behind a bulk update. | Run off-peak / in batches, or compute tax at read/checkout time instead of stored `price`. |
| PERF-20 | Low | Performance | Admin analytics scan the whole order history on every call, no date bound, no cache: `getTopProducts`, `getRevenueByCategory` join `OrderItem`×`Order`×`Product` (hits PERF-02), dashboard runs 5 queries. | `src/analytics/analytics.service.ts:42-94,101-135`. | Confirmed by reading. | Fine at launch; slow dashboard at 10x and competes with checkout for connections. | Add date range + `LIMIT`, cache 60 s, or move to a read replica / materialised summary. |
| PERF-21 | Low | Performance (write amp.) | Redundant/low-value indexes: `Product @@index([sku])` duplicates the `@unique`; `Coupon @@index([code])` duplicates `@unique`; `RefreshToken @@index([tokenHash])` duplicates `@unique`; `Order @@index([deleted])` is a boolean (near-useless). FKs without index: `Order.shippingAddressId/pickupLocationId/couponId`, `Variant`/`Category.discountId` are indexed, `Review (productId)` OK. Missing composite for admin/user lists: `Order (userId, createdAt)`, `Order (status, createdAt)` (used by the expiry cron), `InventoryLog (productId, createdAt)`, `AuditLog (createdAt)` (table unbounded, no retention). | `prisma/schema.prisma:204,467,55,339,306-341,399-401,516-519`. | Confirmed by reading. | Slower writes (checkout inserts into 4–5 indexed tables); slower lists. | Drop duplicates, add the composites. |
| PERF-22 | Low | Ops | `/health/ready` calls `cloudinary.api.ping()` and Redis on every probe; a Cloudinary outage marks every instance not-ready (nothing to serve, though the API would still work for most operations); probe frequency × external API rate limit. | `src/health/health.controller.ts:31-39`; `src/health/indicators/cloudinary.health-indicator.ts:17-25`. | Confirmed by reading. | Self-inflicted outage during a third-party incident. | Readiness = DB (+Redis if required); keep third parties in a non-gating diagnostic endpoint. |
| PERF-23 | Info | Observability | OpenTelemetry bootstrap (`src/tracing.ts`) is **never imported** (`grep tracing src` outside the file → no hit), so `OTEL_ENABLED=true` does nothing; there are no metrics (no `prom-client`), only logs. You cannot currently see p95 per operation, DB time or pool wait — a prerequisite for any of the targets below. | `src/tracing.ts`; `src/main.ts:1-6`. | Confirmed by reading. | No evidence base for SLOs. | `import './tracing'` as the first line of `main.ts`; add request-duration histogram per GraphQL operation name and Prisma metrics. |

Incidental correctness defects seen while tracing (not performance; route to the module owners): `products.service.ts:213-214` `priceMin`/`priceMax` spread keys overwrite each other (only `lte` survives when both are set); `:201` `subCategoryName` filter compares against `categoryName`; `:216` `inStock` uses `gte: 0` (always true); public `products` returns inactive/archived products unless the client passes `isActive` (`:204`); `products.resolver.ts:126-131` `discountedPrice` returns the discounted price whenever `price` was not in the selection (`Number(undefined)` is `NaN`, `NaN !== x` is true); `extractRequestedFieldsFromQuery` ignores fragment spreads (`useful-functions.ts:104` only handles `kind === 'Field'`) so a fragment-based query gets no relation selects (non-null relation fields would then error); `order.service.ts:323-324` prices come from `Product.price` and ignore variant and cart-time discounts.

---

## 3. N+1 and DataLoader review

### 3.1 Every `@ResolveField` (9 in the codebase)

| Field | Resolver | Mechanism | N+1? | Notes |
|---|---|---|---|---|
| `Order.user` | `src/order/order.resolver.ts:131-134` | `UsersLoader` (batched `findMany id in`) | No | Loads full `User` row (incl. secrets, unused). |
| `Product.variants` | `src/products/products.resolver.ts:116-119` | `VariantsLoader` | No | Unbounded per product. |
| `Product.reviews` | `:121-124` | `ReviewsLoader` | No | Unbounded; **public**, leads to `Review.user` (PERF-01). |
| `Product.discountedPrice` | `:126-131` | `DiscountLoader` (2 queries per batch) | No | `products.find` O(n²) (`discount.loader.ts:67`). |
| `Product.appliedDiscount` | `:133-137` | `discountService.findOneDiscount(id)` per parent | **Yes** | Cache-mitigated only when warm; with Redis each is a network hop. |
| `Review.user` | `src/review/review.resolver.ts:88-91` | `UsersLoader` | No | Exposes full `User` GraphQL type (PERF-01). |
| `Review.product` | `:93-96` | `ProductsLoader` | No | Returns inactive products too (no `isActive` filter). |
| `User.addresses` | `src/users/users.resolver.ts:122-125` | `AddressesLoader` | No | No auth at field level. |
| `User.orders` | `:127-130` | `OrdersLoader` (orders + items + product, unbounded) | No | Heaviest loader; no `take`. |

Relations that are *not* `@ResolveField` (`Order.items`, `OrderItem.product`, `CartItem.product`, `Product.category/brand/tags/subcategory`) are loaded by Prisma `include`/`select` in the parent query: no N+1, but fixed over-fetch (PERF-13). Product list/detail build the Prisma `select` from the GraphQL selection (`extractRequestedFieldsFromQuery`, `useful-functions.ts:83-137`), which is the right idea; known gap: fragments.

### 3.2 Loader scoping — **correct**

All seven loader classes are `@Injectable({ scope: Scope.REQUEST })`, created per request, with the `DataLoader` instance as a field of the request-scoped provider (`products/loaders/*.ts:6-14`, `users/loaders/*.ts:6-14`, `discount.loader.ts:9-17`). There is **no singleton loader**, so no cross-request/cross-user cache and no data leakage between users. The GraphQL `context` function returns a fresh object per operation (`app.module.ts:101`), which is what Nest needs to key request-scoped instances, and Apollo HTTP batching is off by default in Apollo Server 4, so two operations do not share a loader.

Side effects worth knowing (a non-obvious Nest pattern, so one sentence of why: a request-scoped provider makes every consumer request-scoped, so `ProductsResolver`, `OrdersResolver`, `ReviewResolver`, `UsersResolver` are re-instantiated per operation, a small constant cost, typically a few percent of throughput):
- All loaders use `{ cache: false }`. That disables per-request memoisation, so the same key requested twice in one operation is fetched twice inside the batch (e.g. `discountedPrice` + `appliedDiscount`). Keep batching but enable the cache for read-only loaders, or dedupe keys inside the batch function.
- No `maxBatchSize`; a 100-row page produces `IN (100 ids)` which is fine; a loader fed 5,000 ids is not.
- Loader queries have no `take`, so correctness at scale depends on the parent list being bounded.

---

## 4. Unbounded and over-fetching queries (complete list from `grep findMany`)

| Query | File:line | Bounded? | Exposed as | Risk |
|---|---|---|---|---|
| Products list | `products.repository.ts:52-65` | `take` 1..100 (`PaginationArgs @Max(100)`, `paginate.args.ts:8-10`) | public `products` | OK; `count` per call (PERF-08) |
| Users list | `users.repository.ts:62-78` | `first` ≤100 | admin | OK |
| Orders `findAll` | `order.repository.ts:36-41` | **No**, includes items+product, no `orderBy` | admin `orders` | High |
| Orders `findByUser` | `:28-34` | **No** | `userOrders` | Medium (user-bounded) |
| `OrdersLoader` | `users/loaders/orders.loader.ts:20-24` | **No** | `User.orders` | High (PERF-01) |
| Expired orders | `order.repository.ts:165-177` | **No** | cron | Medium |
| `ReviewsLoader` / `VariantsLoader` | `products/loaders/*.ts:18-21` | **No** | `Product.reviews/variants` | Medium |
| Reviews by product/user | `review.repository.ts:42-55` | **No** | queries | Medium |
| Payments `findAll`/`findByUser` | `payment.repository.ts:30-43` | **No** (+ include order) | queries | High |
| Inventory logs all/product/variant | `inventory.repository.ts:23-41` | **No** | admin queries | **High** (grows per order line forever) |
| Returns all/user/order | `returns.repository.ts:18-29` | **No** | queries | Medium |
| Addresses all (admin) | `addresses.repository.ts:32` | **No** | admin | Medium |
| Coupons all | `coupons.repository.ts:29` | **No** | admin | Low |
| Discounts all | `discount.repository.ts:29` | **No**; cached 5 min (`discount.service.ts:92-96`) | `discounts` | Low-Medium |
| Brands, tags, categories, sub-categories, taxes, shipping zones, pickup locations, variants all | `brand.service.ts:46-52`, `tag.repository.ts:29`, `categories.repository.ts:20-22`, `sub-categories.repository.ts:28-33`, `tax.repository.ts:25`, `shipping-zones.repository.ts:25,29`, `pickup-locations.repository.ts:18,22`, `variant.repository.ts:32-40` | **No** | public/admin | Low (small config tables); `variant.findAll` Medium |
| Low-stock raw queries | `inventory.repository.ts:61-80` | **No**, full scan on `quantity` | cron / dashboard | Low |
| Analytics | `analytics.service.ts:42-94` | no date bound | admin | Low-Medium |

Count queries on every paginated request: `ProductsService.findAll` (`:75-83`) and `UsersService.findAll` (`users.service.ts:80-91`) always run `count(where)` in parallel with the page query. With a search filter that is a second full scan.

---

## 5. Caching

Current state (all confirmed by reading):

| Item | Cached? | Key / TTL | Invalidation | Issue |
|---|---|---|---|---|
| Category list | Effectively never | `category:tree`, 5 min | `del` on create/update/remove (`categories.service.ts:31,83,99`) | Bypassed whenever fields are selected (`:39-44`) — i.e. always (PERF-11). |
| Discount list / by id | Yes | `discount:all`, `discount:<id>`; default 5 min | `del` on every mutating path (`discount.service.ts:84,130,147,160`) | Local-only invalidation without Redis; list is unbounded. |
| Products, product detail | No | — | — | Public hot path hits Postgres every time. |
| Brands, tags, taxes, shipping zones | No | — | — | Small tables; cheap to cache. |
| Per-user data | Not cached | — | — | Good: no per-user data in shared keys. |

**In-memory fallback** (`cache.config.ts:27-30`): when `REDIS_HOST` is unset the app silently uses a per-process store. Consequences with >1 instance: stale discounts after an admin edit (only one instance's cache is invalidated), the throttler is also per-process (PERF-12), and there is no startup warning. `REDIS_HOST` is optional in the Joi schema (`CLAUDE.md` says so; `env.validation.ts` not changed by me). Recommendation: require Redis when `NODE_ENV=production` or at least log a `WARN` at boot; treat as a launch gate for any multi-instance deployment.

Proposed cache design (small, boring): cache-aside for `categories`, `brands`, `tags`, `shipping-zones`, `taxes` (TTL 5–10 min, invalidate on mutation via the same service), `product(id)` and first-page `products` for anonymous requests (TTL 30–60 s, keyed by normalised args hash, no per-user data), and `count` per filter (TTL 60 s). Add `Cache-Control`/CDN for public GETs only after the API is authenticated-vs-anonymous separated (GraphQL POST is not CDN-friendly; consider APQ with GET for public queries — Apollo Server 4 has APQ on by default using an in-memory LRU per instance, so use the Redis-backed cache for it when scaling out).

---

## 6. Heavy work on the request path, transactions, scaling blockers

### 6.1 Request-path work
- **Email**: not on the request path (fire-and-forget) — good; failure handling poor (PERF-14).
- **sharp + Cloudinary upload**: on the request path, memory storage, CPU-bound (PERF-15).
- **Paystack**: `initiatePayment` awaits Paystack (unbounded, PERF-06); *not* inside a DB transaction, so no locks are held across the external call — good. The webhook awaits Paystack verification synchronously (PERF-06).
- **bcrypt**: rounds 12 (`bcrypt.service.ts`, per TODO HIGH-4); each login/signup ≈ 150–300 ms of CPU on a 2-vCPU box. bcrypt runs on the libuv pool (4 threads by default); a login storm (credential stuffing against `auth` throttle that is per-IP in memory) will saturate the pool and slow *every* other async fs/crypto op. Suspected; measure with the login scenario.
- **Synchronous per-request logging**: two log lines per request plus one per resolver (middleware + interceptor), each serialised with the full variables JSON.

### 6.2 Transactions

| Transaction | Isolation | Locks held | Duration drivers |
|---|---|---|---|
| `createOrderFromCart` (`order.service.ts:362-390`) | default Read Committed | row locks on each `Product` (decrement), `CartItem` deletes, coupon usage insert | ~2N+8 round trips; no ordering of product ids (deadlock risk); no retry |
| `cancelOrderAndRestoreStock` (`:410-422`) | default | product rows (increment) | N+2; **no status guard** (PERF-05) |
| `softDeleteOrder` (`:438-443`) | default | product rows | N+1; the `softDelete` is outside the tx's `tx` client (uses `this.prisma`) — not atomic with the stock restore |
| `rotateRefreshToken` (`users.repository.ts:122-139`) | default, batch `$transaction([...])` | `RefreshToken` rows | short; fine |
| Coupon `recordUsage` (`coupons.repository.ts:61-64`, inside checkout tx) | default | `Coupon` row | **`usedCount` is a bare `increment: 1` with no `usedCount < usageLimit` condition**; the limit is checked earlier outside the tx (`validateCoupon`), so N parallel redemptions all pass the check and exceed `usageLimit` (Confirmed by reading; scenario S5). The per-user unique key (`couponId,userId`) turns a same-user duplicate into an unhandled `P2002` that rolls the whole checkout back. |

No transaction anywhere sets `isolationLevel`, `maxWait` or `timeout`. Read Committed is acceptable *if* every invariant is expressed as a conditional atomic `UPDATE` (stock, coupon, status transitions). Today stock is (decrement then check negative then roll back by throwing) which is correct under row locking but wasteful; status transitions and coupon limits are the gaps.

### 6.3 Horizontal-scaling blockers (checklist)

| Blocker | Status | Evidence |
|---|---|---|
| In-process cron without leader election | **Blocks** (duplicate stock restore) | PERF-05 |
| Throttler storage in memory | **Blocks** correctness of limits | PERF-12 |
| Cache in memory fallback | **Blocks** consistency | PERF-11 |
| Local disk logs | Operational loss | PERF-17 |
| `schema.gql` written on boot | Breaks read-only FS | PERF-17 |
| Uploads on local disk | **Not a blocker** (memory storage → Cloudinary) | `upload.controller.ts:19-22`; Multer `dest` is unused |
| Sticky sessions needed? | No (stateless JWT; refresh tokens in DB) | — |
| Prisma connection fan-out | Needs config / PgBouncer | PERF-16 |
| Container start | **Blocks** | PERF-18 |
| Graceful shutdown | Present (`main.ts:82-89`) but `process.exit(0)` right after `app.close()`; no drain of in-flight cron; fine | — |
| Rolling deploy with schema changes | No migration step in the image | PERF-18 |

---

## 7. Targets (proposed — not measured)

### 7.1 Traffic model (assumptions, adjust with real analytics)

| | Launch (Ghana SME) | 10x |
|---|---|---|
| Daily visitors | 500–2,000 | 5,000–20,000 |
| Peak concurrent shoppers | 30–80 | 300–800 |
| Read ops (list/detail/search/cart view) peak | ~15–40 req/s | ~150–400 req/s |
| Orders per hour (normal / promo peak) | 2–10 / 20–40 | 50–100 / 150–300 |
| Checkout concurrency (peak, hot SKU flash sale) | 1–3 simultaneous | 5–10 simultaneous on 3–5 SKUs |
| Paystack webhooks | ≈ online share of orders, bursts of 3–5/s | 5–15/s with duplicates |
| Mix | 85% anonymous browse, 12% authenticated cart/profile, 3% checkout/payment | same |

Assumes the app and Postgres run in the **same region/AZ** (RTT ≤ 2 ms) — this single assumption changes checkout latency by an order of magnitude (PERF-04). Mobile networks in Ghana add 100–400 ms of client RTT that these server-side targets exclude.

### 7.2 Latency targets (server-side, measured at the load balancer/app edge)

| Operation | Query shape (derived) | p95 launch | p95 at 10x | p99 at 10x | Notes |
|---|---|---|---|---|---|
| Product list (first=20, no search) | 2 queries + loaders (+N for `appliedDiscount`) | ≤ 150 ms | ≤ 300 ms | ≤ 600 ms | needs createdAt index, optional count |
| Product list with search | + FTS + tag ILIKE | ≤ 400 ms | ≤ 800 ms | ≤ 1.5 s | needs GIN/trgm; consider external search at >20k SKUs |
| Product detail | 1 + loaders | ≤ 100 ms | ≤ 200 ms | ≤ 400 ms | cache 30–60 s for anonymous |
| Cart view | 1 query w/ items+product | ≤ 100 ms | ≤ 200 ms | ≤ 400 ms | |
| Add to cart | 5–6 sequential queries | ≤ 150 ms | ≤ 300 ms | ≤ 600 ms | atomicity of upsert is a separate defect |
| `cartWithDiscount` | ~4–6 queries per item + N writes | ≤ 300 ms (10 items) | ≤ 500 ms | ≤ 1 s | currently far worse (PERF-10) |
| Checkout `createOrder` (≤10 items) | ≈ 25–60 queries, 1 tx | ≤ 600 ms | ≤ 900 ms | ≤ 2 s | tx hold time ≤ 300 ms |
| Checkout (50 items, max) | ≈ 215 queries | ≤ 1.5 s | ≤ 2.5 s | ≤ 4 s | must stay under tx timeout |
| Payment initiation | 3–4 DB + Paystack HTTP | ≤ 1.5 s (Paystack-dominated) | ≤ 2.5 s | ≤ 5 s | our overhead ≤ 100 ms; hard timeout 8 s |
| Webhook ack | signature + persist event | ≤ 150 ms | ≤ 300 ms | ≤ 800 ms | process async; Paystack needs a fast 2xx |
| Webhook end-to-end (order → PROCESSING) | + verify call | ≤ 5 s | ≤ 10 s | ≤ 30 s | with retry/outbox |

Availability/error budget proposal: 99.9% monthly for checkout + webhook; 5xx < 0.1% of requests; 0 oversold units; 0 duplicate stock restores; 0 lost paid orders (every successful Paystack charge reconciles to a `PROCESSING` or later order within 15 min — add a reconciliation job as the backstop).

### 7.3 Throughput targets
- Launch: sustain 40 read req/s and 3 checkouts/s on **one** 2-vCPU instance + a small Postgres (2 vCPU/4 GB), p95 within table above, CPU < 60%, DB pool wait < 5% of requests.
- 10x: sustain 400 read req/s and 10 checkouts/s on **two or three** instances behind a load balancer with PgBouncer; with Redis; flash-sale scenario (500 users, 5 SKUs, stock 100) completes with exact stock accounting.
- Capacity headroom rule: run at ≤ 50% of the measured breaking point in production.

---

## 8. Load-test plan

**Tool:** k6 (JS scenarios, GraphQL is plain HTTP POST, thresholds act as pass/fail, runs on Windows, results to Prometheus/Grafana or JSON). Alternative: Artillery. Use k6 `scenarios` with `ramping-arrival-rate` (open model) for traffic and `per-vu-iterations` for funnels.

**Environment:** a staging stack that mirrors production topology: same instance size, **2 app instances**, Postgres of production size with PgBouncer, Redis, *Paystack stubbed* with a local mock (never call real Paystack; mock injects 300–1500 ms latency, 1% 5xx, occasional 10 s hang) and the test harness computes valid `x-paystack-signature` HMACs. Email provider stubbed. Test data created by a seed script (not the production seeder).

**Data volumes** (design for the 10x year, so index problems show up): 5,000 products (with 1–3 variants, 3 images), 50 categories, 200 brands, 100,000 users, 20,000 carts, 300,000 orders / 900,000 order items, 300,000 payments, 1.5 M inventory logs, 1 M audit logs, 150,000 reviews, 5,000 discounts (200 active). Refresh Postgres statistics (`ANALYZE`) after load. Before running scenarios, capture `EXPLAIN (ANALYZE, BUFFERS)` for the 10 queries in the table in section 4 and record seq scans.

**Scenarios**

| # | Scenario | Load shape | Asserts |
|---|---|---|---|
| S1 | Browse | ramp 5 → 400 req/s over 10 min, 70% list, 20% detail, 10% search (incl. 3% multi-word/special chars) | p95/p99 vs 7.2; error rate < 0.1%; no tsquery 500s |
| S2 | Shopper funnel | 200 VUs: list → detail → addToCart → cart → cartWithDiscount → createOrder (COD) → payment init (online) | per-step p95; DB queries per iteration (log via `pg_stat_statements`) |
| S3 | Flash sale | 500 VUs hit 5 SKUs with stock 100 each, 10 checkouts/s for 2 min | **0 oversell**: `initial − sold = final stock ≥ 0`; orders×qty == sum of inventory-log deltas; no `P2034`/deadlock 500s (or retried transparently); tx duration p95 ≤ 300 ms |
| S4 | Webhook storm | 15 events/s, each event sent 3× (duplicates), plus out-of-order (success after cancel), plus delayed (30 s) | exactly one status transition per payment, no order regressed from DELIVERED/CANCELLED to PROCESSING, one confirmation email; ack p95 ≤ 300 ms; failures cause non-2xx so mock Paystack retries |
| S5 | Coupon race | single-use coupon, 50 parallel redemptions by 50 users; `usageLimit=10`, 100 parallel | exactly 1 resp. exactly 10 successes; `usedCount` equals `CouponUsage` rows |
| S6 | Double-submit / cancel race | same order cancelled 20× in parallel; cron fires during | stock restored exactly once |
| S7 | Abuse | depth-20 query via `reviews→product→reviews…`, 500 aliases, `first: 100000`, tsquery metacharacters, 5 MB upload ×100 | rejected quickly (4xx), server CPU < 70%, memory flat |
| S8 | Multi-instance | S2+S3 across 2 instances with Redis; kill one instance mid-test; run both crons | throttling consistent across instances; one cron executor; graceful drain, no 5xx spike > 1 s |
| S9 | Failure injection | Redis down 60 s; Postgres failover/restart; Paystack hang 20 s | public reads degrade to DB (no 5xx), checkout fails cleanly with retryable errors, readiness reflects DB only |
| S10 | Soak | 4 h at 1× launch load, then 1 h at 5× | RSS growth < 5%, event-loop lag p99 < 100 ms, no connection leak, log volume bounded, no unhandled rejections |
| S11 | Shared-IP | 300 VUs from one source IP at 10 req/s each | no legitimate throttling at expected per-user rates (validates the CGNAT concern) |

**Pass/fail gates (all must hold at the 10x profile):** thresholds in 7.2; http_req_failed < 0.5% excluding intentional business errors; zero data-integrity violations in S3–S6 (SQL reconciliation queries run after each scenario); Postgres: no connection-pool timeouts (`P2024`) and active connections < 70% of `max_connections`; app CPU < 70%, memory stable; p99 event-loop lag < 100 ms; every top-10 query shows an index scan in `EXPLAIN`.

**Instrumentation first (blocker):** enable the tracing bootstrap (PERF-23), expose Prometheus metrics (`prom-client`: HTTP and per-GraphQL-operation histograms, Prisma pool metrics), `pg_stat_statements`, slow-query log (`log_min_duration_statement = 200ms`), `auto_explain` on staging.

**Cadence:** run S1–S2 on every release candidate in CI nightly at 10% scale (smoke thresholds), full suite before launch and before any marketing event.

---

## 9. Recommended order of work (performance & scalability only)

1. PERF-01 (limits + remove public path into `User`) — security-grade, before launch.
2. PERF-02, PERF-03 indexes (one migration; verify with EXPLAIN at volume).
3. PERF-05 conditional status transitions + single-leader crons; PERF-18 container start.
4. PERF-04 + PERF-16: checkout batching, deterministic lock order, tx options, pool config.
5. PERF-06 Paystack timeout + webhook idempotent/async design (with the Payment owner).
6. Instrumentation (PERF-23), then PERF-07/08/09/10/11/12 driven by the load test.
7. PERF-13–15, 17, 19–22 as cleanup.
