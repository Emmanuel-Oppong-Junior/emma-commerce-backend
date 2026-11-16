# 04 — Tests & Code Quality

> **Orchestrator note (final):** baseline numbers are from my own run (`_work/baseline.md`). **Safety:** `npm run test:e2e` must not be run until `.env.test` exists *and* a database-name guard is in place, because `test/setup.ts` falls back to `.env` and the helpers call `deleteMany` (QA-02). 21 failing repro tests now exist on branch `audit/repro-tests` (`test/repro/`, run with `npx jest --config test/jest-repro.json`). They are the first regression suite to make green in Phase 0.

Reviewer: Quality & Performance agent (Sonnet, high). Date: 2026-11-16. Source of the numbers: the orchestrator's baseline run (`docs/audit/_work/baseline.md` and `tmp/audit/baseline/*.txt`), which I did not re-run. Everything else is from reading `src/**/*.spec.ts`, `test/**`, configs and git history. Evidence labels: *Confirmed by reading*, *Confirmed by test* (a baseline test result), *Suspected (needs verification)*.

---

## 1. Verdict in four lines

1. The unit suite is **red** (14 of 61 suites, 32 of 554 tests) and the red part is exactly the business-critical code: checkout (`order.service`), pricing (`products`), discounts, payments. Those modules currently contribute **0–8% effective coverage**.
2. The e2e suite **cannot run** (no `.env.test`; helper references a model that no longer exists; its order mutations use an input shape the API no longer accepts) and, worse, **if `.env.test` is absent it silently falls back to the development database and wipes it**.
3. Most green tests assert *that mocks were called*, not that behaviour is right; **nothing tests concurrency, nothing touches a real database, there is no CI**, and the build deliberately excludes specs from type-checking, which is how the drift went unnoticed.
4. Lint/format is "red" for an environmental reason (CRLF vs LF): 29,487 of 29,488 ESLint errors are one rule. It is fixable with a two-line config change and then the real signal (1 error) appears.

---

## 2. Baseline results (restated with commands)

Environment: Windows 11, Node v24.22.0, npm 11.19.1, existing `node_modules` (no `npm ci`), `git config core.autocrlf=true`.

| Check | Command | Result | Notes |
|---|---|---|---|
| Build | `npm run build` (`nest build`) | **Pass** | Uses `tsconfig.build.json`, which excludes `**/*spec.ts` and `test` (`tsconfig.build.json:3`) → spec type errors never fail the build. Output lands in `dist/src/main.js`, not `dist/main.js` (see QA-13). |
| Typecheck incl. specs/test | `npx tsc --noEmit -p tsconfig.json` | **Fail**, 15 error lines in 9 files | `products.repository.spec:199,210`, `products.resolver.spec:74,93`, `products.service.spec:58,69,77,158`, `discount.repository.spec:8`, `discount.service.spec:38`, `review.service.spec:27`, `users.resolver.spec:103`, `addresses.resolver.spec:89,143`, `test/helpers/db.helper.ts:49`. (The baseline summary lists only the first 5; `tmp/audit/baseline/tsc.txt` has 15 error lines across 9 files.) |
| Lint (no `--fix`) | `npx eslint "{src,test}/**/*.ts"` | **Fail**: 29,488 errors | 29,487 are `prettier/prettier` "Delete `␍`"; **1 real**: `test/e2e/order.e2e-spec.ts:14` `adminToken` unused. 0 warnings. |
| Format | `npx prettier --check "src/**/*.ts" "test/**/*.ts"` | **Fail**: 323 files | Same CRLF cause. |
| Prisma validate | `npx prisma validate` | **Pass** | Warns `package.json#prisma` is deprecated (removed in Prisma 7). |
| Prisma format | `npx prisma format --check` | **Fail** | Schema not canonically formatted. |
| Migration drift | `prisma migrate diff --from-migrations … --to-schema-datamodel …` | **Not run** | Needs a shadow DB (`.env.test` absent). |
| Unit tests + coverage | `npx jest --coverage` | **Fail**: 14/61 suites, 32/554 tests | 522 pass. Jest also reports a worker that failed to exit (leaked handle/timer). |
| Coverage | same | Stmts **40.13%**, Branch **35.06%**, Funcs **27.05%**, Lines **39.86%** | No thresholds configured (`package.json` `jest` block). |
| E2E | `npm run test:e2e` | **Not run** | `.env.test` missing; hazard described in section 6. |
| Outdated / audit | `npm outdated`, `npm audit` | see baseline | Owned by the Deps & Ops report. |

Typecheck vs build: the discrepancy is the finding. A green `npm run build` says nothing about the test code.

---

## 3. Why each of the 14 failing suites fails

Four causes. Only group D contains information about *product* behaviour; the others are test-maintenance debt.

**A. TypeScript compile errors in specs (ts-jest runs type diagnostics, so the suite "failed to run") — 8 suites.** Spec fixtures/call-sites drifted from the code.

| Suite | Error | Why | Which side is stale |
|---|---|---|---|
| `products/products.repository.spec.ts:199,210` | TS2554 (2 args, needs 3–4); TS2322 (`{ name: true }` vs `SortOrder`) | `findMany(options, where, orderBy, select?)` gained a required `orderBy` (`products.repository.ts:52-57`); spec still uses the old signature and a boolean map | Test |
| `products/products.resolver.spec.ts:74,93` | TS2353 `price` not in `CreateProductInput`/`UpdateProductInput` | Pricing refactor to `basePrice` + `isTaxable` with computed `price` (commit `e49148a` "feat: taxes"; `products.service.ts:26-34,107-121`) | Test |
| `products/products.service.spec.ts:58,69,77,158` | Missing `basePrice`,`isTaxable`; `{ id: true, name: true }` not a `ProductSortArgs` | Same refactor; sort args are now `{ sortBy, sortOrder }` (`products.service.ts:222-227`) | Test (and it needs *new* tests for tax-inclusive pricing) |
| `users/users.resolver.spec.ts:103` | TS2741 `totalCount` missing in `PageInfo` | `PageInfo.totalCount` is required (`commons/entities/pageInfo.entity.ts:15`) | Test |
| `discount/discount.service.spec.ts:38`, `discount/discount.repository.spec.ts:8` | TS2739 missing `createdAt`,`updatedAt` on a value typed `Discount` | Fixtures typed with the Prisma model but incomplete. Specs last touched 2026-04-03; the model had timestamps since the first commit, so these fixtures were probably never type-correct under ts-jest diagnostics (Suspected: not bisected) | Test |
| `review/review.service.spec.ts:27` | TS2322 missing `createdAt`,`updatedAt` on `Review & {...}` | Same | Test |
| `addresses/addresses.resolver.spec.ts:89,143` | TS2554 `getAllAddresses()` needs a `role` | `@ActiveUser('role') role` added by the MED-4 hardening (`addresses.resolver.ts:44-51`; commit `2d797dc`) | Test (and the authorisation change itself needs tests) |

