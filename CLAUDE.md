# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

NestJS 12 + Apollo GraphQL (code-first) + Prisma/PostgreSQL e-commerce backend, Ghana-first (GHS, Paystack, MoMo, COD).

## Working state (read first)

Work follows a phased roadmap. **[`docs/roadmap/STATUS.md`](docs/roadmap/STATUS.md) is the live state of the work.** It holds the current phase, the active task and its exact next step, what's next, blockers and decisions. A session can be deleted at any moment, so never rely on "updating at the end": keep `STATUS.md` current **while** you work.

| File | Purpose |
|---|---|
| [`docs/roadmap/STATUS.md`](docs/roadmap/STATUS.md) | **Where we are and what to do next.** Single source of truth for progress. |
| [`docs/roadmap/ROADMAP.md`](docs/roadmap/ROADMAP.md) | The plan: phases, epics, tasks (`P<phase>-<epic>.<n>`), acceptance criteria, as a checklist with a Progress table: the at-a-glance view of what is done, in progress and to do. Detail stays in `STATUS.md`. |
| [`docs/roadmap/WORKING-AGREEMENT.md`](docs/roadmap/WORKING-AGREEMENT.md) | Branching, definition of done, safety rails |
| [`docs/roadmap/ADRs/`](docs/roadmap/ADRs/README.md) | Architecture decisions. Implement only **Accepted** ones. |
| [`docs/audit/`](docs/audit/SUMMARY.md) | Audit findings by ID. `docs/audit/modules/<module>.md` lists each module's open defects and definition of done. |

**Resuming ("continue", or any new session):**
1. Read `STATUS.md`. If there is an **Active task**, its **Next step** is where to pick up. Otherwise take the first **Up next** task whose blockers are clear.
2. Check it against reality, because the last checkpoint may be one step behind. Run `git branch --show-current`, `git status --short` and `git log --oneline -5`. If git shows work that `STATUS.md` doesn't mention (uncommitted files, newer commits), work out what was done, update `STATUS.md` first, then continue.
3. Read the task's entry in `ROADMAP.md`, the ADRs it links, and the module report(s) for the code it touches.
4. Tell the user which task and step you are resuming and your plan. Wait for go-ahead on multi-file or design changes.
5. If the task needs something listed under "Waiting on Emmanuel", ask instead of guessing.

**Checkpoint: update `STATUS.md` immediately whenever any of these happens:**
- **Starting a task:** set the Active task, branch, state, and a step checklist with the **Next step** marked. In `ROADMAP.md`, mark the task `- [ ] 🔄`.
- **Finishing a step:** tick it, note the files touched or the commit, and move the **Next step** marker.
- **Running tests:** record the command and the result under "Last test run".
- **Committing:** record the hash on the step.
- **Getting blocked, or making or receiving a decision:** add it to "Waiting on Emmanuel" or "Decisions log".
- **Completing a task:**
  - Clear the Active task.
  - Update the epic progress counts and the repro-test count.
  - Move the task off "Up next".
  - In `ROADMAP.md`, tick the task (`- [x]`, commit hash in brackets), add `✅ complete` to its epic heading when every task is ticked, and update the Progress table counts.
  - In each fixed finding's module report, mark the finding `Fixed in <commit>`, and change the verdict if the module's definition of done is met.

Make each checkpoint a small edit to `STATUS.md` in the same turn as the work, never batched for later. Before starting a long-running command, make sure `STATUS.md` already says what you are about to do.

**Scratch files:** put any file that should not be in git in `tmp/` (it is gitignored). That covers notes, raw tool output, experiments and exports. Never leave scratch files elsewhere in the repo.

## Commands

