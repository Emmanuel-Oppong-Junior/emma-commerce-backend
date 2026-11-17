# 06 - Docs vs Code Discrepancies

> **Orchestrator note (final):** I verified DOC-08 by repro test (sign-in rejects passwords over 16 characters) and DOC-10 by reading `users.repository.ts:122-138`. The reviewer confirmed that `schema.gql` matches the code by regenerating it outside the repo. I removed the scratch build artefacts that step left in `dist/`.

Reviewed by: Docs-vs-Code reviewer, Sonnet 5.5. Date: 2026-11-16. Read-only audit.

Documents audited (working-tree versions): `FRONTEND_API_DOCUMENTATION.md` (3,967 lines, every documented operation), `README.md`, `CLAUDE.md`, `TODO.md` (removed from git on 2026-11-16; local copy at `tmp/TODO.md`).
Truth sources: `src/**`, `prisma/schema.prisma`, `schema.gql`, `test/**`, git history.

Method notes:
- `schema.gql` was regenerated from the 22 resolver classes with `GraphQLSchemaFactory` (scratch script, no DB, no repo files left behind) and compared structurally. **Result: identical.** `schema.gql` is current: 56 queries + 89 mutations = 145 operations, matching all 145 `@Query`/`@Mutation` decorators in `src/**/*.resolver.ts`. All findings below are therefore doc-vs-code, not stale-schema.
- Confirmation labels: **CR** = confirmed by reading the full path, **CC** = confirmed by command output (schema diff, baseline tsc/jest), **S** = suspected.
- I did NOT run any e2e suite: `ConfigModule.forRoot()` and Prisma both fall back to `.env`, so running them without `.env.test` could wipe the database named in `.env` (see DOC-11).

## Summary

| Severity | Count |
|---|---|
| High | 12 |
| Medium | 17 |
| Low | 11 |
| Total | 40 |

Headline: the frontend document is materially wrong in the places a frontend developer touches first (checkout, product creation, user listing, error handling, tax, payment redirect). Five of the 12 High items would produce a broken request on the first attempt. TODO.md contains at least two security items marked done that are not (MED-3, HIGH-2) and its e2e phases are marked complete although the suites cannot compile or run against the current schema.

## Discrepancy table

### High

