# E2E Tests & Security Hardening — Task Tracker

Mark a phase as **done** only when every checkbox within it is ticked.

---

## Phase 1 — Critical Security Fixes
> Fix all CRITICAL and HIGH severity findings before writing any e2e tests. A compromised baseline invalidates test results.

- [ ] **[CRITICAL-1]** Fix Paystack webhook returning HTTP 200 on invalid signature — throw `UnauthorizedException` instead (`payment.service.ts`)
- [ ] **[CRITICAL-2]** Fix Paystack webhook header key case-sensitivity — use lowercase `x-paystack-signature` lookup (`payment.controller.ts`)
- [ ] **[CRITICAL-3]** Implement proper CSP headers in production helmet config — replace `undefined` with explicit directives (`main.ts`)
- [ ] **[CRITICAL-4]** Guard stack traces in exception filter — only log `exception.stack` when `NODE_ENV === 'development'` (`all-exceptions.filter.ts`)
- [ ] **[HIGH-1]** Apply rate limiting to `forgotPassword` and `resetPassword` mutations — max 3 per hour (`authentication.resolver.ts`)
- [ ] **[HIGH-2]** Wrap refresh token rotation (revoke + re-issue) in a Prisma `$transaction` to prevent race-condition double-issuance (`authentication.service.ts`)
- [ ] **[HIGH-3]** Add startup validation for `JWT_SECRET` length (≥ 32 chars) and `JWT_TOKEN_AUDIENCE` / `JWT_TOKEN_ISSUER` non-empty (`main.ts` or `env.validation.ts`)
- [ ] **[HIGH-4]** Explicitly set bcrypt rounds to 12 (`bcrypt.service.ts`)
- [ ] **[HIGH-5]** Disable GraphQL introspection in production (`app.module.ts`)

**Phase 1 complete when:** All 9 items above are ticked ✅

---

## Phase 2 — Medium & Low Security Fixes

- [ ] **[MED-1]** Add HSTS header to helmet config — `maxAge: 31536000, includeSubDomains: true, preload: true` (`main.ts`)
- [ ] **[MED-2]** Lower auth throttle limit from 10/min to 3–5/min (`app.module.ts`)
- [ ] **[MED-3]** Add constant-time delay on `forgotPassword` when user is not found to prevent timing-based user enumeration (`authentication.service.ts`)
- [ ] **[MED-4]** Restrict `addresses` query — `USER` role should only return own addresses; `ADMIN` access should require explicit `userId` param or be `SUPER_ADMIN` only (`addresses.resolver.ts` + `addresses.service.ts`)
- [ ] **[MED-5]** Require `ALLOWED_ORIGINS` env var to be set; remove insecure `http://localhost` defaults from production fallback (`main.ts`)
- [ ] **[MED-6]** Verify `changeUserPassword` service requires and validates `currentPassword` before allowing the change (`users.service.ts`)
- [ ] **[LOW-1]** Add null checks to `sanitizeInitializeDetails` to avoid storing `undefined` payment fields (`payment.service.ts`)

**Phase 2 complete when:** All 7 items above are ticked ✅

---

## Phase 3 — E2E Test Infrastructure Setup

- [ ] Create a dedicated `.env.test` file (or verify it exists) with a separate test database URL(use SQLite database) and test JWT secrets.
- [ ] Verify `test/jest-e2e.json` is configured correctly and the test database can be seeded/reset between test runs
- [ ] Create `test/helpers/app.helper.ts` — bootstraps the NestJS app with `supertest` for e2e tests
- [ ] Create `test/helpers/auth.helper.ts` — utility functions: `signUpUser()`, `signInUser()`, `signInAdmin()`, `signInSuperAdmin()`, `getAuthHeader(token)`
- [ ] Create `test/helpers/db.helper.ts` — utility functions: `resetDb()`, `seedMinimal()` (creates base users, categories, products needed across tests)
- [ ] Create `test/helpers/graphql.helper.ts` — utility: `gqlRequest(query, variables, token?)` wrapping supertest

**Phase 3 complete when:** All 6 items above are ticked ✅

---

## Phase 4 — E2E Tests: Public & Authentication Flows