**B. Module-resolution error — 1 suite.** `discount/discount.resolver.spec.ts`: `Cannot find module 'src/iam/authentication/decorators/roles.decorator'` from `discount.resolver.ts:7`. The production code uses a **non-relative `src/...` import** (also `commons/upload.controller.ts:13-14`). `nest build` resolves it through `tsconfig` `baseUrl` (I observed `dist/src/discount/discount.resolver.js:22` rewritten to a relative path), and `test/jest-e2e.json:8-10` has `moduleNameMapper "^src/(.*)$"`, but the **unit** jest config in `package.json` has none. Cause is configuration, not behaviour. Fix either side (relative import is a 2-line source change; or add the mapper to the unit config).

**C. Nest dependency-injection errors in `beforeEach` — 2 suites, 27 tests (all red).**
- `order/order.service.spec.ts` (18 tests): `OrdersService` now takes `ReturnsService` as its 9th constructor arg (`order.service.ts:36-46`, added in `0f448fa`); the testing module does not provide it.
- `order/order.resolver.spec.ts` (9 tests): `OrdersResolver` gained `UsersLoader` (and `DiscountService`) for `Order.user` (`order.resolver.ts:131-134`, `0f448fa`); not provided in the spec.
Stale wiring in the test. Note these two suites are the only unit tests for the **checkout, cancellation and stock-restore** logic, so that logic has no working unit test.

**D. Genuine behaviour assertions failing — 3 suites, 5 tests.** These are the only ones where code and test disagree about *behaviour*; each needs a human decision, and per the working agreement I recommend **no test is weakened until the owner decides which side is right**.

| Suite / test | Test expects | Code does | My reading |
|---|---|---|---|
| `users/users.service.spec.ts` › `findAll` (2 tests) | `where` without role filter | Adds `role: { not: SUPER_ADMIN }` (`users.service.ts:132`, `0f448fa`) | Code is intentional (hide super-admins from lists); **update tests** and add one that proves a SUPER_ADMIN can never appear. |
| `payment/payment.repository.spec.ts` › `updateOrderStatus` | `update where { id, status: 'PENDING' }` (only transition a pending order) | Unconditional `update where { id }` (`payment.repository.ts:78-83`) | **Test is right, code is wrong.** `git log -S"status: 'PENDING'"` finds no commit that ever had that guard in the repository file, so the test records *intended* behaviour that was never implemented. Without it, a late/duplicate `charge.success` webhook can move a `CANCELLED`/`DELIVERED` order back to `PROCESSING`. Implement the guard; keep the test. |
| `payment/payment.repository.spec.ts` › `updatePaymentWithStatus` | `update` without `include` | Adds `include: { order: true }` (commit `2470013`, to fix a non-null GraphQL error) | Code is intentional; update test. |
| `payment/payment.service.spec.ts` › `initiatePayment` "already initiated" | `BadRequestException('Payment already initiated for this order')` when a PENDING payment exists | Deletes the PENDING payment and re-initialises (`payment.service.ts:248-259`, comment "delete the pending payment to allow re-initiation") | Design decision. Flag for the Payment owner: deleting a `PENDING` payment record while the customer may still pay the *old* Paystack link leaves a charge with no local row (webhook lookup by reference then 404s, `payment.service.ts:335-339`). Recommend keeping the row (mark `ABANDONED`/new attempt) rather than delete; then rewrite the test accordingly. |

Totals check: A 8 + B 1 + C 2 + D 3 = 14 suites; failing tests 18+9+2+2+1 = 32 (`jest.txt`).

Common thread: the functional changes behind these failures landed across five commits (`2d797dc` security fixes, `2470013`, `e49148a` "feat: taxes", `0f448fa` "small admin fixes", `3d221d5` pagination refactor), and in every case the specs were not updated. Nobody ran `jest` (or `tsc -p tsconfig.json`) before committing, and no CI exists to say so.

---

## 4. Coverage per module (from `tmp/audit/baseline/jest.txt`)

Method: the directory-level rows of the Jest text table. A directory row covers only files directly in that folder (module/service/repository/resolver), not `dto/` or `entities/`, so it is a fair proxy for logic coverage. **A suite that "failed to run" contributes zero coverage for the file it imports, so `products`, `discount`, `order.service`, `review.service` show as ~0% *because their tests are broken*, not because none were written.** Percentages are Stmts / Branch / Funcs / Lines of the folder.

