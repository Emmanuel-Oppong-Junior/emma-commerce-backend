# 02 — Security review
Status: **final**. Drafted by the IAM & Security reviewer (Claude Opus 5.5, high effort), 2026-11-16; re-verified by the orchestrator (see §8). Every Critical/High below was re-checked; SEC-01, PLAT-01, IAM-07, IAM-05 and PLAT-02 now have committed failing tests on branch `audit/repro-tests` (`test/repro/`).
Scope: authentication and authorization across all 22 resolvers and 4 REST controllers, platform configuration, uploads, Paystack webhook signature, secrets in the repository, logging, Ghana Data Protection Act 2012 (Act 843) at a high level.
Module reports: [`modules/iam.md`](modules/iam.md), [`modules/uploads.md`](modules/uploads.md), [`modules/platform-security.md`](modules/platform-security.md). Related findings by other reviewers: USR-01 (`modules/users.md`), REV-01 (`modules/review.md`), PRD-01/PRD-02 (`modules/products.md`), OBS-01 (`modules/observability.md`).

## 1. Bottom line
Not safe to launch. Two problems need fixing before anything else:
1. **Anyone, without logging in, can read customers' email, phone, home addresses and order history** through `product → reviews → user → addresses/orders` (SEC-01). Confirmed by test.
2. **Every REST endpoint returns 500** (Paystack webhook, payment initialisation, uploads, health) because a GraphQL-only interceptor is global (PLAT-01), and the access-token guard cannot read HTTP requests (IAM-07). Confirmed by test. This is an availability problem rather than a breach, but it blocks taking money online.

Next tier: weak session lifecycle (refresh tokens survive password reset and can be extended forever: IAM-02), social-login account linking by unverified email (IAM-01), tokens and passwords written to logs (PLAT-02), and an unauthenticated cyclic GraphQL schema with no depth or cost limits (PLAT-05).

Done well: object-level ownership checks on root queries and mutations (addresses, orders, cart, reviews, returns, payments, wishlist, shipping fee) are present and consistent; global deny-by-default authentication; bcrypt cost 12; hashed refresh and reset tokens; CORS allowlist enforced in production; helmet; strict input whitelisting; production error masking; no SSRF surface (all outbound URLs are fixed provider hosts).