### Auth Flows (Public)
- [ ] `POST signUp` — success with valid input
- [ ] `POST signUp` — fails with duplicate email (conflict)
- [ ] `POST signUp` — fails with invalid email format / weak password
- [ ] `POST signIn` — success returns access + refresh tokens
- [ ] `POST signIn` — fails with wrong password
- [ ] `POST signIn` — fails with non-existent email
- [ ] `POST refreshToken` — success returns new token pair
- [ ] `POST refreshToken` — fails with invalid/expired/revoked token
- [ ] `POST signOut` — invalidates refresh token; subsequent refresh fails
- [ ] `POST forgotPassword` — returns true for both existing and non-existing emails (no enumeration)
- [ ] `POST resetPassword` — success with valid token
- [ ] `POST resetPassword` — fails with expired token
- [ ] `POST resetPassword` — fails with already-used token
- [ ] `POST signInWithGoogle` — success with valid Google credential
- [ ] `POST signInWithFacebook` — success with valid Facebook token

### Public Catalogue Flows
- [ ] `GET products` — returns paginated product list (no auth required)
- [ ] `GET product` — returns single product by ID (no auth required)
- [ ] `GET categories` — returns all categories (no auth required)
- [ ] `GET brands` — returns all brands (no auth required)
- [ ] `GET brand` — returns single brand by ID (no auth required)

**Phase 4 complete when:** All items above are ticked ✅

---

## Phase 5 — E2E Tests: Authenticated User Flows

### Profile & Account
- [ ] `GET userProfile` — returns authenticated user's profile with relations
- [ ] `PATCH updateMyProfile` — success with valid input
- [ ] `PATCH changeUserPassword` — success with correct `currentPassword`
- [ ] `PATCH changeUserPassword` — fails with wrong `currentPassword`

### Address Management
- [ ] `POST createAddress` — success
- [ ] `GET userAddresses` — returns only own addresses
- [ ] `PATCH updateAddress` — success on own address
- [ ] `PATCH updateAddress` — fails on another user's address
- [ ] `DELETE deleteAddress` — success on own address

### Wishlist
- [ ] `GET wishlist` — auto-creates wishlist if none exists
- [ ] `POST addToWishlist` — success with valid productId
- [ ] `POST addToWishlist` — fails with non-existent productId
- [ ] `DELETE removeFromWishlist` — removes product from wishlist
- [ ] `DELETE clearWishlist` — empties wishlist

### Cart & Shopping
- [ ] `GET cart` — returns user's cart (empty on first access)
- [ ] `POST addToCart` — success with valid productId + quantity
- [ ] `POST addToCart` — fails when product is out of stock
- [ ] `POST addToCart` — fails with non-existent productId
- [ ] `PATCH updateCartItem` — success changing quantity
- [ ] `DELETE removeFromCart` — removes item
- [ ] `DELETE clearCart` — empties cart
- [ ] `GET cartWithDiscount` — applies active discount to cart items

### Reviews
- [ ] `POST createReview` — success on a product
- [ ] `POST createReview` — fails if user already reviewed the same product
- [ ] `GET productReviews` — returns all reviews for a product
- [ ] `GET userReviews` — returns own reviews
- [ ] `PATCH updateReview` — success on own review
- [ ] `PATCH updateReview` — fails on another user's review
- [ ] `DELETE deleteReview` — success on own review

### Coupons
- [ ] `POST validateCoupon` — success with valid, active coupon
- [ ] `POST validateCoupon` — fails with expired coupon
- [ ] `POST validateCoupon` — fails with inactive coupon
- [ ] `POST validateCoupon` — fails when usage limit reached
- [ ] `POST validateCoupon` — fails when order total below minimum
- [ ] `POST validateCoupon` — fails if user already used coupon

### Orders
- [ ] `POST createOrder` — success from populated cart with valid address
- [ ] `POST createOrder` — fails with empty cart
- [ ] `POST createOrder` — fails with invalid address
- [ ] `POST createOrder` — decrements product stock on success
- [ ] `POST createOrder` — applies coupon discount when provided
- [ ] `GET userOrders` — returns own orders
- [ ] `GET order` — returns single own order
- [ ] `GET order` — fails when trying to access another user's order
- [ ] `POST cancelOrder` — success on PENDING order; restores stock
- [ ] `POST cancelOrder` — fails on DELIVERED order
- [ ] `POST finalizeOrder` — applies discount pricing to order items