```bash
# Development
npm run start:dev       # Start with live reload (development)
npm run start:debug     # Start with debugger and watch
npm run start:prod      # Run compiled output (ROLE=api by default)
npm run start:worker    # Run the compiled worker (same as ROLE=worker node dist/main)

# Build
npm run build           # Compile TypeScript via NestJS CLI

# Code quality (the check-only variants are what CI runs)
npm run typecheck       # tsc --noEmit incl. specs (npm run build excludes specs, so don't rely on it)
npm run lint:check      # ESLint, no fixes
npm run format:check    # Prettier check (src, test)
npm run lint            # ESLint with auto-fix
npm run format          # Prettier format

# Testing
npm run test            # Run all unit tests (always via the npm scripts: Jest needs --experimental-vm-modules to load the ESM-only Nest 12 packages, so bare `npx jest` fails)
npm run test:watch      # Watch mode
npm run test:cov        # Coverage report
npm run test:e2e        # End-to-end tests (test/jest-e2e.json, one worker at a time, recycled above 1 GB heap, separate .env.test DB)
bash scripts/e2e/run.sh <db>_test <redis-db> [filters]  # e2e in Linux against the local emma-e2e-pg/emma-e2e-redis containers (cached node_modules)
npm run test:repro      # Audit repro tests (test/jest-repro.json); failures are expected until each finding is fixed

# Database
npx prisma migrate dev  # Run migrations in development (new migration: add --create-only and review the SQL first); no longer generates or seeds
npx prisma generate     # Regenerate Prisma Client (into src/generated/prisma, gitignored) after install and schema changes
npx prisma db seed      # Seed the database (command in prisma.config.ts; needs SUPER_ADMIN_EMAIL / SUPER_ADMIN_PASSWORD)
npm run schema:generate # Rewrite schema.gql from the resolvers (no DB or env needed)
npx prisma migrate diff --from-config-datasource --to-schema prisma/schema.prisma --exit-code  # Drift check (exit 2 = drift)
psql "$DATABASE_URL" -f scripts/reports/variant-migration-report.sql  # What the P1-V.2 variant migration could not map (read-only)
psql "$DATABASE_URL" -f scripts/reports/promotions-migration-report.sql  # Split discounts, untargeted promotions, usage drift after P2-B.1 (read-only)
```

## Non-negotiables

These describe what the code enforces today. ADR-0004 (money) and ADR-0014 (order state machine) are still Proposed and will replace some of them.