## 2. Findings owned by this review (SEC-NN)
| ID | Severity | Category | Description | Evidence (file:line) | Confirmation | Business impact | Recommended fix |
|---|---|---|---|---|---|---|---|
| SEC-01 | Critical | Security (API1/API3) | **Field resolvers bypass every guard, so customer PII is readable anonymously.** `@nestjs/graphql` only applies guards/filters/interceptors to `@ResolveField` methods listed in `fieldResolverEnhancers`, which is `[]` by default and not set here. `User.addresses` and `User.orders` (class-level `@Roles(SUPER_ADMIN)` notwithstanding) and `Review.user`, `Order.user` therefore run for anyone who can reach a parent object. Public entry point: `product(productId)` / `products` are `@Auth(None)`, and `Product.reviews` returns every review. Query: `{ product(productId:"…"){ reviews { user { email phoneNumber role lastLoginAt addresses { street city state zipCode } orders { contactPhone shippingAddressSnapshot finalTotal items { … } } } } } }`. Same root cause as USR-01 / REV-01 / PRD-01. | `node_modules/@nestjs/graphql/dist/drivers/abstract-graphql.driver.js:12`; `…/services/resolvers-explorer.service.js:95-103`; `src/app.module.ts:91-104`; `src/products/products.resolver.ts:107-124`; `src/review/review.resolver.ts:88-91`; `src/users/users.resolver.ts:19-20,122-130`; `src/order/order.resolver.ts:131-134` | **Confirmed by test** for the anonymous path: scratch harness `scratchpad/pii-leak.js` (outside repo) boots real `ProductsResolver`, `ReviewResolver`, `UsersResolver`, real `AuthenticationGuard` + `RolesGuard` as `APP_GUARD`, Apollo driver, mocked data layer. With no token: `userById` → "Unauthorized"; `product{reviews{user{email phoneNumber role addresses{street city} orders{id}}}}` → returns the victim's email, phone, role and address. | Mass harvesting of customer contact details, home addresses and purchase history by competitors, fraudsters or scrapers; reportable breach under Act 843; reputational damage. | Do not expose `User` from public types: `Review.author: PublicReviewer { displayName }`. In `User.addresses/orders` check `ctx.req.user` is the parent or an admin. Do **not** just switch on `fieldResolverEnhancers:['guards']`: `AccessTokenGuard` does a DB lookup per invocation (N+1 per field per row) and class-level `@Roles(SUPER_ADMIN)` would then break `userProfile { addresses }` for customers and `@Auth(None)` parents would 401 on `variants`. Add an e2e regression test for the anonymous query. **Status: Fixed in c788131 (P0-A.2): `Review.user` is `PublicProfile { displayName }`; owner-or-admin field middleware on `User.email/phoneNumber/addresses/orders` and `Order.user`; schema test proves no `User` reachable from `@Auth(None)` roots; anonymous e2e written (runs with P0-F.7); repro green.** |
| SEC-02 | Medium | Security (API6) | **HTML injection in transactional email + unverified sign-up = branded phishing.** `welcomeEmailHtml(name)` interpolates the user-supplied name unescaped; sign-up needs no email verification, so an attacker can register any victim address with a name such as `<a href="https://evil.example">Verify</a>` (≤ 50 chars) and the shop sends it to the victim from its own domain. Other templates interpolate order/status/tracking values unescaped (admin-controlled `trackingNumber`). | `src/notifications/email/templates/email.templates.ts:1-19`; `src/iam/authentication/authentication.service.ts:34-46`; `src/iam/authentication/dto/sign-up.input.ts:7-10` | Confirmed by reading | Phishing that passes SPF/DKIM for the shop's domain; sender reputation damage. | HTML-escape every interpolated value; verify email before sending anything beyond the verification mail. (Cross-ref notifications.md.) |
| SEC-03 | Low | Security (API5) | No role hierarchy in `RolesGuard` (exact match), and role lists are inconsistent: `SUPER_ADMIN` cannot `softDeletePayment`/`restorePayment`/`removePayment`/`getUserPayment`/`updateSubCategory`/`removeSubCategory`; `cancelOrder`, `verifyPayment`, `getMyPayments`, `createReview` are `USER`-only. Not exploitable; causes operational surprises and invites ad-hoc fixes. | `src/iam/authentication/guards/roles.guard.ts:12-18`; `src/payment/payment.resolver.ts:13,25,31,56-70`; `src/sub-categories/sub-categories.resolver.ts:53-76`; `src/order/order.resolver.ts:94-99`; `src/review/review.resolver.ts:46-75` | Confirmed by reading | Super admin locked out of some recovery actions. | Define a hierarchy (SUPER_ADMIN ⊇ ADMIN) or named permissions; add a test enumerating every operation's allowed roles (snapshot of the auth matrix). |
| SEC-04 | Low | Security (API10) | Paystack webhook HMAC is computed over `JSON.stringify(parsedBody)` rather than the raw request bytes, and compared with `===` (not constant-time). Works only while Paystack's serialisation matches V8's; a mismatch silently rejects genuine webhooks. Impact of forgery is limited because processing re-verifies the transaction with the Paystack API (`processWebhookPayment → verifyPayment`). The endpoint is currently unreachable anyway (PLAT-01). Business logic of payment processing is owned by the payment reviewer. | `src/payment/payment.controller.ts:21-29`; `src/payment/payment.service.ts:165-200,377-392`; `src/main.ts:10` (no `rawBody: true`) | Confirmed by reading | Missed payment confirmations if serialisation ever differs. | `NestFactory.create(AppModule, { rawBody: true })`, HMAC over `req.rawBody`, `crypto.timingSafeEqual` on equal-length buffers; optionally allowlist Paystack IPs. |
| SEC-05 | Low | Security (API8) | **Tracked local settings file contains a database connection string with credentials.** `.claude/settings.local.json` is in git; key `permissions.allow[17]` embeds a `DATABASE_URL=postgresql://…@localhost…` value (value not reproduced). Local database only, but the password may be reused and stays in history. `.env.example` contains placeholders only. No other secret patterns (Paystack `sk_live/sk_test`, Resend, AWS, PEM, Cloudinary URL) found in tracked files. | `git ls-files` → `.claude/settings.local.json`; entry index 17 | Confirmed by reading | Credential reuse risk; poor hygiene signal. | Rotate that DB password; `git rm --cached .claude/settings.local.json` and add to `.gitignore` (history rewrite optional for a local-only credential). Add a secret scanner (gitleaks) pre-commit/CI. |
| SEC-06 | Medium | Compliance | **Ghana Data Protection Act 2012 (Act 843) gaps.** See section 5. No erasure path (orders `onDelete: Restrict` make `removeUser` fail for any customer with an order and there is no anonymisation), no retention rules, PII and credentials in logs (PLAT-02), PII exposure (SEC-01), no consent records, multiple foreign processors. | `prisma/schema.prisma:310,496` (Restrict), `:17-43` (User), `:320-328` (Order contact/snapshot); `src/users/users.service.ts:215-219` | Suspected (legal interpretation; code facts Confirmed by reading) | Regulatory sanction and mandatory breach notification; blocks trading in regulated verticals (pharmacy). | Register with the Data Protection Commission; data inventory + retention schedule; anonymisation-based erasure; DPA/processor agreements; breach procedure. |