| Module | Stmts | Branch | Funcs | Lines | Notes (per file) |
|---|---|---|---|---|---|
| `src` (root: `main`, `app.module`, `tracing`) | 12.0 | 0 | 23.1 | 9.0 | `main.ts`, `app.module.ts`, `tracing.ts` all 0% |
| addresses | 52.6 | 82.4 | 48.6 | 54.1 | service 100, repo 100, **resolver 0** (suite broken) |
| analytics | 38.5 | 100 | 50 | 36.4 | service 100, resolver 0 |
| brand | 77.8 | 100 | 60 | 77.5 | resolver 64.5 |
| cart | 85.7 | 93.8 | 80 | 85.4 | service 98, repo 100, resolver 77 |
| categories | 82.5 | 85 | 69.7 | 83.2 | service 92, repo 100 |
| commons (top) | 17.8 | 3.8 | 6.5 | 14.2 | `cloudinary.service` 0, `upload.controller` 0, `audit.service` 75, `logger.service` 64 |
| commons/guards (`gql-throttler`) | 0 | 0 | 0 | 0 | custom 100-line throttling logic untested |
| commons/filters, error-formatters, interceptors, validators | 0 | 0 | 0 | 0 | exception filter + GraphQL error formatter untested |
| commons/middlewares | 37.5 | 0 | 33.3 | 31.8 | |
| config (`env.validation`, `cache.config`) | 0 | 0 | 0 | 0 | startup validation untested |
| coupons | 58.5 | 100 | 51.4 | 58.9 | service 100, repo 100, resolver 0 |
| currency | 0 | 0 | 0 | 0 | no spec |
| **discount** | **5.2** | 0 | 0 | 4.3 | service 4.3, repo 15, resolver 0 — all 3 suites broken |
| health | 0 | 100 | 0 | 0 | no spec |
| iam/authentication | 84.0 | 89.5 | 40.5 | 88.8 | service 99; **guards 30** (`authentication.guard` 0, `access-token.guard` 43, `roles.guard` 53); **social 32** (`facebook` 25, `google` 41) |
| iam/hashing | 76.9 | 100 | 0 | 66.7 | |
| inventory | 48.7 | 100 | 50 | 48.5 | service 96, repo 94, resolver 0, `tasks/low-stock` 0 |
| notifications (+email, templates) | 27.8 / 32 / 45 | | | | `notifications.service` 45, `email.service` 32, no spec |
| **order** | **26.3** | 25.9 | 20.2 | 26.1 | **service 8.5** (suite broken), repo 94, resolver 45; `tasks/expired-orders` 0 |
| payment | 73.0 | 64.7 | 56.3 | 74.4 | service 81, repo 93, controller 82 (*inflated: its spec only asserts "defined"*), resolver 47 |
| pickup-locations | 14.1 | 0 | 0 | 10.6 | no spec |
| prisma | 41.7 | 100 | 0 | 37.5 | |
| **products** | **0** | 0 | 0 | 0 | repo, resolver, service all 0 (3 suites broken); loaders 6.5 (reviews/variants/discount loaders 0) |
| returns | 63.1 | 86.7 | 52.8 | 65.1 | service 92, repo 100, resolver 0 |
| review | 47.1 | 42.9 | 23.4 | 47.2 | service 14.7 (suite broken), repo 100 |
| shipping-zones | 13.5 | 0 | 0 | 11.1 | no spec |
| sub-categories | 82.1 | 100 | 69.7 | 82.6 | |
| tag | 73.5 | 76.5 | 59.1 | 75.8 | |
| tax | 36.7 | 75 | 25.8 | 36.4 | repo 100, **service 23** |
| users | 49.3 | 66 | 48.2 | 50.5 | service 82, repo 95, resolver 0; loaders 12 |
| variant | 81.2 | 100 | 73.5 | 85.1 | |
| wishlist | 83.7 | 93.3 | 80 | 85.5 | |
| **All files** | **40.13** | **35.06** | **27.05** | **39.86** | |

Reading the table: coverage is highest where the code is simplest (CRUD for tag/brand/category/variant/wishlist: 73–86%) and lowest where money and stock move (order, discount, products/pricing, tax, shipping, notifications). Resolvers are almost uniformly under-tested (many 0%), which means authorization decorators (`@Roles`, `@Auth`) — the main security control — are effectively untested at the unit level. No coverage thresholds exist, so nothing prevents this from getting worse. Directory-level numbers also hide that `dto/` and `entities/` (0–95%) are in the denominators; configure `collectCoverageFrom` to exclude `*.module.ts`, `*.dto.ts`, `*.input.ts`, `*.entity.ts`, `main.ts`, `index.ts` to get a number that means something.

Modules **with no spec at all**: `config`, `currency`, `health`, `notifications` (incl. `email.service`), `pickup-locations`, `prisma`, `shipping-zones`, the cron tasks, loaders, throttler guard, exception filter/formatter, upload/cloudinary. `tax` has only a repository spec.

---

## 5. Test-quality assessment (sampled)

Sampled: `coupons.service`+`coupons.repository`, `order.service` (read though red), `cart.service`, `inventory.service`, `authentication.service`, `payment.service`, `payment.resolver`, `users.service`, `discount`/`products` (compile-broken), and counted assertions suite-wide.

**What is there (good):** the service specs are above average for mock-based tests. `coupons.service.spec` covers expiry, inactive, usage limit, minimum amount, already-used, null limit and FLAT cap (`coupons.service.spec.ts:142-232`); `authentication.service.spec` covers locked accounts, failed-attempt counter, revoked/unknown refresh tokens, constant-time forgot-password path; `cart.service.spec` has the stock/inactive/not-found negatives. 216 `rejects/toThrow` assertions across the suite means unhappy paths are the norm in services.

**What is wrong:**

