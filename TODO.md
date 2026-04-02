# Production Readiness & Feature Completeness TODO

Generated from the full codebase audit. Work through phases in order — each phase builds on the previous.
Mark tasks as complete by changing `- [ ]` to `- [x]`.

---

## Phase 0 — Critical Security Fixes (Block all other work until done)

These are exploitable vulnerabilities or data-integrity failures that must be resolved before any further development or deployment.

### Payment Security
- [x] Add `@Roles(Role.USER)` guard to `PaymentResolver.verifyPayment` — currently any request can verify any payment
- [x] Add ownership check in `verifyPayment` so a user can only verify their own payment reference — introduced `verifyPaymentAsUser(reference, userId)` in `PaymentService`
- [ ] Add authorization check to REST `PaymentController.verifyTransaction` endpoint — kept `@Auth(AuthType.None)` (required for Paystack browser redirect); webhook security via HMAC signature already in place
- [x] Validate Paystack webhook signature on the REST webhook handler before processing any payload — already implemented via `isValidWebhookSignature`; confirmed in audit
- [x] Sanitize and filter `Payment.paymentDetails` before persisting — `sanitizeInitializeDetails` and `sanitizeVerifyDetails` strip PII, raw tokens, and authorization objects

### Cart Security
- [x] Add `@UseGuards(AuthenticationGuard)` to `CartResolver.cartWithDiscount` query — changed to use `@ActiveUser('id')` so users can only access their own cart

### Financial Data Integrity
- [x] Change `Order.totalAmount` from `Float` to `Decimal` in `prisma/schema.prisma`
- [x] Change `Payment.amount` from `Float` to `Decimal` in `prisma/schema.prisma`
- [x] Change `OrderItem.priceAtOrder` from `Float` to `Decimal` in `prisma/schema.prisma` (additional field found during implementation)
- [x] Run and name the migration: migration `20260402000000_fix_monetary_fields_to_decimal` applied successfully

### Order Atomicity
- [x] Wrap the entire order-creation flow (stock deduction + cart clear + order record insert) in a Prisma `$transaction` to prevent partial writes — already implemented in `saveOrderAndUpdateInventory`; confirmed in audit
- [x] Wrap order cancellation (status update + stock restoration) in a Prisma `$transaction` — already implemented in `cancelOrderAndRestoreStock`; confirmed in audit

---

## Phase 1 — High-Priority Security Hardening

### Authentication
- [x] Implement account lockout: `failedLoginAttempts` and `lockedUntil` added to User; locks after 5 failures for 15 min; resets on success. `UsersService.recordFailedLoginAttempt` / `resetFailedLoginAttempts` added
- [x] Implement refresh token revocation: `RefreshToken` table with `tokenHash` (SHA-256) + `revoked` flag; `signOut` mutation revokes by hash. `AuthenticationService.signOut` added
- [x] Implement refresh token rotation: `refreshToken` revokes the incoming token before issuing new pair — each token is single-use
- [x] Re-check `user.isActive` inside the refresh token flow — throws `UnauthorizedException('Account is inactive')` if false
- [x] Fix social login null-email edge case: both `GoogleAuthenticationService` and `FacebookAuthenticationService` now throw `UnauthorizedException` if no email is returned

### Authorization
- [x] `BrandResolver.deleteBrand` — already had `@Roles(Role.SUPER_ADMIN, Role.ADMIN)` at method level; confirmed in audit re-review
- [x] `TagResolver.deleteTag` — already protected by class-level `@Roles(Role.ADMIN, Role.SUPER_ADMIN)`; confirmed in audit re-review
- [x] Audited all resolvers — no unguarded mutations found beyond what was fixed in Phase 0

### Input Validation
- [x] `CreateDiscountInput.endDate` — added `@IsEndDateAfterStartDate('startDate')` custom validator; works on partial `UpdateDiscountInput` too (skips if `startDate` absent)
- [x] `CreateReviewInput.score` — already had `@Min(1) @Max(5)`; confirmed in audit re-review
- [x] `CreateAddressInput` — added `@MaxLength` to all 5 fields (street: 255, city/state/country: 100, zipCode: 20)
- [x] Max addresses per user — `AddressesService.createAddress` now enforces limit of 10 via `enforceAddressLimit`
- [x] Max wishlist size — `WishlistService.addToWishlist` now enforces limit of 100 via `enforceWishlistLimit`
- [x] Upload file size limit — `UploadController` uses `multerOptions` with `limits: { fileSize: 5 MB }` on both endpoints

---

## Phase 2 — Architecture: Repository Pattern

The services currently call `PrismaService` directly, violating the Dependency Inversion Principle and making unit testing fragile.