All other findings are in the module reports and summarised in section 4.

## 3. OWASP API Security Top 10 (2023) mapping
| OWASP API risk | Status | Findings | Notes |
|---|---|---|---|
| API1 Broken Object Level Authorization | **Fail** | SEC-01 (USR-01, REV-01, PRD-01) | Root operations check ownership correctly: addresses (`addresses.service.ts:86-90`), orders (`order.service.ts:392-398`), payments (`payment.service.ts:82-111`), returns (`returns.service.ts:28-35`), cart items (`cart.service.ts:65-68`), reviews (`review.service.ts:63-82`), wishlist (userId from token), shipping fee (`getFeeForAddress(addressId, userId)`). The breach is through nested field resolvers. |
| API2 Broken Authentication | **Fail** | IAM-01, IAM-02, IAM-03, IAM-04, IAM-08, IAM-09, IAM-11, IAM-12, IAM-13, IAM-17, PLAT-02, PLAT-03 | Sessions survive password reset; social-login linking by email; tokens in logs; racy lockout. |
| API3 Broken Object Property Level Authorization | **Fail** | SEC-01, IAM-09, IAM-10, IAM-20, PRD-02 | Read side: `User` type (email, phone, role, lastLoginAt) reachable from public types; public product fields include `basePrice`, exact stock (PRD-02). Write side: no role/isActive mass assignment in user DTOs (good), but `email` is writable without re-auth (IAM-09) and by any ADMIN on any non-super user (IAM-10). |
| API4 Unrestricted Resource Consumption | **Fail** | PLAT-05, PLAT-04, UPL-04 | No depth/complexity limits on a cyclic anonymous schema; in-memory per-handler throttling; `forgotPassword` email bombing across IPs; image decompression bombs. Pagination is capped at 100 (`paginate.args.ts:9`) but `Product.reviews` and several admin lists (`payments`, `inventoryLogs`, `coupons`, `returnRequests`) are unbounded. |
| API5 Broken Function Level Authorization | Partial | UPL-02, IAM-10, SEC-03 | All mutations carry `@Roles` (class or method) and the guards are global; no unprotected admin operation found. Gaps: any USER may upload; ADMIN can manage peer ADMINs; no role hierarchy. |
| API6 Unrestricted Access to Sensitive Business Flows | Partial | SEC-02, IAM-01, PLAT-04 | Unverified sign-up feeds phishing and pre-hijack; no bot protection on sign-up/sign-in/forgot-password. Coupon/discount abuse is covered by the money reviewer. |
| API7 Server Side Request Forgery | Pass | — | No user-controlled URL is fetched server-side. `profilePicture` URLs are stored, never fetched. Provider calls use fixed hosts (but see IAM-11 parameter injection). |
| API8 Security Misconfiguration | **Fail** | PLAT-01, PLAT-07, PLAT-03, PLAT-06, PLAT-08, PLAT-09, SEC-05 | REST surface broken by a global interceptor; fail-open `NODE_ENV`; placeholder secrets pass validation; proxy trust hard-coded; landing page in production. |
| API9 Improper Inventory Management | Partial | UPL-06, PLAT-11, IAM-20, PLAT-01 | Dead upload helper and Multer disk config; dead `authProvider`/`facebookId` fields; REST endpoints untested and broken; Docker entry point missing (PLAT-11); `FRONTEND_API_DOCUMENTATION.md` accuracy is owned by the docs reviewer. |
| API10 Unsafe Consumption of APIs | Partial | IAM-11, SEC-04 | Provider tokens interpolated into URLs unencoded, no timeouts or status checks; webhook HMAC not over raw body. Paystack verify-call handling is owned by the payment reviewer. |