### Payments
- [ ] `POST /payment/initialize` — success returns Paystack checkout URL
- [ ] `POST verifyPayment` — success with valid Paystack reference
- [ ] `GET getMyPayments` — returns own payment records
- [ ] `GET payment` — returns own payment by ID
- [ ] `GET payment` — fails on another user's payment
- [ ] `GET /payment/webhook` — Paystack callback with valid signature updates order status
- [ ] `GET /payment/webhook` — fails silently / returns 401 on invalid signature

### Returns
- [ ] `POST createReturnRequest` — success on DELIVERED order
- [ ] `POST createReturnRequest` — fails on PENDING order
- [ ] `POST createReturnRequest` — fails if active request already exists
- [ ] `GET myReturnRequests` — returns own return requests

**Phase 5 complete when:** All items above are ticked ✅

---

## Phase 6 — E2E Tests: Admin Flows

### User Management
- [ ] `GET users` — admin can list all users (paginated)
- [ ] `GET userById` — admin can lookup any user
- [ ] `PATCH updateUser` — admin can update any user's profile
- [ ] `DELETE archiveUser` — admin can soft-delete a user
- [ ] `POST deArchiveUser` — admin can restore archived user
- [ ] `DELETE removeUser` — admin can hard delete a user

### Product & Catalogue Management
- [ ] `POST createProduct` — success with valid input and images
- [ ] `POST createProduct` — fails with duplicate SKU
- [ ] `PATCH updateProduct` — success
- [ ] `POST archiveProduct` — soft-deletes product
- [ ] `POST restoreProduct` — restores archived product
- [ ] `DELETE permanentlyDeleteProduct` — hard deletes
- [ ] `POST addTagToProduct` — success
- [ ] `DELETE removeTagFromProduct` — success
- [ ] `POST createCategory` — success
- [ ] `PATCH updateCategory` — success
- [ ] `DELETE removeCategory` — success
- [ ] `POST createSubCategory` — success
- [ ] `PATCH updateSubCategory` — success
- [ ] `DELETE removeSubCategory` — success
- [ ] `POST createBrand` — success
- [ ] `PATCH updateBrand` — success
- [ ] `DELETE deleteBrand` — success
- [ ] `POST createTag` — success
- [ ] `PATCH updateTag` — success
- [ ] `DELETE deleteTag` — success
- [ ] `POST createVariant` — success for a product
- [ ] `PATCH updateVariant` — success
- [ ] `DELETE deleteVariant` — success

### Discount Management
- [ ] `POST createDiscount` — success with valid date range and type
- [ ] `POST createDiscount` — fails with invalid product/variant/category IDs
- [ ] `PATCH updateDiscount` — success
- [ ] `POST addToDiscount` — adds products/variants/categories to discount
- [ ] `POST removeFromDiscount` — removes items from discount
- [ ] `DELETE removeDiscount` — success

### Coupon Management
- [ ] `POST createCoupon` — success, code auto-uppercased
- [ ] `POST createCoupon` — fails with duplicate code
- [ ] `PATCH updateCoupon` — success
- [ ] `DELETE deleteCoupon` — success
- [ ] `GET coupons` — returns all coupons
- [ ] `GET coupon` — returns single coupon

### Order & Payment Admin
- [ ] `GET orders` — admin can list all orders
- [ ] `GET viewOrder` — admin can view any order by ID
- [ ] `POST updateShipping` — admin updates tracking number and carrier
- [ ] `POST updateOrderStatus` — admin changes order status
- [ ] `DELETE deleteOrder` — admin soft deletes order
- [ ] `GET getUserPayment` — admin can view any user's payments
- [ ] `DELETE softDeletePayment` — admin soft deletes payment
- [ ] `POST restorePayment` — admin restores payment
- [ ] `DELETE removePayment` — admin hard deletes payment

### Returns Admin
- [ ] `POST approveReturn` — admin approves PENDING return request
- [ ] `POST approveReturn` — fails on already-approved request
- [ ] `POST rejectReturn` — admin rejects PENDING return request
- [ ] `POST processRefund` — admin processes refund for APPROVED return (mocked Paystack call)
- [ ] `GET returnRequests` — admin lists all return requests

### Inventory Admin
- [ ] `POST restockProduct` — increments product stock and logs change
- [ ] `POST restockProduct` — fails for non-existent product
- [ ] `POST restockVariant` — increments variant stock and logs change
- [ ] `GET productInventoryLogs` — returns logs for product
- [ ] `GET variantInventoryLogs` — returns logs for variant