- [ ] Create `UsersRepository` — extract all `prisma.user.*` calls from `UsersService`
- [ ] Create `ProductsRepository` — extract all `prisma.product.*` calls from `ProductsService`
- [ ] Create `CategoriesRepository` — extract all `prisma.category.*` calls from `CategoriesService`
- [ ] Create `SubCategoriesRepository` — extract all `prisma.subCategory.*` calls
- [ ] Create `BrandRepository` — extract all `prisma.brand.*` calls
- [ ] Create `TagRepository` — extract all `prisma.tag.*` calls
- [ ] Create `VariantRepository` — extract all `prisma.variant.*` calls
- [ ] Create `CartRepository` — extract all `prisma.cart.*` and `prisma.cartItem.*` calls
- [ ] Create `OrdersRepository` — extract all `prisma.order.*` and `prisma.orderItem.*` calls
- [ ] Create `PaymentRepository` — extract all `prisma.payment.*` calls
- [ ] Create `DiscountRepository` — extract all `prisma.discount.*` calls
- [ ] Create `AddressesRepository` — extract all `prisma.address.*` calls
- [ ] Create `WishlistRepository` — extract all `prisma.wishlist.*` and `prisma.wishlistItem.*` calls
- [ ] Create `ReviewRepository` — extract all `prisma.review.*` calls
- [ ] Map Prisma error `P2002` (unique constraint) to `ConflictException` inside each repository (not service)
- [ ] Map Prisma error `P2025` (record not found) to `NotFoundException` inside each repository
- [ ] Remove all direct `PrismaService` imports from every service file after repositories are wired

---

## Phase 3 — Performance: N+1 & Query Optimization

### DataLoaders (critical for production query performance)
- [ ] Create `UsersLoader` — batch-load users by ID for use in `ReviewResolver`, `OrderResolver`, and `WishlistResolver` resolved fields
- [ ] Create `ProductsLoader` — batch-load products by ID for use in `CartItemResolver`, `OrderItemResolver`, `WishlistItemResolver`
- [ ] Create `VariantsLoader` — batch-load variants by product ID for use in `ProductResolver.variants` resolved field
- [ ] Create `ReviewsLoader` — batch-load reviews by product ID for use in `ProductResolver.reviews` resolved field
- [ ] Create `AddressesLoader` — batch-load addresses by user ID for use in `UserResolver.addresses` resolved field
- [ ] Create `OrdersLoader` — batch-load orders by user ID for use in `UserResolver.orders` resolved field
- [ ] Register all DataLoaders with `REQUEST` scope in their respective modules
- [ ] Replace direct service calls in all `@ResolveField()` methods with the appropriate DataLoader

### Pagination Fix
- [ ] Fix cursor pagination in `ProductsService` — replace `skip: hasCursor ? 1 : 0` + `take` with Prisma's `cursor` + `skip: 1` pattern
- [ ] Apply the same corrected cursor pattern to all other paginated list queries (users, orders, reviews)
- [ ] Defer or cache the total-count query in paginated responses to avoid a full `COUNT(*)` on every request

### Query Optimization
- [ ] Break `getUserProfile` into a parent query + `@ResolveField()` resolvers (addresses, cart, wishlist, orders) so clients only fetch what they request
- [ ] Extend `extractRequestedFieldsFromQuery` usage (or a simpler field-selection utility) consistently across all list resolvers, not just products
- [ ] Add null-check to the level-3 field extraction in `extractRequestedFieldsFromQuery` (line 118 type cast without guard)
- [ ] Add `select` to all `findMany` calls on large tables to prevent over-fetching

---

## Phase 4 — Infrastructure: Caching & Rate Limiting

### Redis Integration
- [ ] Add `ioredis` or `@nestjs/cache-manager` Redis store to dependencies
- [ ] Configure `CacheModule.registerAsync` with Redis connection via `ConfigService`
- [ ] Migrate category caching from in-memory to Redis so cache is shared across instances
- [ ] Cache frequently read, rarely written data: active discounts, product detail pages
- [ ] Implement Redis-backed `ThrottlerStorage` so rate limit counters are shared across all instances

### Distributed Rate Limiting
- [ ] Replace in-memory throttler storage with `ThrottlerStorageRedisService`
- [ ] Add specific rate limit to payment initiation endpoint (e.g., 5 per minute per user)
- [ ] Add specific rate limit to file upload endpoint

---

## Phase 5 — Observability & Operations

### Request Correlation
- [ ] Add a request-ID middleware (using `uuid`) that attaches `X-Request-ID` to every incoming request
- [ ] Propagate the request ID through the Winston logger context so all log lines for a single request share the same ID
- [ ] Return `X-Request-ID` in response headers for client-side correlation

### Logging
- [ ] Ensure no `console.log` statements remain anywhere in the codebase (`npm run lint` or grep)
- [ ] Add structured logging to the payment webhook handler (log reference, amount, status on every event)
- [ ] Redact sensitive fields (`paymentDetails`, raw token values) from all log outputs

### Health Checks
- [ ] Verify `HealthModule` covers: database connectivity, Redis connectivity, Cloudinary reachability
- [ ] Add a `/health/ready` vs `/health/live` distinction (readiness vs liveness probes)

---

## Phase 6 — Missing Ecommerce Features