## 4. All findings by severity (this reviewer)
| Severity | ID | One line | Confirmation |
|---|---|---|---|
| Critical | SEC-01 | Anonymous read of customer email/phone/addresses/orders via `product.reviews.user` (field resolvers skip guards) | Confirmed by test |
| Critical | PLAT-01 | Global GraphQL logging interceptor throws on every REST request (webhook, payment init, upload, health → 500) | Confirmed by test |
| High | IAM-01 | Social login auto-links to any existing account with the same email; sign-up unverified → pre-hijack (admin accounts included) | Confirmed by reading (provider-side unverified email: Suspected) |
| High | IAM-02 | Refresh tokens not revoked on password reset/change; sliding 24 h with no absolute cap; no reuse detection | Confirmed by reading |
| High | IAM-05 | Sign-in DTO caps password at 16 chars; sign-up allows 64 → users locked out | Confirmed by test |
| High | IAM-07 | Access-token guard, roles guard and `@ActiveUser` crash in HTTP context → all Bearer REST routes 500 | Confirmed by test |
| High | PLAT-02 | refresh/reset/social tokens and new/old passwords logged in clear text (14-day files) | Confirmed by test |
| High | UPL-01 | Uploads unusable (consequence of PLAT-01 + IAM-07) | Confirmed by test |
| Medium | IAM-03 | Refresh rotation race: check outside transaction, unconditional update | Confirmed by reading |
| Medium | IAM-04 | Deterministic JWTs (no `jti`): same-second sign-ins 500, same-second refresh 401; e2e happy paths commented out | Confirmed by test |
| Medium | IAM-06 | Password policy differs per path; reset accepts `aaaaaaaa` | Confirmed by test |
| Medium | IAM-08 | Lockout racy, re-arms forever (targeted DoS), leaks existence | Confirmed by reading |
| Medium | IAM-09 | Email change without re-auth/verification → permanent takeover from a stolen access token | Confirmed by reading |
| Medium | IAM-10 | ADMIN can modify/delete peer ADMINs and redirect customer emails; no audit log | Confirmed by reading |
| Medium | IAM-11 | Unencoded provider tokens in Graph/Google URLs; possible app-id check bypass; no timeouts | Suspected |
| Medium | PLAT-03 | `trust proxy` hard-coded to 1 → XFF spoofing bypasses all IP throttles, or shared buckets | Suspected (deployment-dependent) |
| Medium | PLAT-04 | In-memory, per-handler, per-IP throttling; no per-email limits | Confirmed by reading |
| Medium | PLAT-05 | No depth/complexity/alias limits on cyclic anonymous schema | Confirmed by reading (impact Suspected) |
| Medium | PLAT-07 | Fail-open `NODE_ENV`; placeholder secrets pass Joi; `JWT_RESET_SECRET` missing from `.env.example` | Confirmed by reading |
| Medium | UPL-02 | Any authenticated customer can upload to the merchant's Cloudinary | Confirmed by reading |
| Medium | UPL-03 | No content validation; sharp failure uploads raw bytes | Confirmed by reading |
| Medium | UPL-04 | Decompression-bomb memory DoS | Suspected |
| Medium | SEC-02 | Unescaped HTML in emails + unverified sign-up → branded phishing | Confirmed by reading |
| Medium | SEC-06 | Act 843 gaps (erasure, retention, logs, processors) | Suspected |
| Low | IAM-12..19, PLAT-06, PLAT-08, PLAT-09, UPL-05..07, SEC-03..05 | See module reports | — |