1. **Mock-echo repository tests.** All 18 `*.repository.spec.ts` mock `PrismaService` and assert `toHaveBeenCalledWith({ where, data, include })` (e.g. `coupons.repository.spec.ts`, whole file). They pin *how* a query is written, never *what it returns* from real data. They cannot detect a wrong `where`, a missing index, a bad relation include, a Decimal rounding issue or a migration mismatch, and they fail when the implementation is legitimately refactored (that is exactly what failed in `payment.repository.spec`). 419 `toHaveBeenCalled*` assertions vs 402 value assertions across the suite: the suite is ~50% interaction checks. **Nothing in `src` or `test` uses a real database in a unit/integration test** (`grep -r "new PrismaClient\|testcontainers"` → none). Repositories are therefore *never* tested against Postgres anywhere except the (currently un-runnable) e2e suite.
2. **Twelve specs contain only `it('should be defined')`**: `brand.resolver`, `discount.resolver`, `review.resolver`, `payment.resolver`, **`payment.controller` (the Paystack webhook)**, **`roles.guard`, `access-token.guard`, `authentication.guard`** (the authorization chain), `google-authentication.service`, `bcrypt.service`, `logger.service`, `logger.middleware`. Coverage tooling rates `payment.controller` at 82% purely because Nest instantiates the class; no test sends a webhook. The code that decides who may do what and whether money was received is the least tested code in the repository.
3. **Checkout has no working test of the invariants that matter.** `order.service.spec.ts` includes a test named *"should roll back if stock goes negative inside transaction (oversell prevention)"* (`:251`), but with `runTransaction` mocked it can only prove the code throws when a mock returns a negative number; it cannot prove oversell prevention. It is also red (group C).
4. **No concurrency tests anywhere** (`grep -r "Promise.all" src/**/*.spec.ts test` → none relating to concurrency). No test for: two checkouts on the last unit; the same coupon redeemed in parallel (`usedCount` is a bare increment with no limit condition — `coupons.repository.ts:61-64`); double cancel; duplicate webhook; add-to-cart race (`upsert where id ''`, `cart.repository.ts:33-44`); refresh-token reuse race (the one with a transaction is only tested with mocks).
5. **No authorization-matrix tests.** There is no test that an anonymous user cannot reach admin operations or that user A cannot read user B's order/payment/address at resolver level; the e2e suite has a handful (`order`/`payment` "another user's …") but cannot run. The PERF-01/Security finding (public `products → reviews → user → orders`) is exactly the class of bug such a test catches.
6. **Money is tested with floats and literals.** Fixtures use `new Prisma.Decimal(10)` in places, but `order.service` computes with JS `number` (`order.service.ts:341-343`), and no test asserts rounding at 2 dp, negative/zero/huge quantities, or tax compounding.
7. **Hard-coded dates/time**: `coupons.service.spec.ts:20,29` fixes the "valid" coupon expiry to `2026-12-31`; the suite will fail on that date unless `jest.useFakeTimers()`/injected clock is used (today in the baseline is 2026-11-16; the code `new Date()` is also called inline across services, so there is no clock seam).
8. **Leaked handles.** "A worker process has failed to exit gracefully" (baseline). Specs that import the real `LoggerService` create Winston `DailyRotateFile` transports that write `logs/` during tests (`logs/combined-2026-11-16.log` exists in the working tree) — Suspected cause; confirm with `--detectOpenHandles`.
9. **Skips/todos:** none found (`xit`, `.skip`, `it.todo` → 0). But a whole `signOut` e2e block is **commented out** (`test/e2e/auth.e2e-spec.ts:258-…`) although `TODO.md` ticks "`POST signOut` — invalidates refresh token" as done.