| ID | Document + line | What the doc says | What the code does | Sev | Fix |
|---|---|---|---|---|---|
| DOC-01 | FRONTEND_API_DOCUMENTATION.md:1199-1206, 2742, 3816-3829 | `createOrder(input: { shippingAddressId, couponCode? })`; order is always created from an address with tax applied. | `CreateOrderInput` requires `contactEmail`, `contactPhone`, `fulfillmentType` (DELIVERY or PICKUP); also `pickupLocationId`, `paymentMethod` (ONLINE default, CASH_ON_DELIVERY); `shippingAddressId` is only required for DELIVERY. `src/order/dto/create-order.input.ts:6-45`, `schema.gql:245`, `src/order/order.service.ts:60-120`. Following the doc fails GraphQL validation ("field required"). CR/CC. | High | Fix doc (rewrite createOrder, Order type, checkout flow, section 6/7/19 examples). Also document shipping fee by city. |
| DOC-02 | :349-382 (`usersConnection`) | Query `usersConnection` taking `UserPaginateArgs`. | Operation is `users(filter: UserPaginateArgs!): UserConnection!`. `src/users/users.resolver.ts:37`, `schema.gql:1275`. `usersConnection` does not exist. CC. | High | Fix doc. |
| DOC-03 | :596-609 (`CreateProductInput`) | `price: string` required; `isActive` default false; `categoryId?` "Required". | Field is `basePrice: String!` (no `price` input field; `price` is computed server-side as basePrice x (1 + sum of active tax rates) when `isTaxable`). Extra fields undocumented: `isTaxable`, `currency`, `stockStatus`, `status`, `barcode`, `lowStockAlert`, `deliveryOptions`, `selectedDeliveryRegions`, `shortDescription`, `attachments`, `expiryDate`. `src/products/dto/create-product.input.ts`, `src/products/products.service.ts:100-105`, `schema.gql` `CreateProductInput`. With `forbidNonWhitelisted` an unknown `price` is rejected. CC. | High | Fix doc. |
| DOC-04 | :1728-1740, 2785 (`UpdateReviewInput`) | `{ reviewId, score?, comment? }`. | `UpdateReviewInput` key is `id` (also accepts `productId`). `schema.gql:1660`. Following the doc fails validation. CC. | High | Fix doc. |
| DOC-05 | :1752-1804 (Tax ops), :2580-2596 (TaxRate model), :2972-2979 (calculation), :1212, :2743 | Ops `taxRates`, `taxRate`, `createTaxRate`, `updateTaxRate`, `deleteTaxRate`; `TaxRate{country, region, rate}` unique on (country, region); at `createOrder` the tax is looked up from the shipping country and added to `totalAmount`. | Ops are `taxes`, `tax`, `createTax`, `updateTax`, `deleteTax` over `Tax{name unique, rate, isActive}` (no country/region); `TaxRate` table dropped in migration `20260413212251_drop_tax_rate_and_created_tax_table`. Tax is NOT applied in `createOrder` (`order.service.ts:290-314` adds subtotal + shipping fee - coupon only). The only use is `ProductsService.computePrice` (`products.service.ts:100-105`): taxable product `price = basePrice x (1 + totalActiveRate)` at product create/update. `src/tax/tax.resolver.ts`, `prisma/schema.prisma` model `Tax`. CR. | High | Fix doc (whole section 2.18, model, section 11). Decide whether country-based tax at checkout is still intended (product call). |
| DOC-06 | :3033-3043 (error code table), :178-330 (per-op `Possible Errors`), :3069-3109 (samples), :3459, :3475 (Apollo `onError` / refresh strategy) | `401 -> UNAUTHENTICATED`, `403 -> FORBIDDEN`, `404 -> NOT_FOUND`, `409 -> CONFLICT`, `400 -> BAD_REQUEST`, only validation -> `BAD_USER_INPUT`. Frontend should refresh the token on `UNAUTHENTICATED`. | `AllExceptionsFilter` rethrows every HttpException below 500 as `extensions.code = 'BAD_USER_INPUT'` plus `extensions.status` (the HTTP status); only >=500 gets `INTERNAL_SERVER_ERROR`. No other code is ever emitted. `src/commons/filters/all-exceptions.filter.ts:27-29` (registered via `main.ts:65`). The documented refresh-on-UNAUTHENTICATED interceptor never fires, so sessions silently stop refreshing; clients also cannot tell 401/403/404/409 apart except via `extensions.status`. No test asserts a code. CR. | High | Prefer fixing code (map status -> `UNAUTHENTICATED`/`FORBIDDEN`/`NOT_FOUND`/`CONFLICT`/`BAD_REQUEST`; the formatter's whitelist at `grapqhl-error.formatter.ts:9` already expects them). Until then fix doc to say "switch on `extensions.status`". **Status: Fixed in c3000bf (P0-A.4): `AllExceptionsFilter` now emits BAD_REQUEST/UNAUTHENTICATED/FORBIDDEN/NOT_FOUND/CONFLICT, ValidationPipe failures BAD_USER_INPUT; docs table updated.** |
| DOC-07 | :1987-2002, 2752, 2856, 3883 | `GET /payment/callback?reference=` exists (returns Payment); Paystack redirects the user there. | No such route. `PaymentController` has only `POST /payment/initialize` and `POST /payment/webhook` (`src/payment/payment.controller.ts:15-29`); the callback controller was removed in commit `29c0193` "removed verifyPayment controller". The redirect target is whatever `PAYSTACK_CALLBACK_URL` points to (a frontend page) and is passed as `callback_url` (`payment.service.ts:277`). A frontend that points Paystack at the backend gets a 404. CR. | High | Fix doc: callback is a frontend route; frontend calls `verifyPayment`. |
| DOC-08 | :153-156 vs :193-195, :428-430 | Sign-up password 8-64 chars; sign-in password 8-16 chars; change-password 8-16. Presented as independent facts. | Consistent with the DTOs, but together they are a trap and a real bug: `SignUpInput` accepts 8-64 (`sign-up.input.ts:Length(8,64)`) while `SignInInput` rejects anything over 16 (`sign-in.input.ts:Length(8,16)`). A user who registers with a 17-64 char password can never sign in. Reset-password accepts any length >= 8 with no complexity (`reset-password.input.ts`). CR. | High | Fix code: drop the max on `SignInInput` (never length-validate login), align change/reset-password rules with sign-up; then update doc. **Status: Fixed in d2445ad (P0-I.1): password rule unified and documented.** |
| DOC-09 | TODO.md:31 (MED-3) | "[x] Add constant-time delay on `forgotPassword` when user is not found". | No delay exists: `authentication.service.ts:140-142` is `if (!user) return true;` while the found path does DB write + JWT + email. The unit test at `authentication.service.spec.ts:272-285` still says "(constant-time path)" and uses fake timers for "200ms delay" that no longer exists, so it passes while testing nothing. Timing-based user enumeration is open. CR. | High (false security claim) | Fix code (equalise work or enqueue async) and fix/replace the test; re-open the TODO item. **Status: Fixed in d11e961 (P0-I.6).** |
| DOC-10 | TODO.md:16 (HIGH-2) | "[x] Wrap refresh token rotation in a `$transaction` to prevent race-condition double-issuance". | A transaction exists (`users.repository.ts:122-138`) but it does not prevent the race: `refreshToken()` reads `storedToken` outside the transaction (`authentication.service.ts:95-99`), then `update({where:{tokenHash}, data:{revoked:true}})` succeeds for both concurrent callers (no `revoked:false` precondition, no row-count check) and each `create`s its own new token. Two concurrent refreshes with the same token both receive valid pairs. CR (concurrency not executed). | High (security claim ineffective) | Fix code: `updateMany({where:{tokenHash, revoked:false}})`, abort unless count === 1, inside an interactive transaction; add a concurrent-refresh test. **Status: Fixed in dfac978 (P0-I.2): rotation is now genuinely race-free (conditional update in the transaction).** |
| DOC-11 | TODO.md:40-42 (Phase 3), CLAUDE.md "Testing" + `test:e2e` comment, README.md:36-38 | `.env.test` created with an SQLite test DB; reset/seed helpers verified; e2e isolated on "separate .env.test DB". | (a) `.env.test` does not exist (gitignored, never created); SQLite is impossible: `prisma/schema.prisma` datasource is `postgresql`. (b) `test/helpers/db.helper.ts:49` calls `prisma.taxRate` which no longer exists, so `tsc` fails (baseline) and ts-jest fails every suite importing it (8 of 13 e2e files: auth, cart, catalogue, order, payment-return, review-coupon, user-account, wishlist). (c) `test/setup.ts` only runs `dotenv.config({path:'.env.test'})`; there is no guard that the DB URL is a test DB. If `.env.test` is absent, `ConfigModule` and Prisma fall back to `.env`, and `resetDb`/`clearDatabase` (`deleteMany` on every table) run against whatever `.env` points to. (d) README has no e2e instructions at all. CR + CC (tsc baseline). | High (data-loss risk + false "done") | Fix code: assert `DATABASE_URL` contains a test marker in `test/setup.ts` before any `deleteMany`; fix `db.helper.ts`; correct TODO Phase 3; document setup in README. **Status: (b) and (c) fixed in 758068c (P0-F.2); (a) `.env.test.example` added, CLAUDE.md updated; TODO.md retired; README e2e instructions still missing.** |
| DOC-12 | TODO.md:51-158 (Phases 4-5 all `[x]`) | Every listed e2e test is done. | Several claimed tests are absent, commented out, mocked away, or stale. See "TODO.md claims" section (e2e). Key ones: `refreshToken` success test is commented out (`auth.e2e-spec.ts:168-199`); standalone `signOut` test commented out (`:259-299`); every `createOrder` in `order.e2e-spec.ts` (69, 98, 117, 140, 263, 294, 328, 363) and `payment-return.e2e-spec.ts:44` omits the now-required `contactEmail`/`contactPhone`/`fulfillmentType` and cannot pass; "webhook with valid signature updates order status" only sends an irrelevant `transfer.success` event (`payment-return...:320-337`); `verifyPayment` test replaces `PaymentService` with a mock (`:143-190`); Google/Facebook tests mock the auth services wholesale. CR. | High (false completion claims) | Fix tests, then re-tick; or untick the items now. **Status: commented-out refresh/signOut e2e restored and `createOrder` specs updated in 9b3747b (P0-F.7); e2e runs in CI.** |

### Medium

| ID | Document + line | What the doc says | What the code does | Sev | Fix |
|---|---|---|---|---|---|
| DOC-13 | TODO.md:13, CLAUDE.md "Commons" ("stack traces are logged only in development") | CRITICAL-4 fixed: stack traces only in development. | True for `AllExceptionsFilter` (`all-exceptions.filter.ts:19-20`) but `formatError` still logs `error.stack` for every GraphQL error in every environment (`grapqhl-error.formatter.ts:17-22`). Also relies on raw `process.env.NODE_ENV`; Joi's `default('development')` is not written back to `process.env`, so an unset `NODE_ENV` behaves as non-production (introspection on, HSTS/CSP off). Dockerfile sets `NODE_ENV=production`, so containers are fine. CR. | Medium | Fix code (gate the formatter stack too) or soften the claim. |
| DOC-14 | CLAUDE.md (Supporting modules, Env vars), FRONTEND doc :83, :116-119, :3401-3407 | OpenTelemetry tracing enabled via `OTEL_ENABLED`; `OTEL_*` listed under variables "validated at startup by env.validation.ts". | `src/tracing.ts` is never imported (grep of `src/`, `package.json`, `nest-cli.json`, `Dockerfile`: no references; `main.ts` starts with NestFactory), so setting `OTEL_ENABLED=true` does nothing. `OTEL_*` are absent from `src/config/env.validation.ts` (Joi lets unknown keys through, so nothing fails, but they are not validated). CR. | Medium | Fix code (first import in `main.ts`) or remove the claim; add vars to Joi if kept. |
| DOC-15 | FRONTEND :1227-1233 (`cancelOrder`) | Roles USER, ADMIN, SUPER_ADMIN. | `@Roles(Role.USER)` only (`src/order/order.resolver.ts:95`); admins must use `adminCancelOrder` (undocumented, `:104`). An ADMIN token calling `cancelOrder` gets 403. CR. | Medium | Fix doc. |
| DOC-16 | :1744-1750 (`deleteReview`), :2786 | Roles USER, ADMIN, SUPER_ADMIN; soft-delete (`deleted=true`). | `@Roles(Role.USER)` (`review.resolver.ts:70`); admins use undocumented `adminDeleteReview`. Deletion is a hard `prisma.review.delete` (`review.repository.ts:78-80`); the `deleted`/`deletedAt` columns exist but are never read or set. CR. | Medium | Fix doc (or fix code to soft-delete). |
| DOC-17 | :1448-1451 (`discount`) | `discount` returns `[Discount!]!`. | `discounts: [Discount!]!` (list) and `discount(id: ID!): Discount!` (single) are separate ops (`discount.resolver.ts:21,27`). `removeDiscount` arg is `id: ID!` not `String!` (doc :1515). CC. | Medium | Fix doc. |
| DOC-18 | :3160-3162, :475-483, :2716 | Products can be sorted via `orderBy`/`orderInAsc` in `PaginationArgs`. | For `products`, `orderBy`/`orderInAsc` are ignored (`products.service.ts:125-128` only reads `first`/`after`). Sorting is via undocumented `sortArgs: ProductSortArgs { sortBy: CREATED_AT|NAME|PRICE|QUANTITY|UPDATED_AT, sortOrder: ASC|DESC }`, default CREATED_AT DESC (`products.service.ts:223-226`, `schema.gql` `ProductSortArgs`). Users do honour `orderBy` (validated whitelist, `users.service.ts:108-125`). CR. | Medium | Fix doc. |
| DOC-19 | :1634, :1655, :2779, :2910 | `approveReturn` restores stock + inventory log; `processRefund` only flips status, "refund disbursement handled externally". | `approveReturn` only sets status/refundAmount (`returns.service.ts:58-63`). `processRefund` calls the Paystack refund API (`:135-150`) and restores stock inside a transaction (`:104-115`). TODO.md:228 also says "mocked Paystack call". CR. | Medium | Fix doc. |
| DOC-20 | :2790-2830, :2929, :2743 | New orders are `PENDING`; abandoned orders are never auto-cancelled ("stock not automatically restored"). | COD orders start `PROCESSING` (`order.service.ts:~375`); `recordCodPayment` (undocumented) marks payment COMPLETED and order DELIVERED (`payment.service.ts:133-160`); an hourly cron cancels `PENDING` ONLINE orders with no payment after 1 h and restores stock (`order/tasks/expired-orders.task.ts:6,15`, `order.repository.ts:165-176`). Cancelling already-CANCELLED orders is not blocked (`order.service.ts:~385 ensureOrderCanBeCancelled` only blocks SHIPPED/DELIVERED), so stock can be restored twice. CR. | Medium | Fix doc; fix the double-restore in code. |
| DOC-21 | :2010, :2877, :2762 | Signature is HMAC-SHA512 of the **raw body**. | Code hashes `JSON.stringify(parsedBody)` (`payment.service.ts:389-392`), not the raw bytes (no `rawBody` anywhere in `src/`), and compares with `===` (non-constant-time, `:380`). A legitimately signed Paystack event can fail if re-serialisation differs (key order, whitespace, number/unicode formatting) and be answered with 401; the e2e test builds the signature with the same `JSON.stringify`, so it cannot detect this. TODO CRITICAL-1/-2 claims themselves are true (see below). CR. | Medium | Fix code (enable `rawBody`, `timingSafeEqual`) then doc. |
| DOC-22 | :3250 | Payment webhook success sends a payment-confirmation email. | `NotificationsService.sendPaymentConfirmation` is defined (`notifications.service.ts:44`) but has zero callers in `src/`. No such email is sent. CR. | Medium | Fix code or remove from doc. |
| DOC-23 | :638 | `archiveProduct` sets `status = ARCHIVED, isActive = false`; `restoreProduct` sets `PUBLISHED, true`. | Both only toggle `isActive` (`products.service.ts:90-98`); `status` is untouched. CR. | Medium | Fix doc or code. |
| DOC-24 | :2968 | Multiple discounts: "the first matching discount, product then variant then category". | The service picks the **best** (highest value; ties favour PERCENTAGE) (`discount.service.ts:180, 258-266`). Also order prices come from `product.price`, not the discounted price, until `finalizeOrder` is called (`order.service.ts:316-327`). CR. | Medium | Fix doc. |
| DOC-25 | :1007, :2769, :2904, :3574 (variant in `CartItemFull`) | Variant quantity is decremented on order; cart can reference a variant. | `AddToCartInput` has no `variantId` (`cart/dto/add-to-cart.input.ts`); `createOrderItems` builds items without `variantId` and stock is decremented on the product only (`order.service.ts:316-327, 355-364`). Variants cannot be purchased or reserved. Doc :1007 half-admits "check the cart service". CR. | Medium | Fix doc now; product decision on variant purchase. |
| DOC-26 | CLAUDE.md "Environment variables" | `env.validation.ts` validates the list; "see `.env.example` for the full list". | `.env.example` omits `JWT_RESET_SECRET` (required by Joi, `env.validation.ts:47`), `JWT_RESET_TOKEN_TTL`, `RESEND_*`, `OTEL_*`. Copying it yields a boot failure. `NODE_ENV` is restricted to development/production/test. `ALLOWED_ORIGINS` "required in production" is enforced in `main.ts:42-51`, not in Joi (so AppModule-level tests bypass it). CR. | Medium | Fix `.env.example`; clarify doc. |
| DOC-27 | :2083-2612 (Prisma models) | Models match code. | Drift (script-compared): `Order` lacks `orderNumber, fulfillmentType, paymentMethod, contactEmail, contactPhone, pickupLocationId, pickupLocation, shippingAddress, coupon, user` and `shippingAddressId` is nullable; `Product` documents non-existent `taxRate` and omits `basePrice`; `TaxRate` is `Tax`; `PickupLocation` and `ShippingZone` models missing; `Variant`/`Review`/`Discount` omit `createdAt/updatedAt`. Header claim ":3 Generated from actual source code" is not true. `prisma/schema.prisma`. CC. | Medium | Fix doc (regenerate from schema). |
| DOC-28 | TODO.md:168-308 (unchecked Phases 6-9) | Test specs for remaining work. | Several expectations are wrong and would encode false behaviour: `createTaxRate`/`updateTaxRate`/`deleteTaxRate`/`taxRates` and "fails with duplicate country+region" (DOC-05); "ADMIN accessing another user's `payment` returns 403" (admins may read any payment; a non-owner USER gets `UnauthorizedException` 401, `payment.service.ts:100-110`); "`updateReview` on another user's review returns 403" (it is `BadRequestException` 400, `review.service.ts:103-106`); "`deleteAddress` on another user's address returns 403" (it is NotFound, `addresses.service.ts:86-90`); "GET /payment/webhook" is POST; Phase 7 "admin ops accessible to super admin" fails for ADMIN-only ops: `getUserPayment`, `softDeletePayment`, `restorePayment`, `removePayment` (`payment.resolver.ts:31,56,62,68`) and `updateSubCategory`/`removeSubCategory` (`sub-categories.resolver.ts:53,72`, method-level `@Roles(Role.ADMIN)` overrides the class-level decorator). CR. | Medium | Fix TODO text; fix the role decorators if SUPER_ADMIN should pass. |
| DOC-29 | :1313 | `Payment.paymentDetails: string`, "JSON string with full Paystack response". | GraphQL type is `JSON` (`schema.gql` `Payment.paymentDetails: JSON`) and only sanitised fields are stored (`reference, access_code` / `reference, status, amount, currency, channel, paid_at, gateway_response`; `payment.service.ts:312-333`). CR. | Medium | Fix doc. |

### Low

| ID | Document + line | What the doc says | What the code does | Sev | Fix |
|---|---|---|---|---|---|
| DOC-30 | :376-381, :512-517, :3130-3138, :3609-3613 | `PageInfo { hasNextPage, hasPreviousPage, pageSize }`. | Also `totalCount: Int!` (`commons/entities/pageInfo.entity.ts`, populated in `products.service.ts:230-245`). | Low | Fix doc. |
| DOC-31 | :1365, :1311, :1545, :1611 | Enum names `DiscountType`, `ReturnStatus`, `InventoryAction`. | `Coupon.discountType` is `DiscountTypeEnum` (distinct from `Discount.type: DiscountType`); `ReturnStatusEnum`, `InventoryActionEnum`, `Currency` etc. Matters only for typed variables/codegen. `schema.gql`. | Low | Fix doc. |
| DOC-32 | :603, :1003 | `quantity` "Positive integer" for product; `categoryId?` marked "Required". | `Min(0)` allowed (`create-product.input.ts`); `categoryId` is optional. `Variant.quantity`/`OrderItem.quantity` are `Float!` in GraphQL (`schema.gql`), though documented as number. | Low | Fix doc. |
| DOC-33 | :2074-2077 | `GET /health` returns DB, Redis, Cloudinary status. | `/health` checks DB only; Redis+Cloudinary are in `GET /health/ready`; `GET /health/live` undocumented (`health.controller.ts:20-37`). | Low | Fix doc. |
| DOC-34 | CLAUDE.md "Architecture" | "REST endpoints exist only for payment webhooks". | Also `POST /payment/initialize`, `POST /upload/single-image`, `POST /upload/multiple-images`, `GET /health*`, `GET /`. | Low | Fix doc. |
| DOC-35 | CLAUDE.md "Module structure" | Service "calls Prisma directly". | Almost every feature module has a `*.repository.ts` and its service does not import `PrismaService`; only analytics (and partly inventory, returns, tax) use Prisma from the service. The frontend doc (:60) correctly lists `feature.repository.ts`. | Low | Fix doc. |
| DOC-36 | FRONTEND :91 | Playground off in production; Apollo Sandbox only in development. | `ApolloServerPluginLandingPageLocalDefault()` is registered unconditionally (`app.module.ts:98`), so the landing page is served in production too (introspection off, so little exposure). | Low | Fix doc or gate the plugin. |
| DOC-37 | `authentication.resolver.ts:60` description vs :249-255 | Doc: Google OAuth **access token**. | Doc is right (`google-authentication.service.ts` calls `tokeninfo?access_token=`); the resolver's GraphQL description says "Google ID token". | Low | Fix code description. |
| DOC-38 | :340-347 (`createUser`), :349 (list) | Plain create/list. | `createUserByCredentials` rejects role SUPER_ADMIN (`users.service.ts:24-26`); `users` never returns SUPER_ADMIN rows (`:132`); `updateUser`/`removeUser`/`archiveUser`/`deArchiveUser` refuse super admin targets (`:293-297`); `createUser.password` is optional in the DTO but is hashed with `password!` (undefined -> runtime error). | Low | Fix doc; fix DTO (required). |
| DOC-39 | README.md (whole file) | n/a | Unmodified Nest starter: no mention of Prisma, `.env`, Redis, Paystack, seeding, e2e prerequisites, or the GraphQL endpoint. TODO.md:298 (document e2e setup in README) is open. | Low | Write a project README. |
| DOC-40 | TODO.md:31 (MED-6) / :86 | Uses `currentPassword`; "`changeUserPassword` ... `currentPassword` (`oldPassword`)". | Input field is `oldPassword` (`change-user-password.input.ts`); `changePassword` verifies it (`users.service.ts:39-47`) so MED-6 is true. Tests use `oldPassword`. | Low | Fix TODO wording. |

## Undocumented operations (exist in `schema.gql`, absent from FRONTEND_API_DOCUMENTATION.md)

Auth note: roles are exact-membership (`RolesGuard` uses `getAllAndOverride` + `some`; there is no hierarchy).

Queries (14): `activePickupLocations` (public), `activeShippingZones` (public), `getShippingFee(addressId)` (USER/ADMIN/SUPER_ADMIN), `pickupLocations` (ADMIN/SUPER_ADMIN), `shippingZones`, `shippingZone(id)` (ADMIN/SUPER_ADMIN), `discounts` (ADMIN/SUPER_ADMIN), `inventoryLogs` (ADMIN/SUPER_ADMIN), `payments` (ADMIN/SUPER_ADMIN), `tax(id)`, `taxes` (ADMIN/SUPER_ADMIN; doc has `taxRate(s)` instead), `userByProviderId` (ADMIN/SUPER_ADMIN), `userProfile` (all roles; used by the e2e tests but not documented), `users` (documented under the wrong name `usersConnection`).

Mutations (18): `adminCancelOrder`, `adminDeleteReview`, `recordCodPayment` (ADMIN/SUPER_ADMIN), `archiveUser`, `deArchiveUser`, `updateUser` (ADMIN/SUPER_ADMIN), `createPickupLocation`, `updatePickupLocation`, `deletePickupLocation`, `createShippingZone`, `updateShippingZone`, `deleteShippingZone` (ADMIN/SUPER_ADMIN), `createTax`, `updateTax`, `deleteTax` (ADMIN/SUPER_ADMIN; doc has `*TaxRate`), `updateSubCategory`, `removeSubCategory` (method-level `Role.ADMIN` only; SUPER_ADMIN is excluded by the method decorator overriding the class decorator).

Documented but non-existent: `usersConnection`, `taxRates`, `taxRate`, `createTaxRate`, `updateTaxRate`, `deleteTaxRate`, REST `GET /payment/callback`.

Other schema observations (not doc problems): `SubCategory.category` is typed `SubCategory` instead of `Category` (`schema.gql:1436`); `Product.status`/`stockStatus` exist but admin flows do not maintain them (DOC-23).

## TODO.md claims: verified true vs false

### Security items (Phases 1-2)

| Item | Verdict | Evidence |
|---|---|---|
| CRITICAL-1 invalid webhook signature -> 401 | **True** | `payment.service.ts:176-183` throws `UnauthorizedException`; e2e test `payment-return.e2e-spec.ts:305-318`. Caveat DOC-21 (hash of re-serialised JSON, non-constant-time compare). |
| CRITICAL-2 lowercase `x-paystack-signature` | **True** | `payment.controller.ts:27`, `payment/constant.ts`. |
| CRITICAL-3 explicit CSP in production | **True** (REST/HTML only) | `main.ts:15-32`; disabled outside production by design. |
| CRITICAL-4 stack traces only in development | **Partially true** | Filter true (`all-exceptions.filter.ts:19-20`); `grapqhl-error.formatter.ts:17-22` still logs stacks everywhere (DOC-13). |
| HIGH-1 rate limit forgot/reset 3/hour | **True** | `authentication.resolver.ts:72,78`, `app.module.ts:68-77`, opt-in guard `gql-throttler.guard.ts`. No test (e2e replaces the throttler storage with a no-op, `test/helpers/app.helper.ts:15-18`). |
| HIGH-2 atomic refresh rotation | **False in effect** | DOC-10: transaction present, race still open. |
| HIGH-3 JWT secret/audience/issuer startup validation | **True** | `env.validation.ts:13-16,47` (also `JWT_REFRESH_SECRET`, `JWT_RESET_SECRET` >= 32). |
| HIGH-4 bcrypt 12 rounds | **True** | `bcrypt.service.ts:19-21`. |
| HIGH-5 introspection off in production | **True** | `app.module.ts:96`. |
| MED-1 HSTS | **True** (production only) | `main.ts:34-35`. |
| MED-2 auth throttle 3-5/min | **True** | limit 5 (`app.module.ts:63-67`, resolver `@Throttle`). |
| MED-3 constant-time delay | **False** | DOC-09. |
| MED-4 `addresses` restricted | **True** | `addresses.resolver.ts:39-52`; ADMIN without `userId` gets Forbidden. Unpaginated. |
| MED-5 `ALLOWED_ORIGINS` required in production | **True** | `main.ts:41-51` (in `main.ts`, not Joi). |
| MED-6 `changeUserPassword` verifies old password | **True** | `users.service.ts:39-47`. |
| LOW-1 null-coalesce in `sanitizeInitializeDetails` | **True** | `payment.service.ts:312-317`. |

### Phase 3 (infrastructure)

| Item | Verdict | Evidence |
|---|---|---|
| `.env.test` created (SQLite) | **False** | File absent; schema provider is PostgreSQL (DOC-11). |
| `jest-e2e.json` correct, DB can be reset/seeded | **False now** | Config exists, but `db.helper.ts:49` references removed `prisma.taxRate`; tsc baseline fails (DOC-11). |
| `app.helper.ts`, `auth.helper.ts` (all 5 functions), `graphql.helper.ts` | **True (exist)** | `test/helpers/*`. |
| `db.helper.ts` (`resetDb`, `seedMinimal`) | **Exists but broken** | DOC-11. |

### Phase 4 (public/auth e2e)

| Item | Verdict |
|---|---|
| signUp success / duplicate / invalid email+weak password | True (`auth.e2e-spec.ts:32,52,70,87`) |
| signIn success / wrong password / unknown email | True (`:108,128,146`) |
| refreshToken success returns new pair | **False - test commented out** (`:168-199`) |
| refreshToken fails invalid/expired/revoked | Partial: invalid (`:201`) and revoked (`:219`) present; **expired not tested** |
| signOut invalidates refresh token | **Partial** - standalone test commented out (`:259-299`); behaviour only exercised inside the "revoked" test |
| forgotPassword true for both | True (`:302,318`) |
| resetPassword valid / expired / already used | True (`:377,413,397`) |
| signInWithGoogle / signInWithFacebook | **Weak** - auth services replaced by mocks (`:441-552`); proves wiring only |
| products, product, categories, brands, brand (public) | True (`catalogue.e2e-spec.ts`) |

### Phase 5 (authenticated e2e)

True and present: profile (`user-account`), addresses incl. other-user failures, wishlist (5), cart (8; `cart` empty asserted as `null`), reviews (7), coupons (6), return requests (4), `getMyPayments`, `payment` own/other.

False or unreliable:
- All `createOrder` items (`order.e2e-spec.ts`, `payment-return.e2e-spec.ts:44`): stale mutation shape, cannot pass (DOC-12). This invalidates stock decrement, cancel/restore, user/other-user order, `finalizeOrder`, payments-by-order and return tests that depend on a created order.
- `finalizeOrder` "applies discount pricing": test asserts only `id` (`order.e2e-spec.ts:357-386`).
- `verifyPayment`: service mocked (`payment-return.e2e-spec.ts:143-190`).
- `/payment/initialize`: relies on a Paystack mock; not exercised end-to-end.
- "Webhook with valid signature updates order status": not tested (`:320-337` uses `transfer.success`).
- Listed as `GET /payment/webhook`; actual method is POST.

### Phases 6-9
All unchecked. Confirmed none of the Phase 6, 7, 8 or 9 e2e tests exist in `test/e2e/**` (the e2e files that exist for categories, sub-categories, tags, variants, addresses are role-matrix tests built on the legacy `test/e2e.utils.ts`, not tracked in TODO.md). No `.github/` workflow exists. No coverage threshold is configured (baseline coverage 40%, below the 90% gate in Phase 9). See DOC-28 for wrong expectations in the open items.

### Other claims in CLAUDE.md that check out
Commands in `package.json` exist and match (`start:dev`, `start:debug`, `start:prod`, `build`, `lint` with `--fix`, `format`, `test*`, `test:e2e`); `prisma.seed` points to `prisma/seeders/main.ts` and needs `SUPER_ADMIN_EMAIL`/`PASSWORD` (skips with a warning if unset); JWT TTL defaults, reset secret, refresh rotation in `$transaction`, default `AuthenticationGuard`, global `GqlThrottlerGuard`, Redis-or-memory 5-minute cache (`config/cache.config.ts`) and `ALLOWED_ORIGINS`/HSTS/CSP/introspection production behaviour are accurate. Items that fail: OTEL (DOC-14), `.env.example` completeness (DOC-26), "calls Prisma directly" (DOC-35), "REST only for webhooks" (DOC-34), `.env.test` separation (DOC-11).

## Code issues noticed while auditing (not doc findings; for the owning module reviewers)
- Cancelling an already-CANCELLED order (user or admin) restores stock again (`order.service.ts ensureOrderCanBeCancelled`); `deleteOrder` restores stock without an inventory log and also for already-cancelled orders.
- `POST /payment/initialize` forwards the client-supplied `currency` to Paystack instead of the order's currency (`payment.service.ts:270-276`).
- Account lockout counter is not reset when the lock expires, so the first failure after expiry re-locks (`users.service.ts:266-277`, `authentication.service.ts:59-75`).
- `signOut` revokes any refresh token hash supplied by any authenticated caller, no ownership check (`authentication.service.ts:130-134`).
- `changeUserPassword` does not revoke existing refresh tokens.
- `upload.controller.ts:34` throws a bare `Error` (HTTP 500) when no files are sent.