## 5. Ghana Data Protection Act 2012 (Act 843) — high-level view
Not legal advice; the Ghana research agent's cited notes should be used for the final wording.
- **Personal data stored.** `User`: name, email, phone, password hash, profile picture URL, role, `lastLoginAt`, failed-login counters, reset-token hash. `Address`: street, city, state, zip, country. `Order`: `contactEmail`, `contactPhone`, `shippingAddressSnapshot` (JSON copy of the address), purchase history. `Payment`: Paystack reference and amounts; webhook payload includes customer and card `authorization` objects (not persisted by the code reviewed, but logged in part). `Review`: free text linked to the user. `AuthProvider`: Google/Facebook subject IDs. `AuditLog.details` (JSON, may contain PII). Log files: emails, IDs, and today also tokens/passwords (PLAT-02). Third parties receiving data: Paystack, Cloudinary, Resend, Google, Facebook (all outside Ghana: cross-border transfer).
- **Security safeguards (s.28).** Undermined by SEC-01 (public PII), PLAT-02 (credentials in logs), IAM-01/02 (account takeover persistence). No application-level encryption of PII; encryption at rest depends on the Postgres host (not visible in the repo). No field-level access logging for admin reads of customer data.
- **Retention and erasure.** No retention policy or purge jobs (refresh tokens are only purged for a user when that user logs in again; logs 14 days). `removeUser` hard-deletes and is blocked by `Order`/`ReturnRequest` `onDelete: Restrict`; there is no anonymisation path, so a data-subject deletion request cannot be honoured while keeping financial records.
- **Data subject rights.** No export/access endpoint beyond the user's own queries; no consent capture (marketing, terms/privacy version) on sign-up.
- **Accountability.** Registration of the controller with the Data Protection Commission, processor agreements with the foreign processors, and a breach-notification procedure are organisational items outside the code; none are referenced in the repo.

## 6. Prioritised remediation
**Phase 0 — before any real customer data (days)**
1. SEC-01: replace `Review.user` with a public projection; owner/admin checks in `User.addresses/orders` and `Order.user`; anonymous regression e2e.
2. PLAT-01 + IAM-07: skip the logging interceptor for non-GraphQL contexts; context-aware request extraction in guards and `@ActiveUser`; smoke e2e over every REST route.
3. PLAT-02: stop logging variable values; purge existing logs.
4. IAM-05/06: one password policy, sign-in accepts any length ≤ 128.
5. SEC-05: rotate the DB password in the tracked settings file and untrack it.

**Phase 1 — before launch (1–2 weeks)**
6. IAM-02/03/04: `jti`, conditional rotation in a transaction, token families with reuse revocation and absolute lifetime, revoke on reset/change/deactivation/email change; restore commented e2e tests.
7. IAM-01/09/SEC-02: email verification on sign-up and on email change; verified-email-only social linking; escape email templates.
8. PLAT-05: depth + complexity limits; bounded `reviews`.
9. PLAT-03/04 + IAM-08: Redis throttler storage, explicit `TRUST_PROXY`, per-email limits on auth flows, atomic lockout without permanent re-arming.
10. UPL-02/03/04: admin-only uploads, magic-byte allowlist, reject on decode failure, pixel limit.
11. PLAT-07: strict env validation (explicit `NODE_ENV`, distinct non-placeholder secrets).

**Phase 2 — hardening (ongoing)**
12. IAM-10 + SEC-03: role hierarchy/permissions, SUPER_ADMIN-only admin management, audit log for user-admin actions.
13. IAM-11, SEC-04: robust provider calls (encoded params, timeouts, ID-token verification), raw-body webhook HMAC with `timingSafeEqual`.
14. SEC-06: Act 843 programme (inventory, retention jobs, anonymising erasure, consent capture, DPC registration, processor agreements).
15. Tests: auth-matrix snapshot test over all operations; concurrency tests for refresh and lockout against a real DB; make the e2e suite run in CI.

## 7. Evidence artefacts
Durable evidence: branch `audit/repro-tests` → `test/repro/field-resolver-auth.repro-spec.ts` (SEC-01, authenticated-customer path) and `test/repro/platform.repro-spec.ts` (PLAT-01, IAM-07, PLAT-02, IAM-05). Run `npx jest --config test/jest-repro.json`; each test fails today and must pass after the fix.