### Notification / Email System
- [ ] Integrate a transactional email provider (SendGrid, Resend, or AWS SES) via a dedicated `NotificationsModule`
- [ ] Send order confirmation email on successful order creation
- [ ] Send order status update email when order status changes (SHIPPED, DELIVERED)
- [ ] Send payment confirmation email on successful payment
- [ ] Implement password reset flow: generate a signed token, send reset email, verify token, update password
- [ ] Send welcome email on new user registration

### Coupon / Promo Code Redemption
- [ ] Add `Coupon` model to Prisma schema (`code`, `discountType`, `value`, `usageLimit`, `usedCount`, `expiresAt`, `isActive`)
- [ ] Create `CouponsModule` with full CRUD (admin) and a `applyCoupon(code)` mutation (user)
- [ ] Enforce single-use-per-user coupons via a `CouponUsage` join table
- [ ] Apply coupon discount during order creation and reflect in `Order.discountAmount`

### Return & Refund Flow
- [ ] Add `ReturnRequest` model to Prisma schema (`orderId`, `userId`, `reason`, `status`, `refundAmount`, `createdAt`)
- [ ] Create `ReturnsModule` with: create return request (user), approve/reject return (admin), process refund (admin)
- [ ] Integrate Paystack refund API call on return approval
- [ ] Restore stock on approved return

### Inventory Management
- [ ] Add `lowStockThreshold` field to `Product` and `Variant` models
- [ ] Add a scheduled task (or database trigger) that emits a low-stock event when `stockQuantity <= lowStockThreshold`
- [ ] Add an admin `restockProduct` mutation to increment stock
- [ ] Add an `InventoryLog` model to track all stock changes with reason and actor

### Order Fulfillment / Shipping
- [ ] Add `ShippingAddress` snapshot to `Order` (copy from user address at time of order, not a FK)
- [ ] Add `trackingNumber` and `carrier` fields to `Order`
- [ ] Add `updateShipping` mutation for admin to set tracking info
- [ ] Expose shipping status in the order GraphQL type

### Admin Analytics & Reporting
- [ ] Add `getSalesReport(startDate, endDate)` query returning total revenue, order count, average order value
- [ ] Add `getTopProducts(limit)` query returning best-selling products by order count and revenue
- [ ] Add `getRevenueByCategory` query
- [ ] Add `getDashboardSummary` query: total users, orders today, revenue today, low-stock items

### Search
- [ ] Implement Postgres full-text search on `Product` (`name`, `description`) using `@@fulltext` index
- [ ] Add `search: String` argument to `products` query
- [ ] (Optional / future) Evaluate Elasticsearch or Typesense for advanced search with faceting

### Multi-Currency & Tax
- [ ] Implement a `CurrencyConversionService` that fetches exchange rates (or uses static config)
- [ ] Add optional `currency` argument to product price queries
- [ ] Add `TaxRate` model (`country`, `region`, `rate`) and apply during order totalling

---

## Phase 7 — Test Coverage

### Unit Tests
- [ ] Write unit tests for `CartService` — cover add item, remove item, stock validation, clear cart
- [ ] Write unit tests for `OrdersService` — cover create order, cancel order, status transitions
- [ ] Write unit tests for `PaymentService` — cover initiate, verify, webhook processing
- [ ] Write unit tests for `DiscountService` — cover percentage vs flat calculation, best-discount selection, expired discounts
- [ ] Write unit tests for `ReviewService` — cover duplicate review prevention, ownership checks
- [ ] Write unit tests for `AuthService` — cover sign-up, sign-in, refresh, account lockout
- [ ] Write unit tests for each Repository class once the repository layer is introduced (Phase 2)
- [ ] Achieve ≥ 90% line coverage on all service files (`npm run test:cov`)

### E2E Tests
- [ ] Add E2E test for the full happy-path order flow: auth → browse products → add to cart → create order → initiate payment → webhook → verify payment
- [ ] Add E2E test for the Paystack webhook handler with a valid and an invalid signature
- [ ] Add E2E test for the auth flow: sign-up → sign-in → refresh → logout (token revocation)
- [ ] Add E2E test for the discount flow: create discount → apply to product → verify discounted price in cart

---

## Phase 8 — Code Quality & Housekeeping

- [ ] Enable TypeScript `strict` mode in `tsconfig.json` if not already on; resolve all resulting type errors
- [ ] Remove all `any` type usages from the codebase
- [ ] Remove all `console.log` / `console.error` calls; replace with injected `Logger`
- [ ] Add JSDoc comments to all public service methods
- [ ] Add `@Min(0)` constraint to all quantity and price fields in DTOs
- [ ] Add `@IsUrl({ require_tld: true, protocols: ['https'] })` to all image URL fields consistently
- [ ] Validate `SubCategory` uniqueness within the same parent category at the database level (`@@unique([name, categoryId])` in Prisma schema)
- [ ] Add `@@index([discountId])` on `Variant` and `Category` models in Prisma schema for discount lookup performance
- [ ] Review and document why `forwardRef` is used anywhere it appears; refactor away if possible
- [ ] Audit all environment variables and ensure every one is declared in the config validation schema (no undeclared `process.env` reads)
- [ ] Add `prisma/seed.ts` idempotency: ensure seed can be re-run without creating duplicates