Net: green does not mean safe. Of 522 passing tests I would count roughly a third as behaviour tests worth keeping in their current form (services' unhappy-path tests), a third as low-value interaction/defined checks, and the remainder as repository call-shape tests to be replaced by real-DB integration tests. (Estimate; not measured.)

---

## 6. The e2e suite (`test/**`)

**What exists:** 13 spec files, ~6,300 lines including helpers; about 167 `it()` blocks (counted per file; one `signOut` block is commented out). Helpers: `test/helpers/app.helper.ts` (boots `AppModule`, swaps `ThrottlerStorage` for a no-op), `auth.helper.ts` (sign-up/in), `db.helper.ts` (`resetDb`, `seedMinimal`), `graphql.helper.ts` (`gqlRequest` via supertest). A second, older helper set `test/e2e.utils.ts` (`createTestApp`, `clearDatabase`, `createUser/Admin/SuperAdmin`) is still used by `address.e2e.spec.ts`, `category.e2e-spec.ts`, `sub-category.e2e-spec.ts`; the rest use `helpers/`. Two parallel frameworks, two different DB-reset lists.

| Spec | `it` | Covers |
|---|---|---|
| auth | 16 | signUp/signIn/refresh/forgot/reset, Google + Facebook (providers overridden with mocks), signOut block commented out |
| address | 15 | CRUD + ownership |
| cart | 9 | add/update/remove/clear, `cartWithDiscount` |
| catalogue | 9 | public products/product/categories/brands |
| category, sub-category, tag, variant | 14 / 10 / 21 / 24 | admin CRUD, validation, conflicts |
| order | 11 | create, empty cart, bad address, stock decrement, coupon, own/other order, cancel, finalize |
| payment-return | 11 | initialize (service **mocked**), verify, my payments, by id/ownership, webhook 401/200, returns |
| review-coupon | 13 | reviews + coupon validation |
| user-account | 9 | profile/password |
| wishlist | 5 | |

**Not covered at all (grep over `test/`):** pickup locations, shipping zones/fees, cash-on-delivery, fulfillment type PICKUP, tax management, discounts (create/apply), inventory/restock, analytics, brand CRUD, product create/update/archive pricing, upload, health, `adminCancelOrder`, `recordCodPayment`, webhook *success* path (only invalid signature and ignored event), any concurrency/idempotency scenario. i.e. everything added in the last few commits.

**Why it cannot run today:**
1. `.env.test` does not exist (`ls .env.test` → missing). `test/setup.ts:3` is `dotenv.config({ path: '.env.test' })` and ignores a missing file.
2. `test/helpers/db.helper.ts:52` calls `prisma.taxRate.deleteMany()`; the model was replaced by `Tax` (migration `20260413212251_drop_tax_rate_and_created_tax_table`). `tsc` error TS2339; under ts-jest every e2e file that imports the helper fails to compile.
3. **API drift.** `order.e2e-spec.ts:64-80` (and `payment-return.e2e-spec.ts:30-41`) call `createOrder(input: { shippingAddressId: … })`. `CreateOrderInput` now **requires** `fulfillmentType`, `contactEmail`, `contactPhone` (`order/dto/create-order.input.ts:8-34`); GraphQL validation rejects these queries. (Confirmed by reading; not executed.) Only `review-coupon.e2e-spec.ts:383` includes `fulfillmentType`.
4. `resetDb` does not clean `PickupLocation`, `ShippingZone`, `Tax`, so seed/tests that create them would leak across suites (once they exist).
5. `TODO.md` says the test database should "use SQLite". That is impossible for this schema (`String[]` columns, `Json`, `@db.Decimal`, `fullTextSearchPostgres`, native Postgres enums) and misleads anyone setting it up. Docs finding.

**Data-loss hazard (High).** `app.helper.ts` boots the full `AppModule`, whose `ConfigModule.forRoot` loads `.env` by default; `test/setup.ts` only *adds* `.env.test` values if the file exists. If `.env.test` is missing, `DATABASE_URL` comes from the developer's `.env`, and every spec's `beforeAll` calls `resetDb(prisma)` (`db.helper.ts:14-56`, deletes every user/order/payment/product). There is no guard like "refuse unless `DATABASE_URL` contains `_test`". The baseline was right not to run it. Confirmed by reading. Fix first, before anyone creates `.env.test`: assert in `setup.ts` that `NODE_ENV==='test'` and the database name ends with `_test`, throw otherwise.

**Quality of the e2e specs themselves** (the ones I read: order, payment-return, cart, auth): good intent — HTTP + GraphQL through the real guards/pipes, real DB, AAA structure. Weaknesses: the payment *initialize* test replaces `PaymentService` wholesale (`payment-return.e2e-spec.ts:97-130`), so it tests nothing about Paystack integration; tests in a file share state and depend on order (`createdOrderId` carried between `it`s); nothing asserts side-effects (inventory log rows, audit log, emails); throttling is disabled in tests, so rate-limit behaviour is untested; `forceExit: true` (`jest-e2e.json:13`) masks open-handle leaks.

---

## 7. Lint and format: the CRLF situation

**Facts.** `git ls-files --eol src/main.ts src/app.module.ts` → `i/lf w/crlf` (index LF, working tree CRLF). `core.autocrlf=true`. No `.gitattributes`, no `.editorconfig`. `.prettierrc` = `{ singleQuote, trailingComma: all, printWidth: 120 }` (no `endOfLine`; Prettier 3 default is `lf`). So on this machine every file in the working tree has CRLF, and `eslint-plugin-prettier` reports `Delete ␍` on every line of every file: 29,487 errors. In CI on Linux (LF checkout) the same code would pass. The committed content is LF; this is a Windows checkout artefact, *not* a code-quality problem. The one real lint error is `test/e2e/order.e2e-spec.ts:14` (unused `adminToken`).

**Do not run `npm run lint` or `npm run format` here to "fix" it**: both rewrite all 323 files in the working tree (the project's `lint` script is `eslint … --fix`), and your working tree already has uncommitted edits in 7 files. (Git will mostly normalise the endings back on commit with autocrlf, but you'd still get noisy diffs and a risk of mixing real edits with whitespace.)

**Recommended fix (describe-only; I applied nothing):**
- *Preferred — one source of truth for line endings:* add `.gitattributes` with `* text=auto eol=lf` (plus `*.png *.jpg … binary` is implied by `text=auto`; add `*.sh text eol=lf`), add `.editorconfig` with `end_of_line = lf`, and set `endOfLine: "lf"` explicitly in `.prettierrc`. Then run `git add --renormalize .` once (no content change, since the index is already LF), and re-checkout the working tree so files become LF: first `git stash` the 7 modified files (or commit them), then `git rm --cached -r . && git reset --hard` is destructive — safer: `git checkout-index -f -a` after setting `git config core.autocrlf false` for this repo. Windows editors (VS Code) respect `.editorconfig`.
- *Stop-gap if you don't want to touch checkouts:* set `"endOfLine": "auto"` in `.prettierrc`; Prettier then accepts either ending per file. Downsides: mixed endings can enter the repo; CI still needs a consistent checkout. This clears the 29,487 errors immediately and exposes the real count (1 error + whatever `prettier` still reports for genuine formatting).
- Add non-mutating scripts: `"lint:check": "eslint \"{src,test}/**/*.ts\""`, `"format:check": "prettier --check \"{src,test}/**/*.ts\""`, `"typecheck": "tsc --noEmit -p tsconfig.json"`. Keep `--fix` scripts for local use only. (Changing `package.json` needs your approval.)
- Longer-term: ESLint 8 is EOL (`.eslintrc.js`), `@typescript-eslint` 6; plan the move to ESLint 9 flat config. `prisma format` is also not clean and `package.json#prisma` is deprecated (move to `prisma.config.ts`).

---

## 8. CI/CD: none

No `.github/`, no `.gitlab-ci.yml`, no hooks (`git ls-files | grep -i "\.github\|husky\|lefthook\|commitlint"` → nothing), single `Dockerfile` (`node:20-alpine`, while local dev is Node 24 — version skew). Consequences already visible: spec-breaking changes in five commits shipped; `tsc` on specs never runs; the container's `CMD ["node","dist/main"]` does not match the build output `dist/src/main.js` (so a deploy from this Dockerfile cannot start — Confirmed by reading + baseline `dist/` listing); no migration step in the image; no secrets scan (a database URL with password sits in tracked `.claude/settings.local.json` per PLAN §1); `npm audit` high advisories unaddressed.

---

## 9. Testing strategy going forward

Principles: test behaviour through public interfaces; mock only at the I/O edge (Paystack HTTP, Resend, Cloudinary, clock, randomness); use a **real Postgres** for anything that touches Prisma; each business invariant (stock never negative, coupon limit, one payment completion, status transitions) gets a test that fails without the fix and, where concurrent, runs under real concurrency.

### 9.1 Layers

| Layer | What | Tooling | Replaces / adds |
|---|---|---|---|
| **Unit (pure)** | Money/pricing (tax-inclusive price, discount selection, coupon amount, order total, shipping fee), state machines (order status transitions, payment status), validators. Extract these as pure functions with `Decimal`/integer-minor-unit math; table-driven + property-based (`fast-check`: totals never negative, sum of parts equals total, rounding stable). | Jest | Fixes `products`, `discount`, `order` red specs by testing the extracted logic, not constructor wiring |
| **Service with fakes** | Orchestration and unhappy paths where DB behaviour is irrelevant. Keep existing good service specs (coupons, cart, auth); give them a clock seam (`Clock`/`jest.useFakeTimers`). | Jest + `@nestjs/testing` | Keep ~60% of today's service tests |
| **Integration (real Postgres)** | Every repository and every service that opens a transaction: checkout, cancel/expire, webhook processing, coupon redemption, inventory adjust, refresh rotation, product list/search filters and pagination, tax recompute. Run migrations (`prisma migrate deploy`) on a throwaway DB. | **Testcontainers** (`@testcontainers/postgresql`) so `npm test` works anywhere Docker runs, **or** `docker-compose.test.yml` with Postgres 16 on a non-default port; in CI use the `services: postgres` container. Never SQLite. One DB per Jest worker (or schema-per-file); reset with a single helper that **discovers tables** from `information_schema` and runs `TRUNCATE … RESTART IDENTITY CASCADE` (so a renamed model can't break it like `taxRate`). Guard: refuse to run unless `DATABASE_URL` database name ends in `_test`. | Replaces the 18 mock-based repository specs |
| **E2E (HTTP + GraphQL)** | ~20–30 user journeys through the real app: register → browse → cart → checkout (DELIVERY, PICKUP, COD) → pay (Paystack mocked at the **HTTP boundary** with `nock`/MSW, not by overriding `PaymentService`) → webhook → ship → deliver → return/refund; admin product/price/tax/discount/zone management; the authorization matrix. Real Redis optional (service container). | supertest (already in use) | Rebuild on top of the integration DB harness; delete `test/e2e.utils.ts`; fix `createOrder` inputs; unskip `signOut` |
| **Authorization matrix** | Generated from `schema.gql` + the cartographer's resolver table: for every operation × {anonymous, USER, other USER, ADMIN, SUPER_ADMIN} assert allow/deny; plus field-level tests for relations reachable from public queries (`Product.reviews.user`, `User.orders`). | Jest + a table file | New; catches PERF-01/Security class of bug |
| **Schema contract** | Commit `schema.gql` (already tracked); CI step (1) boots/builds and checks `git diff --exit-code schema.gql` (schema is regenerated at startup via `autoSchemaFile`), (2) `graphql-inspector diff "git:origin/main:schema.gql" schema.gql` fails on **breaking** changes unless the PR carries an explicit label/allowlist; (3) when the frontend exists, `graphql-inspector validate` its documents against the schema. Also snapshot test: the set of operations and their `@Roles` (decorator metadata) to catch accidental public exposure. | `@graphql-inspector/cli` (new dev dependency — needs your OK) | New |
| **Concurrency** | Real DB, `Promise.all` of N parallel calls through the service/GraphQL layer: stock (N buyers, stock K → exactly K succeed, final stock ≥ 0, inventory log sums match), coupon (usageLimit L, N>L redeemers → exactly L; same-user duplicate), webhook idempotency (same event ×5 → one completion), cancel race (×10 → one stock restore), add-to-cart race, refresh-token reuse, cron overlap (two `expireAbandonedOrders` concurrently → one restore), deadlock (two carts with the same SKUs in opposite order → both succeed or retry). Each is red today for at least coupon/cancel/cron (PERF-04/05). | Jest, `--runInBand` per file | New; highest value tests in the project |
| **Migration/schema drift** | `prisma validate`, `prisma format --check`, `prisma migrate diff --from-migrations prisma/migrations --to-schema-datamodel prisma/schema.prisma --exit-code` against the shadow DB, and `prisma migrate deploy` on an empty DB followed by the seed. | Prisma CLI in CI | New; replaces "not run" in baseline |
| **Load / performance** | k6 scenarios S1–S11 in `03-performance-review.md`, nightly smoke at reduced scale, full run pre-launch. | k6 | New |
| **Mutation testing (optional)** | On `order`, `payment`, `coupons`, `discount`, `tax`, `inventory` only, to prove the assertions are meaningful. | Stryker | Later |

Test-pyramid sizing for this codebase: ~70% unit/service (fast, no DB), ~20% integration/concurrency (real DB), ~10% e2e/contract. Keep total CI time under ~10 minutes (parallelise unit/integration/e2e jobs).

### 9.2 Immediate repair order (unblocks everything else)
1. **Make e2e safe**: DB-name guard in `test/setup.ts`; create `.env.test` from `.env.example` pointing at a dedicated `*_test` database (names only here; no values).
2. Fix compile-level drift (groups A, B, C in section 3): mechanical. For group D, take the decisions in the table: update users + payment.repository(include) tests; **implement the `status: 'PENDING'` guard and keep that test**; decide the re-initiate semantics before touching the payment.service test. No test is deleted or weakened to turn the suite green.
3. Add `typecheck` (covering specs) as a required check so drift can't recur.
4. Write the checkout, webhook and coupon integration tests **before** the fixes for PERF-04/05/06 (tests-first, as the working agreement requires) so the fixes are proven.
5. Replace "should be defined" placeholders for guards and the webhook controller with real tests (roles guard allow/deny matrix, access-token guard expiry/audience/issuer, authentication guard `@Auth(None)` bypass, webhook signature/idempotency).

### 9.3 Conventions
- Co-locate unit specs (`*.spec.ts`); integration in `test/integration/**/*.int-spec.ts`; e2e in `test/e2e/**`; one shared harness (`test/harness/`): `startPostgres()`, `resetDb()` (discovered tables), `createApp()` (with throttler real-but-high or Redis), `fakeClock`, `paystackMock`, factories (`makeUser`, `makeProduct`, `makeOrder`) using Prisma, not raw SQL.
- Fixtures typed with the Prisma model **via factories that fill defaults** (so schema additions don't break fixtures — the cause of 3 of the 8 compile failures).
- Test names state behaviour ("rejects redemption when usageLimit reached even under parallel requests").
- Coverage thresholds as a ratchet, not a vanity target: global floor = current (40/35/27/40) raised by +5 points each month; **per-path thresholds from day one** for `src/order`, `src/payment`, `src/coupons`, `src/discount`, `src/inventory`, `src/tax`, `src/iam` (lines ≥ 85%, branches ≥ 75%) after the red suites are repaired. Exclude modules/DTOs/entities from the denominator. Coverage is a tripwire; the concurrency/authorization suites are the real quality bar.

---

## 10. CI quality gates (proposal; no CI exists; needs your approval to add)

Platform-neutral; GitHub Actions shown as the example. Required checks on `main` (branch protection, no direct pushes, PR review):

| Stage | Command | Fails when |
|---|---|---|
| Install | `npm ci` (lockfile-pinned; Node 20 or 22 LTS to match the Docker image — fix the 20-vs-24 skew) | lockfile out of sync |
| Format / lint | `npx prettier --check "{src,test}/**/*.ts"`, `npx eslint "{src,test}/**/*.ts"` (non-`--fix`) | any error (after the line-ending fix) |
| Typecheck (incl. specs) | `npx tsc --noEmit -p tsconfig.json` | any error — would have blocked all 14 red suites |
| Prisma | `prisma validate`; `prisma format --check`; `prisma migrate diff … --exit-code`; `prisma migrate deploy` on the service Postgres | invalid schema, drift between schema and migrations, migration fails on an empty DB |
| Unit + coverage | `npx jest --coverage --ci` with `coverageThreshold` (global ratchet + per-path) | any failing test, coverage drops below floor |
| Integration + concurrency | `npx jest --config test/jest-int.json --runInBand` against Postgres service | any failure; flake budget 0 (quarantine requires a ticket) |
| E2E | `npm run test:e2e` against Postgres (+ Redis) service, with the DB-name guard | any failure |
| Schema contract | `git diff --exit-code schema.gql` after boot; `graphql-inspector diff` vs `origin/main` | undeclared schema change / breaking change |
| Build + container smoke | `npm run build`, `docker build`, run the image, `curl /health/live` and `/health/ready` | missing `dist/main`, boot failure, migrate step missing |
| Dependency audit | `npm audit --omit=dev --audit-level=high` with a reviewed allowlist file | new high/critical in production dependencies |
| Secret scan | `gitleaks detect` (and pre-commit) | any finding (the tracked `.claude/settings.local.json` connection string must be rotated and removed first) |
| License/SBOM (later) | `npm sbom` / license-checker | disallowed licence |
| Nightly | k6 smoke (S1, S2 at 10% scale) against staging; full audit/outdated report | threshold breach |
| Release | tag → build image → `prisma migrate deploy` job → deploy → smoke → automatic rollback on failed health | — |

Also: Renovate/Dependabot weekly PRs (Apollo Server 4 is EOL, NestJS 10→11, Prisma 6→7 are on the outdated list), `CODEOWNERS` for `prisma/`, `src/payment/`, `src/order/`, `src/iam/`, a PR template with the "tests added / schema changed / docs updated" checklist, and a rule that **a bug-fix PR must include a test that fails without the fix**.

---

## 11. Findings register

Severity reflects risk to the business if left (not effort). IDs QA-NN.

| ID | Sev | Category | Finding | Evidence | Confirmation | Business impact | Fix |
|---|---|---|---|---|---|---|---|
| QA-01 | **High** | Tests | Unit suite red: 14/61 suites, 32/554 tests; the failures sit on checkout (`order.service` 8.5%, `order.resolver`), pricing (`products` 0%), discounts (5%) and payments. Four causes: spec drift (8), unit-jest path mapping (1), stale DI wiring (2), genuine behaviour disagreements (3). | `tmp/audit/baseline/jest.txt`; section 3 | Confirmed by test (baseline) | The code that moves money has no executable regression net; every refactor is blind. | Section 9.2 steps 2–4. Do not weaken tests; implement the PENDING guard. **Status: Fixed in bcc995b (P0-F.5): `npx jest` 62/62 suites, 720 tests; `tsc -p tsconfig.json` clean. PENDING guard implemented (via `updateMany`); re-initiate test now describes delete-and-retry until P0-C.2.** |
| QA-02 | **High** | Tests / Data safety | E2E setup falls back to the dev database when `.env.test` is absent and `resetDb` deletes all rows; no DB-name guard. | `test/setup.ts:3`; `test/helpers/db.helper.ts:14-56`; `test/helpers/app.helper.ts` (`AppModule` → `ConfigModule` reads `.env`); `ls .env.test` → missing | Confirmed by reading | Someone "just running the e2e tests" can wipe their development (or a shared) database. | Guard in `setup.ts`: throw unless DB name ends `_test`; never load `.env` in tests. **Status: Fixed in 758068c (P0-F.2): `setup.ts` requires `.env.test`, loads it with `override`, asserts the DB name ends `_test`.** |
| QA-03 | **High** | Tests | E2E suite not runnable and stale: `prisma.taxRate` (removed model), `createOrder` called without required `fulfillmentType/contactEmail/contactPhone`, no coverage of pickup/COD/tax/shipping/discount/inventory/admin pricing. | `test/helpers/db.helper.ts:52`; `test/e2e/order.e2e-spec.ts:64-80`; `src/order/dto/create-order.input.ts:8-34`; tsc TS2339 | Confirmed by reading (+ tsc) | The documented "e2e coverage" in `TODO.md` is not real; launch features are unverified end to end. | Rebuild on the integration harness (section 9). |
| QA-04 | **High** | Process | No CI/CD; the build excludes specs from type-checking; no pre-commit checks. A 14-suite break accumulated over five commits unnoticed. | `tsconfig.build.json:3`; no `.github`; section 8 | Confirmed by reading | Defects reach `main` silently; no release gate. | Section 10. |
| QA-05 | **High** | Tests | Security-critical code only has `should be defined` tests: `roles.guard`, `access-token.guard`, `authentication.guard`, `payment.controller` (webhook), `payment.resolver`, `google-authentication.service`, plus 6 others. Resolver files overall 0–77%; `gql-throttler.guard`, exception filter, GraphQL error formatter at 0%. | `src/**/*.spec.ts` (12 files, 1 `it` each); coverage table | Confirmed by reading | Authorization/authentication and payment-confirmation regressions would not be caught. | Real guard matrix, webhook tests (signature, idempotency, replay), authorization-matrix suite. |
| QA-06 | Medium | Tests | 18 repository specs mock Prisma and assert call shapes; no test anywhere uses a real DB. | e.g. `src/coupons/coupons.repository.spec.ts`; `grep PrismaClient\|testcontainers` → none | Confirmed by reading | Wrong `where`, missing includes, Decimal/rounding and migration mismatches are undetectable; refactors break tests without breaking behaviour. | Real-Postgres integration layer; delete mock repo specs as replaced. |
| QA-07 | Medium | Tests | No concurrency tests for stock, coupons, webhook idempotency, cancel/expiry, cart upsert, refresh rotation, deadlock. At least coupon limit (`coupons.repository.ts:61-64`) and cancel/expiry (`order.service.ts:407-423`) are defective today. | grep over specs; code refs | Confirmed by reading | Overselling, over-redeemed coupons and phantom stock reach customers. | Section 9.1 concurrency row. |
| QA-08 | Medium | Quality gate | Lint/format "fail" only because of CRLF checkout (29,487 of 29,488 errors); `lint` script uses `--fix`; real lint errors: 1. | `tmp/audit/baseline/eslint.txt`; `.prettierrc`; `git ls-files --eol`; `package.json` scripts | Confirmed by test (baseline) + reading | The signal is buried; devs learn to ignore lint; running `npm run lint` rewrites every file. | Section 7. **Status: CRLF part fixed in f2b323a (P0-F.1); `lint --fix` script remains (P0-F.6).** |
| QA-09 | Medium | Tests | Whole modules without specs: config/env validation, currency, health, notifications/email, pickup-locations, shipping-zones, cron tasks, loaders, throttler, filters, upload/cloudinary; tax service 23%. | Coverage table | Confirmed by test | Startup validation, Ghana-specific fulfilment (zones/pickup), fee/tax math and emails are unverified. | Add integration tests per module (priority: tax, shipping fee, env validation, tasks). |
| QA-10 | Medium | Tests | Two competing e2e helper sets (`test/e2e.utils.ts` vs `test/helpers`); `signOut` e2e commented out though `TODO.md` ticks it; payment *initialize* e2e mocks `PaymentService`. | `test/e2e.utils.ts`; `test/e2e/auth.e2e-spec.ts:258-…`; `test/e2e/payment-return.e2e-spec.ts:97-130` | Confirmed by reading | Duplicate maintenance, false confidence in payment coverage. | Consolidate, unskip, mock Paystack at HTTP. |
| QA-11 | Medium | Tests | Unit config has no `moduleNameMapper` while source uses non-relative `src/...` imports (`discount.resolver.ts:7`, `upload.controller.ts:13-14`) → a suite fails to resolve a module; e2e config maps it. | `package.json` `jest` block; `test/jest-e2e.json:8-10` | Confirmed by test | Same code behaves differently under build vs jest. | Use relative imports or map the alias in both configs. **Status: Fixed in bcc995b (P0-F.5): the two `src/...` imports made relative; no `src/` imports remain under `src/`.** |
| QA-12 | Medium | Tests | Jest "worker failed to exit gracefully"; e2e uses `forceExit: true`. Suspected: real `LoggerService` with `DailyRotateFile` created in unit tests (writes `logs/`), timers. | baseline `jest.txt:1413`; `test/jest-e2e.json:13`; `logs/` present | Suspected (needs verification: `--detectOpenHandles`) | Hides leaks that become production shutdown hangs; pollutes the repo working tree with logs. | Mock the logger in specs, close app/Prisma in `afterAll`, remove `forceExit`. |
| QA-13 | Medium | Build | `npm run build` emits `dist/src/main.js`; `start:prod` and `Dockerfile CMD` run `node dist/main`. Cause: `tsconfig.build.json` has no `include`/`rootDir`, so `prisma/seeders` is compiled and rootDir becomes the repo root. | `package.json` `start:prod`; `Dockerfile`; `ls dist` (baseline) | Confirmed by reading | Production container fails to start. | `rootDir: ./src` + `include` in `tsconfig.build.json`; add container smoke test to CI. |
| QA-14 | Medium | Tests | Hard-coded future date in a test fixture (`2026-12-31`) and inline `new Date()` throughout services: tests will start failing on that date; no clock seam. | `src/coupons/coupons.service.spec.ts:20,29` | Confirmed by reading | Time-bomb failures; hard to test expiry boundaries. | Injectable clock / fake timers. |
| QA-15 | Low | Docs | `TODO.md` marks all e2e phases complete and says to use SQLite for the test DB; neither is true/possible for this Postgres-specific schema. | `TODO.md` Phase 3/4; `prisma/schema.prisma:9,175-183` | Confirmed by reading | Misleads onboarding and the audit trail. | Correct TODO.md or replace with this plan. |
| QA-16 | Low | Tooling | `prisma format` fails; `package.json#prisma` deprecated; ESLint 8 EOL, `@typescript-eslint` 6, Jest 29; Docker `node:20-alpine` vs local Node 24. | `tmp/audit/baseline/prisma.txt`; baseline outdated | Confirmed by test | Upgrade debt; behaviour differences between local and container. | Pin Node LTS in `.nvmrc`/`engines`; schedule upgrades. |
| QA-17 | Info | Tests | Coverage config counts dto/entities/modules and sets no threshold; `payment.controller` shows 82% from instantiation alone. | `package.json` `jest`; coverage table | Confirmed by reading | Misleading metric. | Section 9.3. |

---

## 12. Definition of done for this area

- `npx tsc --noEmit -p tsconfig.json`, `eslint`, `prettier --check`, `prisma validate/format --check/migrate diff`, all green locally and in CI.
- Unit suite green with no test deleted or weakened; the two decisions in group D resolved by the owners and documented.
- Integration harness on real Postgres in place; repositories covered there; mock repo specs retired as replaced.
- Concurrency tests for stock, coupon, webhook idempotency, cancel/expiry, cart, refresh token exist and pass.
- E2E rebuilt (DB-name guard, Paystack mocked at HTTP, journeys for DELIVERY/PICKUP/COD, admin pricing/tax/zones) and green.
- Authorization-matrix and schema-contract checks required in CI.
- Coverage ratchet with per-path floors for the money/security modules enforced.