Original scratch harnesses (outside the repo, not committed, may be cleared), run against the compiled `dist/` from the baseline build:
- `C:\Users\EMMANU~1\AppData\Local\Temp\claude\bc75858db13274ac\2383a41a-b4ba-4646-b662-c7a92a9b34a1\scratchpad\pii-leak.js` — SEC-01 (anonymous PII via field resolvers).
- `C:\Users\EMMANU~1\AppData\Local\Temp\claude\bc75858db13274ac\2383a41a-b4ba-4646-b662-c7a92a9b34a1\scratchpad\interceptor-http.js` — PLAT-01.
- `C:\Users\EMMANU~1\AppData\Local\Temp\claude\bc75858db13274ac\2383a41a-b4ba-4646-b662-c7a92a9b34a1\scratchpad\guard-http.js` — IAM-07.
- Inline `node -e` checks (commands in the module reports): IAM-04 identical JWTs, IAM-05/06 DTO validation, IAM-16 filter rejection, PLAT-02 `sanitizeVariables` output.
- Unit tests run: `npx jest src/iam src/commons` → 9 suites, 29 tests passed (all mock-based).

## 8. Orchestrator verification and cross-module security findings

**Re-verification of this reviewer's Critical/High findings**

| ID | Orchestrator check | Result |
|---|---|---|
| SEC-01 | Read `app.module.ts:91-104` (no `fieldResolverEnhancers`), `node_modules/@nestjs/graphql/dist/drivers/abstract-graphql.driver.js:12` (default `[]`), `users.resolver.ts:19-20,122-130`, `review.resolver.ts:88-91`. Repro test: a logged-in customer reads another customer's street address through `review.user.addresses`. | **Confirmed by test** (customer path); anonymous path confirmed by the reviewer's harness |
| PLAT-01 | Ran the reviewer's probe against the baseline build, then wrote a jest repro: `TypeError: Cannot read properties of undefined (reading 'body')` | **Confirmed by test** |
| IAM-07 | Same approach: `TypeError ... (reading 'headers')` from `AccessTokenGuard` in HTTP context | **Confirmed by test**. Upgraded to **Critical** in the summary, because together with PLAT-01 it makes online payment impossible |
| IAM-05 | class-validator run on `SignInInput` with a 20-character password: `isLength` error | **Confirmed by test** |
| PLAT-02 | `sanitizeVariables` leaves `refreshToken`, `resetToken`, `token`, `newPassword`, `oldPassword` in clear | **Confirmed by test** |
| IAM-01, IAM-02 | Read `users.service.ts:58-73` and `authentication.service.ts:87-122,162-181` | Confirmed by reading |
| DOC-10 / IAM-03 | Read `users.repository.ts:122-138`: unconditional `update` on the old token, revoked check outside the transaction | Confirmed by reading (needs a DB for a concurrency test) |
| DOC-09 | `TODO.md` MED-3 claims a constant-time delay in `forgotPassword`; `authentication.service.ts:142` returns immediately | Confirmed by reading: claimed fix absent |

**Business-flow abuse (OWASP API6) found by other reviewers. These are security issues too, because any logged-in customer can trigger them.**

| ID | Abuse | Evidence | Confirmation |
|---|---|---|---|
| DISC-01 | Customer calls `finalizeOrder` before paying, which rewrites the total without the shipping fee or coupon. It works in any order status and can be repeated. | `order.resolver.ts:124-129`, `discount.repository.ts:152-162` | Confirmed by test |
| ORD-01 | Customer calls `cancelOrder` repeatedly on an already-cancelled order, adding the stock back each time. This lets them make products look in stock and causes overselling. | `order.service.ts:193-199,401-423` | Confirmed by test |
| PAY-01 | Customer replays `verifyPayment` on an old successful reference, which moves a DELIVERED or CANCELLED order back to PROCESSING | `payment.service.ts:82-90,347-363` | Confirmed by test |
| PAY-05 / CUR-01 | Paid amount and currency are never compared to the order total; the client chooses the charge currency | `payment.service.ts:261-283,347-363`, `create-payment.dto.ts:12-14` | Confirmed by test (amount); exploitability depends on the currencies enabled on the Paystack account |
| CPN-01 | Concurrent checkouts can exceed a coupon's `usageLimit` | `coupons.service.ts:93-95`, `coupons.repository.ts:61-64` | Confirmed by reading |
| PRD-02 / CAT-01 | Public queries return DRAFT and inactive products. Public `categories` returns unbounded nested products and reviews. | `products.service.ts:183-220`, `categories.resolver.ts:28-39` | Confirmed by reading |