### Tax Admin
- [ ] `POST createTaxRate` — success
- [ ] `POST createTaxRate` — fails with duplicate country+region
- [ ] `PATCH updateTaxRate` — success
- [ ] `DELETE deleteTaxRate` — success
- [ ] `GET taxRates` — returns all tax rates

### Analytics Admin
- [ ] `GET salesReport` — returns sales totals for date range
- [ ] `GET topProducts` — returns top N selling products
- [ ] `GET revenueByCategory` — returns revenue grouped by category
- [ ] `GET dashboardSummary` — returns today's metrics

**Phase 6 complete when:** All items above are ticked ✅

---

## Phase 7 — E2E Tests: Super Admin Flows

- [ ] `POST createUser` — super admin can create a user directly with a role
- [ ] `GET userByEmail` — super admin lookup by email
- [ ] `GET userByProviderId` — super admin lookup by OAuth provider ID
- [ ] Verify all ADMIN-level operations above are also accessible to super admin
- [ ] Verify USER-level operations (`updateMyProfile`, `changeUserPassword`) are accessible to super admin acting as themselves
- [ ] Verify a super admin **cannot** be deleted by a regular admin (role hierarchy enforcement)

**Phase 7 complete when:** All items above are ticked ✅

---

## Phase 8 — E2E Tests: Authorization Boundary Tests

> These tests verify that roles are **enforced** — no privilege escalation.

- [ ] Unauthenticated request to `cart` returns 401
- [ ] Unauthenticated request to `createOrder` returns 401
- [ ] USER role attempting `createProduct` returns 403
- [ ] USER role attempting `orders` (admin list) returns 403
- [ ] USER role attempting `updateOrderStatus` returns 403
- [ ] USER role attempting `createDiscount` returns 403
- [ ] USER role attempting `approveReturn` returns 403
- [ ] USER role attempting `restockProduct` returns 403
- [ ] USER role attempting `dashboardSummary` returns 403
- [ ] ADMIN role attempting `createUser` (super admin only) returns 403
- [ ] ADMIN role attempting to access another user's `payment` returns 403
- [ ] Attempting to `updateReview` on another user's review returns 403
- [ ] Attempting `deleteAddress` on another user's address returns 403
- [ ] Expired JWT token returns 401 on any protected query
- [ ] Tampered JWT signature returns 401

**Phase 8 complete when:** All items above are ticked ✅

---

## Phase 9 — CI Integration & Coverage Gate

- [ ] Add e2e test script to `package.json` using the `.env.test` database
- [ ] Ensure unit test coverage stays ≥ 90% (`npm run test:cov` passes gate)
- [ ] Ensure e2e tests run against a clean database on each CI run (reset before suite)
- [ ] Add GitHub Actions (or equivalent CI) workflow step that runs both unit and e2e tests on every PR
- [ ] Document e2e setup steps in `README.md` (env vars needed, how to run locally)

**Phase 9 complete when:** All items above are ticked ✅

---

## Quick Reference: Severity Index

| ID | Finding | Severity | Phase |
|----|---------|----------|-------|
| CRITICAL-1 | Webhook returns 200 on bad signature | CRITICAL | 1 |
| CRITICAL-2 | Webhook header case mismatch | CRITICAL | 1 |
| CRITICAL-3 | CSP disabled in production | CRITICAL | 1 |
| CRITICAL-4 | Stack traces exposed in logs | CRITICAL | 1 |
| HIGH-1 | No rate limit on password reset | HIGH | 1 |
| HIGH-2 | Refresh token rotation not atomic | HIGH | 1 |
| HIGH-3 | No JWT secret startup validation | HIGH | 1 |
| HIGH-4 | Bcrypt rounds not explicit | HIGH | 1 |
| HIGH-5 | GraphQL introspection enabled in prod | HIGH | 1 |
| MED-1 | No HSTS header | MEDIUM | 2 |
| MED-2 | Auth throttle too permissive | MEDIUM | 2 |
| MED-3 | Timing attack on forgotPassword | MEDIUM | 2 |
| MED-4 | Users can query all addresses | MEDIUM | 2 |
| MED-5 | Unsafe CORS defaults | MEDIUM | 2 |
| MED-6 | Password change skips old password check | MEDIUM | 2 |
| LOW-1 | Payment details missing null checks | LOW | 2 |