- **Variant = SKU (ADR-0003):** price, stock, SKU and barcode live on `Variant`; every product has at least one (a default variant without options). Carts, orders, stock levels, reservations and stock movements reference `variantId`. Product attributes and variant option values are checked by the pure `src/product-types/domain/attribute-validation.ts` against the product type.
- **Stock (ADR-0008):** lives in `StockLevel` (variant, location: `onHand`, `reserved`; available = onHand - reserved; all at the store's default `StockLocation` for now). Change it only through `StockLedgerService` (`src/inventory/stock-ledger.service.ts`) on the caller's transaction: every change is one conditional `StockLevel` update plus one append-only `StockMovement` (a trigger refuses updates and direct deletes). Orders reserve at placement (`StockReservation` ACTIVE), consume on online payment success or COD dispatch (`SHIPPED`), and release on cancel/expiry; each transition is a conditional update on the reservation status, so repeats are no-ops. Never write an absolute quantity. The database rejects negative onHand/reserved and reserved > onHand. Crossing a variant's low-stock threshold records `inventory.low_stock.v1`.
- **Order, payment and fulfilment status** (ADR-0014, P1-O.2) change only through their pure transition tables: `src/order/order-status.ts` (PLACED → CONFIRMED → IN_FULFILMENT → COMPLETED; CANCELLED, EXPIRED, PAYMENT_REVIEW), `src/payment/payment-intent-status.ts` (the PaymentIntent carries the order's payment: PENDING → CAPTURED → PARTIALLY_REFUNDED/REFUNDED; FAILED, CANCELLED) and `src/order/shipment-status.ts` (one `Shipment` per order for now). Order moves go through `OrdersRepository.transitionStatus` / `transitionOrder` (`src/order/order-transition.ts`): row lock, conditional `updateMany`, `OrderStatusEvent` in the same transaction; shipments through `transitionShipment` (with `ShipmentStatusEvent`). Never a plain status update. Staff never set an order status directly: payment confirms, the first shipment step starts fulfilment, delivery or `recordCodPayment` completes. COD stock is consumed on dispatch (OUT_FOR_DELIVERY / READY_FOR_PICKUP).
- **Payment providers (ADR-0007 §1):** payment services, webhook processing, reconciliation and refunds reach a provider only through the `PaymentProvider` port (`src/payment/providers/payment-provider.port.ts`: `initialize`, `verify`, `refund`, `parseWebhook(rawBody, headers)`, `settlesPayment`, `listTransactions`, `capabilities`), resolved by `PaymentProviderRegistry.get(provider)` from the attempt's `provider`. Adapters: `PaystackAdapter` (over the thin `PaystackClient`; raw-body HMAC with `timingSafeEqual`) and `CashOnDeliveryAdapter` (no provider operations). `PaymentProvidersModule` is its own module so `OrderModule` and `ReturnsModule` can use it.
- **Store payment config (P3-A.2, `src/payment/settings/`):** Paystack keys live per store in `PaymentProviderConfig`, the secret AES-256-GCM encrypted with `PAYMENT_CONFIG_ENCRYPTION_KEY` (random IV, `"<storeId>:<provider>"` as AAD); reads show only the last 4, audits and logs never the secret. `PaymentSettingsService` resolves credentials on every call (no cache, so API and worker see a change at once): the DB config, else `PAYSTACK_SECRET_KEY` (+ `PAYSTACK_CALLBACK_URL`), else none (online payment refused, checkout calls 503, webhooks 401). Payment methods are `Store` columns (card, mobile money, COD on/off; provider per online method, CHECK: never COD). The order keeps `PaymentMethod` ONLINE | CASH_ON_DELIVERY; the online method (`OnlinePaymentMethod` CARD | MOBILE_MONEY) is chosen per attempt at `POST /payment/initialize`, stored as the attempt `channel` and sent to Paystack as `channels`. `checkoutQuote`/`createOrder`/initialize refuse a method not on offer with `BAD_REQUEST` + `reason: PAYMENT_METHOD_UNAVAILABLE`. Changes need `payment.settings.manage` (Owner only) and step-up.
- **Price history (ADR-0005 §6):** every write to `Variant.price` or `Variant.basePrice` records a `PriceChange` per changed field in the same transaction: `PriceHistoryService.recordVariantPrices(tx, ...)` for single-variant writes, `insertRepricedChanges(origin)` (`src/price-history/price-history.repository.ts`) as the tail of a bulk reprice statement. No row when the value is unchanged. The table is append-only (a trigger refuses updates and direct deletes; deleting the variant removes its rows). Admin writes that change prices take an optional `priceChangeReason`.
- **Authorization:** every resolver, and every sensitive field resolver, has an explicit policy (`@Auth`, `@RequirePermission`, `@CustomerOnly`, field middleware). Permissions are code constants in `src/iam/authorization/permissions.ts`; never check `User.role` (deprecated, kept in step for old clients). `src/iam/authorization/auth-matrix.spec.ts` snapshots every operation's policy and fails on an operation without one; after a deliberate policy change review the diff and accept it with `npm test -- -u auth-matrix`. Never expose `User` on a public type; use `PublicProfile`.
- Guards and interceptors must work in both `http` and `graphql` contexts.
- **Money:** charges are in GHS. Never do float arithmetic on money in new code; use Prisma `Decimal`.
- **Pricing (ADR-0005):** every price, promotion amount, tax split and total comes from the pure engine `price(cart, context)` in `src/pricing/price.ts` (no I/O: the caller passes the lines, the candidate promotions and coupon code from `PromotionsService.findForPricing`, the customer's facts, the candidate price lists from `PriceListsService.findForPricing`, active tax rates, shipping fee, currency and `now`); the product-page loader uses its display rule (`displayUnitPromotion`). Never compute prices elsewhere. Its `Quote` carries a `quoteHash` (`src/pricing/quote-hash.ts`, SHA-256 over every value that determines the charge). `checkoutQuote` returns it; `createOrder` requires it, re-reads and re-prices everything inside the order transaction (cart row and variants locked) and fails with `CONFLICT` + `reason: QUOTE_CHANGED` when the hash differs; the quote is stored as the order snapshot. A rule change bumps `PRICING_VERSION`. Orders are snapshotted at placement (P1-O.1, `src/order/order-totals.ts`): `pricingVersion` (`PRICING_VERSION`, 4 since P2-W.1), totals, line prices/net/tax, `OrderAdjustment` (one per applied promotion: `DISCOUNT` automatic, `COUPON` unlocked by a code; `sourceId` = promotion id) and `OrderLineTax` rows; `grandTotal` is what is charged. Refunds and returns read the stored tax lines, never recompute (`src/returns/refund-tax.ts`). Legacy orders are `pricingVersion` 0 with no tax lines.
- **Promotions (ADR-0005, P2-B):** `Promotion` (scope SKU/PRODUCT/CATEGORY/BRAND/CART, type PERCENT/AMOUNT_OFF/FIXED_PRICE/BXGY/TIERED/FREE_SHIPPING (P2-B.5/B.6; value null for TIERED, and for FREE_SHIPPING that waives the fee), targets in join tables, schedule, conditions, priority, stacking group, exclusive, limits) replaces Discount/Coupon; a `CouponCode` (stored upper case) unlocks a promotion with `requiresCoupon`. Stacking (`PRICING_VERSION` 2): one winner per stacking group per level (item per line, then cart on the subtotal after item promotions), winners applied in priority order on what is left; an exclusive promotion that saves anything applies alone; ties go to the lowest priority, then the oldest. `createOrder` records one `Redemption` (RESERVED) per applied promotion through `PromotionsService.reserveRedemptions` in the order transaction: a conditional `usedCount` increment (row lock) per promotion and code, then the customer's RESERVED count against `perCustomerLimit`; none left: `CONFLICT` + `reason: PROMOTION_LIMIT_REACHED` / `PROMOTION_CUSTOMER_LIMIT_REACHED`. Cancel or expiry before payment releases them (`releaseRedemptions`, conditional, once); a paid order keeps them, refunded or not. Customer facts come from `PromotionsService.findForPricing`: RESERVED redemptions, `CustomerGroup` memberships (`customer-groups` module, permission `customer.group.manage`; generic, P2-W reuses them) and whether an earlier order reached CONFIRMED or later or PAYMENT_REVIEW (`firstOrderOnly`). Product pages never show coupon promotions; a visitor sees only promotions open to everyone, a signed-in customer (optional sign-in) also their group promotions and, without a prior order, first-order ones. A promotion or code an order used cannot be deleted. **Flash sales (P2-B.4):** an item promotion's optional `unitCap` caps the units sold at its price across orders; the engine offers only the units left (those it saves most on first) and splits a cart line into quote lines (and order items) by price, the reduced units first (`QuoteLine.cartLineIndex` names the cart line). Every redemption records its `units` (Σ quantity of the quote lines it reduced); `reserveRedemptions` adds them to `Promotion.unitsUsed` with a conditional increment (`CONFLICT` + `reason: PROMOTION_UNITS_SOLD_OUT`), `releaseRedemptions` gives them back with the use. **BXGY and tiers (P2-B.5), mix and match across lines:** the engine turns each item promotion into unit offers (`offersOf`): BXGY (`buyQuantity`/`getQuantity`/`maxApplications`, reward targets in `reward*` join tables, default the targets) offers the cheapest reward units `value`% off while enough other buy units pay for them; item TIERED offers every targeted unit the tier their combined quantity reaches; CART TIERED (spend X save Y) takes the tier reached by the subtotal after item promotions. Tiers live in `PromotionTier`, validated by `promotion-definition.ts` (ascending, never worth less going up). **Free shipping (P2-B.6):** FREE_SHIPPING (CART scope, optional `shippingZones`) is the shipping level after item and cart promotions: the engine gets `shippingZoneId` with the fee (null for pickup; from `ShippingZonesService.getZoneForCity`), measures minimum spend after cart promotions, waives the fee or takes `value` off it, one winner per group; the result is `Quote.shippingAdjustments`, stored as `OrderAdjustment` with `target: SHIPPING`, and `shippingTotal` is the fee after them (`discountTotal` stays merchandise only). The quote hash covers the zone. A zone a promotion is limited to cannot be deleted.
- **B2B price lists (ADR-0005 §7, P2-W.1):** `PriceList` (customer groups many-to-many, schedule, `priority`, `allowPromotions`, store currency) with one `PriceListEntry` per variant (`price` tax-inclusive like `Variant.price`, `minQuantity` = MOQ) and `PriceListTier` breaks above it (validated by `src/price-lists/price-list-definition.ts`: ascending, never dearer). The engine (`listPrice`) runs before promotions: per line, the lowest price over the customer's open lists for the cart's quantity of that variant (highest break reached; below the MOQ the normal price; ties lowest priority then oldest), used only when below the normal price. A line priced from a list without `allowPromotions` gets no item promotion and counts towards no minimum spend/quantity (item, cart, free shipping) nor shares a cart promotion. `QuoteLine.priceList` (list, break, allowPromotions) is in the quote hash; `OrderItem.priceListId` stores it as a snapshot (no FK). Admin API under `pricelist.manage` (Owner, Manager), every mutation with step-up, audited with entry prices before/after (list prices stay out of `PriceChange`). Product pages: the public catalogue queries are `@Auth(AuthType.Optional)`; `Variant.customerPrice`/`priceTiers` (`displayPriceTiers`) come from the request-scoped `PromotionLoader`, keyed by viewer and variant.
- **Side effects** (email, webhook processing) run in the worker, never on the request path. After a state change, write an outbox event in the same transaction (`OutboxService.record(tx, ...)`); for an email with no surrounding transaction, use `NotificationsService` (it queues the job). Consumers are idempotent on the job id; errors and logs carry no addresses or tokens.
- No secrets or PII in logs.
- **Migrations:** create with `--create-only` and review the SQL. Never edit an applied migration. Backfills must be safe to re-run. `prisma migrate diff` must show no drift.
- **API changes:** regenerate `schema.gql` with `npm run schema:generate` and commit it (CI fails on a stale file). Update `FRONTEND_API_DOCUMENTATION.md` with every API change. CI's graphql-inspector check fails on breaking changes unless a commit in the push/PR is marked `[breaking-api]`.
- **No API clients yet (Emmanuel, 2026-11-20):** no frontend or other client uses this API, so breaking changes are allowed without deprecation windows or compatibility shims: choose the clean design. Still mark such commits `[breaking-api]` and list the breaks in `FRONTEND_API_DOCUMENTATION.md`. This ends when the first frontend or client integrates; from then on, deprecate before removing.

## Architecture

**NestJS** backend with **GraphQL** (Apollo Server v5, Express 5) as the primary API. REST endpoints exist only for payment webhooks (Paystack). The GraphQL schema is auto-generated to `schema.gql` on startup.

**Database:** PostgreSQL via **Prisma 7** ORM with the `@prisma/adapter-pg` driver adapter. Schema lives in `prisma/schema.prisma`; CLI config (schema and migrations paths, seed command, `DATABASE_URL`) in `prisma.config.ts`, which loads `.env` itself. Import the client, `Prisma` and enums from `src/generated/prisma/client`, not `@prisma/client`. Migrations are in `prisma/migrations/`.

### Module structure

Each feature follows this pattern:
```
feature/
├── feature.module.ts
├── feature.service.ts        # Business logic, calls Prisma directly
├── feature.resolver.ts       # GraphQL queries/mutations
├── dto/                      # Input types and filter args (class-validator decorated)
├── entities/                 # GraphQL output types
└── enums/                    # Feature-specific enums
```

Feature modules: `users`, `products`, `product-types`, `categories`, `sub-categories`, `brand`, `tag`, `variant`, `cart`, `order`, `payment`, `addresses`, `promotions`, `customer-groups`, `price-lists`, `wishlist`, `review`, `returns`, `inventory`, `analytics`, `tax`, `shipping-zones`, `pickup-locations`, `price-history`, `fraud` (velocity checks).

Supporting modules: `prisma` (PrismaService), `config` (Joi env validation in `env.validation.ts`, cache config), `currency`, `notifications` (Resend email + templates), `health` (health controller/indicators), `redis` (shared ioredis client), `jobs` (BullMQ queues), `outbox` (domain events + relay), `worker` (the `ROLE=worker` root module), plus `instrument.ts` (main.ts's first import: starts Sentry, then `telemetry.ts`: one OpenTelemetry NodeSDK for traces, enabled via `OTEL_ENABLED`, and Prometheus metrics) and `observability/` (Sentry options and PII scrubbing, `reportError`/`reportFailedJob`, `AppMetrics`, the HTTP metrics middleware and the GraphQL metrics plugin).

### Authentication & Authorization (`src/iam/`)

- **JWT**: Access token (1h) + Refresh token (24h) + password-reset token (15m, `JWT_RESET_SECRET`). TTLs are overridable via `JWT_*_TTL` env vars. Refresh rotation runs in a Prisma `$transaction`. All routes are protected by default via `AuthenticationGuard`.
- Mark public routes with `@Auth(AuthType.None)`. `@Auth(AuthType.Optional)` (public catalogue queries) is public but verifies a bearer token when one is sent and attaches its user; an invalid or expired token gets `UNAUTHENTICATED`, never the anonymous view.
- Mark staff routes with `@RequirePermission('order.refund', ...)` (ADR-0013; fulfilment steps need `order.fulfil`, cancel/delete `order.manage`) and customer self-service routes staff must not use with `@CustomerOnly()`. Mark routes open to any signed-in user with `@Auth(AuthType.Bearer)`.
- Roles are data: `StaffRole` (system roles Owner, Manager, InventoryClerk, Cashier, Support seeded by migration; Owner always holds every permission) assigned through one `StoreMembership` per user. `AccessTokenGuard` loads the membership with the user on every request (`request.access`, `@ActiveAccess()`); `AuthorizationGuard` enforces the policy. Staff-account and role changes follow `src/iam/authorization/staff-rules.ts` (no escalation, only an Owner acts on an Owner, the last Owner stays) and are audited.
- Social login: Google and Facebook via `GoogleAuthenticationService` / `FacebookAuthenticationService`, linked to users through the `AuthProvider` model.
- **MFA (`src/iam/mfa/`):** own RFC 6238 TOTP on `node:crypto` (SHA1, 6 digits, 30 s, ±1 step, replayed steps refused via `User.mfaLastUsedStep`); secrets AES-256-GCM encrypted with `MFA_ENCRYPTION_KEY` (user id as AAD), 10 single-use recovery codes stored as keyed hashes. `AuthenticationService.generateTokens` is the only way to start a session after a first factor and fails with `UNAUTHENTICATED` + `reason: MFA_REQUIRED` + a 5-minute `mfaChallenge` for MFA users (so password and social sign-in cannot skip it); `completeMfaSignIn` finishes it. Roles with `mfaRequired` (Owner, Manager) get `FORBIDDEN` + `reason: MFA_ENROLLMENT_REQUIRED` on every permission-guarded operation until enrolled.
- **Step-up:** mark sensitive resolvers `@RequireStepUp()` (optionally with an argument condition) next to `@RequirePermission`. Access tokens carry a session id (`sid`, kept across refresh); `stepUp`, `completeMfaSignIn` and `confirmMfaEnrollment` record a verification per session in Redis (`StepUpStore`, 10 minutes); otherwise `FORBIDDEN` + `reason: STEP_UP_REQUIRED`. Covered: role/permission changes, refunds, price changes (product/variant price, promotions and coupon codes, price lists, taxes), data exports (`addresses` without `userId`).
- e2e helpers: `prepareStaffAccounts` gives directly inserted ADMIN/SUPER_ADMIN users their membership and enrols Owner/Manager MFA with `TEST_TOTP_SEED`; `signInWithPassword` completes the second factor (fresh step-up).

### Commons (`src/commons/`)

- `LoggerService` — Winston-based logger, used app-wide: single-line JSON on stdout (ISO UTC `timestamp`, `level`, `message`, `context`, `requestId`, `userId`, `jobId`/`queue` in jobs, plus structured fields passed as the third argument); coloured text and rotated files under `logs/` in development only. Level via `LOG_LEVEL`. Stack traces only in development (`stackForLog`)
- `CloudinaryService` — image upload/storage (`upload.controller.ts` exposes the REST upload)
- `AuditService` — writes to the `AuditLog` model
- Global exception filter (`AllExceptionsFilter` + `error-classification.ts`) maps HTTP statuses to GraphQL codes (400 `BAD_REQUEST`, 401 `UNAUTHENTICATED`, 403 `FORBIDDEN`, 404 `NOT_FOUND`, 409 `CONFLICT`; ValidationPipe failures `BAD_USER_INPUT`) and Prisma P2002/P2003 → `CONFLICT`, P2025 → `NOT_FOUND` with safe messages; an HttpException whose response has `extensions` (e.g. `reason`) passes them on; stack traces are logged only in development
- GraphQL query limits (`commons/graphql/query-limits.ts`): depth ≤ 8, aliases ≤ 15, estimated cost ≤ 3000 (`graphql-query-complexity`); introspection is exempt and off in production
- `GqlThrottlerGuard` — global rate limiting (stricter limits on auth mutations such as `forgotPassword`/`resetPassword`)
- `PaginationArgs` / `PageInfo` entities are shared across all list queries

### Platform behaviour

- **Redis is required** in every environment (`REDIS_HOST`; startup fails without it). It backs the global `CacheModule` (5 min default TTL), the throttler storage (`RedisThrottlerStorage`, one Lua script, so limits hold across instances) and the shared ioredis client (`REDIS_CLIENT` from `src/redis/redis.module.ts`, closed on shutdown). `/health/ready` probes it with `PING`.
- **Two processes, one image:** `ROLE=api` (default) serves GraphQL/REST; `ROLE=worker` (`src/worker/worker.module.ts`, or `--role=worker`) runs the outbox relay and the BullMQ processors and serves only `GET /health/live` and `/health/ready` on `PORT`. Queue processors are registered only in `WorkerModule`, so the API never consumes jobs. Both shut down gracefully on SIGTERM.
- **Repeatable jobs:** the former crons are BullMQ job schedulers on the `maintenance` queue (`src/worker/maintenance-jobs.ts`), upserted by every worker at startup and run once per tick across the cluster; the tasks keep their Postgres advisory locks as a second guard. A worker removes the schedulers of jobs that no longer exist at startup. `inventory.reconcile-stock` (02:30 UTC) checks every `StockLevel` against the sum of its movements and its ACTIVE reservations and only reports (metric + warning log with ids); it never corrects. There is no `@nestjs/schedule`.
- **Order events:** `order.placed.v1`, `order.status_changed.v2` (recorded for COMPLETED), `shipment.status_changed.v1` (dispatch), `shipment.tracking_updated.v1`, `payment.succeeded.v1`; `order.status_changed.v1` and `order.shipment_updated.v1` are no longer recorded but still consumed until drained.
- **Queues:** `notifications` (outbox email events and direct email jobs; 6 attempts, exponential backoff from 5 s; sent-once marker per job id in Redis plus Resend idempotency key), `webhooks` (stored Paystack events, job id = `WebhookEvent` id; 8 attempts; the endpoint answers 200 once the event is stored), `maintenance` (repeatable jobs). Jobs that spend their attempts stay in the failed set (30 days) and are listed/retried by the SUPER_ADMIN `failedJobs` / `retryFailedJob` operations (audited).
- **Outbox (ADR-0009):** write a domain event with `OutboxService.record(tx, event)` inside the business transaction; event types are versioned (`src/outbox/domain-events.ts`). The worker's `OutboxRelay` publishes unpublished rows (`FOR UPDATE SKIP LOCKED`) to BullMQ with `jobId = event id`; consumers must be idempotent on that id.
- **Production safeguards:** GraphQL introspection is off when `NODE_ENV=production`; `ALLOWED_ORIGINS` is required at startup in production; helmet sets CSP and HSTS.
- **Correlation:** `LoggerMiddleware` keeps a client `X-Request-ID` matching `^[A-Za-z0-9-]{1,64}$` (else generates a UUID), echoes it in the response and runs the request inside an `AsyncLocalStorage` context (`src/commons/correlation.ts`), so every log record carries `requestId` (and `userId` once authenticated) without passing it around. Jobs carry it as `meta.requestId` in their data (`withJobMeta`; outbox rows store it in `OutboxEvent.requestId` and the relay copies it); processors run each job inside `runJobInContext` (requestId + jobId + queue; scheduled jobs get a fresh id).
- **Error tracking (Sentry):** on only when `SENTRY_DSN` is set, in both roles, initialised before the app. Reported: 5xx/`INTERNAL_SERVER_ERROR` from REST and GraphQL (`AllExceptionsFilter`, and `formatError` for errors the filter never saw), and BullMQ jobs with no attempts left; expected client errors (4xx, `BAD_USER_INPUT`, `UNAUTHENTICATED`, `FORBIDDEN`, `NOT_FOUND`, `CONFLICT`) are not. Events carry `requestId`/`jobId`/`queue` tags and the user id only; `dataCollection` is all off and `scrubEvent` strips request bodies, headers, cookies, query strings and breadcrumbs. Use `reportError(exception)` for a caught server failure that must not vanish.
- **Metrics (Prometheus):** unless `METRICS_ENABLED=false`, each process serves `GET /metrics` from the OpenTelemetry Prometheus exporter's own server on `METRICS_PORT` (default 9464, all interfaces; never the API port, so do not expose it publicly). API: `http_request_duration_seconds` (method, route template, status class), `graphql_operation_duration_seconds` (operation name capped at 100 distinct names, type, outcome), `api_errors_total` (transport, code), `webhook_processing_failures_total`. Worker: `job_duration_seconds`/`job_failures_total` (queue, name), `queue_jobs` (queue, state), `outbox_unpublished_events`, `outbox_oldest_unpublished_age_seconds`, `payment_reconciliation_mismatches_total`, `stock_reconciliation_mismatches_total` (kind: ON_HAND, RESERVED_MOVEMENTS, ACTIVE_RESERVATIONS). Both: `velocity_limit_hits_total` (rule, level), `velocity_check_errors_total` (stage: screen, record). Record through `AppMetrics` (global `ObservabilityModule`); labels must stay bounded (no ids, raw paths or variable values). Alert rules: `ops/prometheus/alerts.yml` (drills in `alerts.test.yml`; see `docs/roadmap/environments.md` → Observability). A port clash fails startup; the API and worker need different ports when they share a network namespace.
- **Velocity checks (P3-E.1, `src/fraud/`):** fixed-window counters in Redis (one Lua script increments every counter of an event and sets its TTL = window) per customer, phone (E.164), IP and card (Paystack authorization signature, from verified attempts, failed-payment counts only). Keys are `velocity:<rule>:<sha256(subject type + value)>`: never a raw phone, IP or card in Redis, the database or logs. The rule catalogue and default limits are code (`src/fraud/velocity-rules.ts`, pure); the Owner overrides limits (`VelocityLimit`, `payment.settings.manage`, step-up, audited). `createOrder` and `POST /payment/initialize` are screened before they run: above a hard limit `FORBIDDEN` + `reason: VELOCITY_LIMIT`; above a soft limit the order gets an `OrderReviewFlag` (staff list them with `order.view`, clear them with `order.manage`, audited). Settlement only flags (customer and card failures). Events are counted after the action succeeds, so concurrent requests can overshoot a limit by a few. Redis failure: fail-open with an error log and `velocity_check_errors_total`.
- **Prisma enums/models** also cover fulfillment (`FulfillmentType`, pickup locations, shipping zones), taxes, promotions (`Promotion`, `CouponCode`, `Redemption`), price lists (`PriceList`, `PriceListEntry`, `PriceListTier`), return requests and the stock ledger (`StockLocation`, `StockLevel`, `StockReservation`, `StockMovement`).

### Environment variables

Validated at startup by `src/config/env.validation.ts` (Joi); see `.env.example` for the full list.

```
Required:  NODE_ENV (development | test | production; no default),
           DATABASE_URL, JWT_SECRET, JWT_REFRESH_SECRET, JWT_RESET_SECRET (each >= 32 chars),
           JWT_TOKEN_AUDIENCE, JWT_TOKEN_ISSUER,
           GOOGLE_CLIENT_ID/SECRET, FACEBOOK_APP_ID/SECRET,
           CLOUDINARY_CLOUD_NAME/API_KEY/API_SECRET,
           REDIS_HOST (every environment),
           MFA_ENCRYPTION_KEY (64 hex chars = 32 bytes; encrypts TOTP secrets, keys recovery-code hashes),
           PAYMENT_CONFIG_ENCRYPTION_KEY (64 hex chars; encrypts payment provider secrets stored in the database)
Production: ALLOWED_ORIGINS is also required; placeholder secrets
           (change-me, your-..., xxx, ..., an encryption key made of a repeated pattern), a JWT secret reused across
           the three and PAYMENT_CONFIG_ENCRYPTION_KEY equal to MFA_ENCRYPTION_KEY are rejected
Optional:  PORT, ROLE (api | worker, default api), ALLOWED_ORIGINS, LOG_LEVEL,
           PAYSTACK_SECRET_KEY, PAYSTACK_CALLBACK_URL (fallback while the store has no Paystack config in the database),
           JWT_ACCESS_TOKEN_TTL, JWT_REFRESH_TOKEN_TTL, JWT_RESET_TOKEN_TTL,
           REDIS_PORT (6379), REDIS_PASSWORD, REDIS_DB (0-15, default 0), RESEND_API_KEY, RESEND_FROM_EMAIL,
           OTEL_ENABLED ('true' | 'false'), OTEL_SERVICE_NAME, OTEL_EXPORTER_OTLP_ENDPOINT (http(s) URI),
           SENTRY_DSN (http(s) URI; Sentry is off when unset), SENTRY_ENVIRONMENT (default NODE_ENV),
           SENTRY_RELEASE, SENTRY_TRACES_SAMPLE_RATE (0-1, default 0),
           METRICS_ENABLED ('true' | 'false', default 'true'), METRICS_PORT (default 9464)
Seeding:   SUPER_ADMIN_EMAIL, SUPER_ADMIN_PASSWORD
```

### Testing

Unit tests are colocated as `*.spec.ts` under `src/`. E2E tests live in `test/e2e/` (`*.e2e-spec.ts`) with shared helpers in `test/helpers/` and `test/setup.ts`; they use a separate database and Redis configured in `.env.test` (not committed — create it from `.env.test.example` or with `node scripts/write-test-env.js <DATABASE_URL> [redis://host:port/db]`; `test/setup.ts` refuses to run unless the database name ends in `_test`).
