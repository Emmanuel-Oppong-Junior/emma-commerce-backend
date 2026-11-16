# Audit Summary — Emma Commerce Backend

Date: 2026-11-16 · Commit: `0f448fa` (`main`) + 7 uncommitted working-tree edits · Orchestrator: Claude Opus 5.5

**Bottom line: not safe to take real money from real customers.** The codebase has a reasonable modular NestJS structure, but the code paths that handle money, stock, payment confirmation and personal data are not correct.
- **Customer data is public:** anyone can read customers' contact details and order history without logging in.
- **Every REST route fails:** all of them return 500, so Paystack webhooks never land.
- **Customers can change what they pay:** they can rewrite their order total and inflate stock.
- **Payments can be lost or mismatched:** paid orders can be lost, or revived after cancellation.
- **The image cannot start:** the Docker image fails at launch.

The fixes are tractable. Phase 0 of the roadmap closes all of these. 21 failing tests already reproduce them on branch `audit/repro-tests`.

## 1. Health score per area (0 = absent/broken, 5 = production-grade)

| Area | Score | Why |
|---|---|---|
| Architecture & code structure | 3 | Clean module/service/repository layering and DataLoaders. Business rules are scattered and duplicated (three discount paths). |
| Data model & integrity | 1.5 | Valid schema, but: one payment per order; cascades and hard deletes of financial records; no order or tax snapshots; dual stock counters; squashed migrations (`01`). |
| Money (pricing, discounts, tax, currency) | 0.5 | Float maths, discounts shown but not charged, customer-callable total rewrite, a wrong best-discount picker, no stored tax, currency ignored (`modules/discount`, `tax`, `currency`). |
| Orders & inventory | 1 | Atomic decrement at checkout is sound. Stock restores are repeatable; there is no state machine; reservations never expire for attempted payments (`modules/order`, `inventory`). |
| Payments | 0.5 | Webhook unreachable, verification doesn't check the amount, retries delete history, no reconciliation (`modules/payment`). |
| Security (authN/authZ) | 1.5 | Good object-level checks on root operations and deny-by-default guards. A Critical PII leak through field resolvers; sessions survive password reset; social-login takeover; tokens in logs (`02`). |
| Performance & scalability | 2 | DataLoaders are request-scoped. No GraphQL limits, missing hot indexes, in-process crons, in-memory fallbacks (`03`). |
| Tests & quality | 1 | 32/554 unit tests failing, typecheck failing, coverage around 40% (0–8% effective on checkout), e2e can't run and could wipe the dev DB, no CI (`04`). |
| Dependencies & ops | 1 | Node 20 and Apollo Server 4 are end-of-life, critical advisories, root container that cannot start, no CI/CD, a committed DB credential (`05`). |
| Documentation | 1.5 | Extensive, but 40 discrepancies (12 High), and `TODO.md` marks two security fixes done that are not (`06`). |
| Fit for multi-vertical Ghana target | 0.5 | 1 of 102 target capabilities Present, 37 Defective, 47 Absent (`_work/gap-analysis.md`). |

## 2. Module verdicts

**CLOSED: none.** Every module is NEEDS WORK (21) or REWRITE (10).

| Module | Verdict | Headline | Report |
|---|---|---|---|
| order | **REWRITE** | Status/stock core: repeatable cancel restores stock, no transition rules, customer `finalizeOrder` | `modules/order.md` |
| payment | **REWRITE** | Verify revives orders, no amount check, retries delete attempts, webhook unreachable | `modules/payment.md` |
| returns | **REWRITE** | Double stock restore, double refund on retry, no item-level returns | `modules/returns.md` |
| discount | **REWRITE** | Best-discount compares raw values; not applied at checkout; total rewrite | `modules/discount.md` |
| tax | **REWRITE** | Tax baked into price, dropped on edit, not stored on orders | `modules/tax.md` |
| currency | **REWRITE** | Hard-coded float rates; checkout ignores currency; client picks charge currency | `modules/currency.md` |
| variant | **REWRITE** | Variants can't be bought; `size`/`color` hard-coded | `modules/variant.md` |
| cart | **REWRITE** | No variant line identity; stale prices; duplicate lines under race | `modules/cart.md` |
| shipping-zones | **REWRITE** | Unmatched city ships free; overlapping zones nondeterministic | `modules/shipping-zones.md` |
| notifications | **REWRITE** | Email-only, fire-and-forget, errors ignored, unescaped templates | `modules/notifications.md` |
| products | NEEDS WORK | Drafts public; absolute stock writes; broken filters; expiry unenforced | `modules/products.md` |
| users | NEEDS WORK | PII exposed via field resolvers (Critical); unaudited admin actions | `modules/users.md` |
| review | NEEDS WORK | `Review.user` leaks PII (Critical); no verified purchase or DB uniqueness | `modules/review.md` |
| iam | NEEDS WORK | Social-login takeover, sessions survive reset, 16-char sign-in cap, REST guards crash | `modules/iam.md` |
| platform-security | NEEDS WORK | Global GraphQL interceptor breaks REST; no GraphQL limits; tokens in logs | `modules/platform-security.md` |
| uploads | NEEDS WORK | Unusable today; any customer may upload; no content validation | `modules/uploads.md` |
| inventory | NEEDS WORK | Ledger/restock sound; stock model around it isn't | `modules/inventory.md` |
| coupons | NEEDS WORK | Usage-limit race; usage not released on cancel | `modules/coupons.md` |
| addresses | NEEDS WORK | Authz correct; model doesn't fit Ghana (zip required, no landmark/GPS/phone) | `modules/addresses.md` |
| categories | NEEDS WORK | Public query exposes unbounded nested products/reviews | `modules/categories.md` |
| sub-categories | NEEDS WORK | Role list locks out SUPER_ADMIN; spec-only tests | `modules/sub-categories.md` |
| brand | NEEDS WORK | Unbounded nested products; case-sensitive uniqueness | `modules/brand.md` |
| tag | NEEDS WORK | Unvalidated args; case-sensitive uniqueness | `modules/tag.md` |
| wishlist | NEEDS WORK | Small and safe; validation/API gaps | `modules/wishlist.md` |
| pickup-locations | NEEDS WORK | Never validated at checkout; no snapshot; no tests | `modules/pickup-locations.md` |
| analytics | NEEDS WORK | Revenue counts unpaid orders and ignores refunds | `modules/analytics.md` |
| audit-log | NEEDS WORK | Refunds, roles, prices, coupons unaudited; writes outside the transaction | `modules/audit-log.md` |
| health | NEEDS WORK | Readiness fails on Cloudinary/Redis outages | `modules/health.md` |
| observability | NEEDS WORK | OpenTelemetry never starts; secrets in logs; logs on local disk | `modules/observability.md` |
| cron-jobs | NEEDS WORK | Run on every instance; expiry misses attempted payments | `modules/cron-jobs.md` |
| prisma-and-seed | NEEDS WORK | Squashed migrations; seeder has no prod guard | `modules/prisma-and-seed.md` |

## 3. Top 10 most dangerous findings

Each item below was re-verified by the orchestrator. "Test" means a failing test on branch `audit/repro-tests` (`test/repro/`).

| # | ID(s) | Finding | Business impact | Evidence | Confirmation |
|---|---|---|---|---|---|
| 1 | SEC-01 / USR-01 / REV-01 / PRD-01 | **Anyone, without logging in, can read every reviewer's email, phone, home addresses and order history.** The query path is `product → reviews → user → addresses/orders`. Guards never run on field resolvers. | Mass PII harvesting; reportable breach under Act 843 | `app.module.ts:91-104`, `users.resolver.ts:19-20,122-130`, `review.resolver.ts:88-91` | Test (customer path); anonymous path by the reviewer's harness |
| 2 | PLAT-01 + IAM-07 | **Every REST route returns 500.** This includes the Paystack webhook, payment initialisation, uploads and health. The cause is a GraphQL-only global interceptor and guards that read GraphQL context. | Online payments never confirm automatically; health probes fail, so the orchestrator restarts the app | `graphql-logging.interceptor.ts:13-22`, `access-token.guard.ts:21` | Test |
| 3 | DISC-01 | **Any customer can call `finalizeOrder` to rewrite their order total before paying.** The new total drops shipping and the coupon. It works in any status and can be repeated. | Revenue loss on every order; totals unreliable for accounting | `order.resolver.ts:124-129`, `discount.repository.ts:152-162` | Test |
| 4 | ORD-01 / DB-06 | **Any customer can cancel an already-cancelled order repeatedly, and stock is restored each time.** | Phantom stock leads to overselling and unfulfillable orders | `order.service.ts:193-199,401-423` | Test |
| 5 | PAY-01 | **Payment verification sets the order to PROCESSING unconditionally.** Replays, late webhooks and payment after expiry revive CANCELLED or DELIVERED orders, whose stock was already released. | Shipping without stock; customer fraud (cancel, keep the goods, then get a refund request) | `payment.service.ts:347-363`, `payment.repository.ts:78-83` | Test |
| 6 | PAY-03 / DB-01 / PAY-04 | **Retrying a payment hard-deletes the pending attempt.** A later success on the old reference is "not found" and lost. A retry after a failure collides with the unique `orderId`, so the order is stuck. | Customers charged but orders unpaid; double charges; missing history that cannot be rebuilt | `payment.service.ts:248-259`, `schema.prisma:366` | Test |
| 7 | PAY-05 / CUR-01 / CUR-02 | **The paid amount and currency are never compared with the order.** The client picks the charge currency, and checkout sums prices in any currency as GHS. | Under-payment accepted as full payment | `payment.service.ts:261-283,347-363`, `create-payment.dto.ts:12-14` | Test (amount) |
| 8 | MONEY-01 / VAR-01 / CART-02 | **Discounts shown in the cart are not applied at checkout, and variants cannot be bought.** Every line is charged at `Product.price`. | Customers overcharged against the displayed price (Act 772 all-in price); variant prices never charged | `order.service.ts:316-343` | Reading |
| 9 | IAM-01 / IAM-02 / PLAT-02 | **Account takeover persists.** Social login links to any existing account with the same email. Password reset does not revoke refresh tokens. Refresh, reset and social tokens, and new and old passwords, are written to log files in clear text. | Compromised accounts stay compromised; credential exposure in logs | `users.service.ts:58-73`, `authentication.service.ts:87-122,162-181`, `useful-functions.ts:46-62` | Reading; logging by test |
| 10 | PERF-18 / OPS-01 / OPS-04 / DEP-01 | **The Docker image cannot start.** `node dist/main` doesn't exist; the build emits `dist/src/main.js`. It also runs as root on end-of-life Node 20, and cannot run migrations. | No deployable artefact; supply-chain exposure | `Dockerfile`, `tsconfig.build.json`, `dist/` listing | Build output |

Close behind these:
- **Coupon limit race (CPN-01).** The usage limit can be exceeded by parallel checkouts.
- **Unmatched city gets free delivery (SHZ-01).** Confirmed by test.
- **Product edits strip tax (TAX-01), and tax is not stored on orders (TAX-03).**
- **Draft products are public (PRD-02).**
- **Long passwords cannot sign in (IAM-05).** Passwords over 16 characters are rejected at sign-in. Confirmed by test.
- **Revenue analytics are wrong (ANA-01/02).** Revenue counts unpaid orders and ignores refunds.
- **E2E could wipe the dev database (QA-02).** The e2e helpers fall back to `.env` and delete data.
- **A database credential is committed in git (SEC-05).**

## 4. Decisions needed from Emmanuel

Full options and trade-offs are in the ADRs (`docs/roadmap/ADRs/`) and in `docs/audit/_work/gap-analysis.md` §3. All ADRs are **Proposed**.

| # | Decision | Options | Recommendation | Expensive to reverse? |
|---|---|---|---|---|
| 1 | **Tenancy** (ADR-0001) | A. one deployment per client · B. pooled multi-tenant SaaS (`storeId` + RLS) · C. marketplace · D. A now, pool-ready | **D**: a deployment per client with a `Store` row, global `cuid` IDs and a per-store order counter. Each client is merchant of record on their own Paystack account (BoG Notice 43). Revisit at ~10 clients. Marketplace only after legal sign-off. *If a marketplace is a 12-month goal, say so now; it changes the order model.* | Yes |
| 2 | **Product attribute model** (ADR-0002/0003) | Typed EAV · JSONB only · per-vertical tables · hybrid | **Hybrid:** product types with typed attribute definitions; JSONB values validated against them; relational variant option axes; typed capability columns (Rx, lots, serials, UoM, weight, fulfilment kind). **The variant/SKU is the only sellable unit.** | Yes (sellable unit) |
| 3 | **Payments for Ghana; pay-on-delivery at launch?** (ADR-0007) | Paystack only · Paystack + Flutterwave · direct MTN MoMo · Hubtel/ExpressPay; COD in or out | **Paystack first** (cards plus MTN, Telecel and AT MoMo at 1.95%, settled T+1 in GHS), behind a provider port. **COD in launch scope behind risk gates:** SMS-verified phone, caps, area allow-list, blacklist, optional MoMo deposit, plus a cash collection ledger. If the first client cannot run riders with cash reconciliation, launch prepaid-only. Flutterwave next. Confirm with Paystack: MoMo refunds, idempotency. | The payment ledger shape, yes |
| 4 | **Search engine** (ADR-0010) | Postgres FTS+trigram · Meilisearch · Typesense · OpenSearch | **Postgres now** behind a `SearchService`. Meilisearch when there are more than ~50k variants or facets get slow. | No |
| 5 | **GraphQL-only or public REST** (ADR-0012) | GraphQL only · + REST for integrations · public REST API · subscriptions | **GraphQL for first-party apps; REST only for `/webhooks/*` and `/integrations/v1/*` when a real integration needs it.** No speculative public API. No subscriptions yet (SMS plus polling). Schema-diff CI gate. | Publishing a public API is |
| 6 | **Legal and regulatory advice** | — | **Launch-gating:** a Ghanaian tax adviser (rounding, discount effect on the taxable base, shipping taxability, receipts/E-VAT, the 2026 VAT amendment); Data Protection Commission registration and Act 843 counsel; Act 772 storefront disclosures and return windows. **Pack-gating:** a health-regulatory lawyer before any pharmacy feature (Pharmacy Council e-pharmacy policy 2021, NEPP link, local data storage). **Gating:** a payments lawyer before any marketplace, wallet, store credit or gift card (BoG e-money rules). | — |
| 7a | **Money representation** (ADR-0004) | `Decimal` + Money type · integer minor units | **`Decimal(14,2)` behind a `Money` value object**, a lint ban on `Number()` for money, and **GraphQL `Money {amount: String, currency}` replacing `Float`**. That is one breaking change for frontends, done once in Phase 1. | Very |
| 7b | **Price semantics** | Store net · store as entered + `pricesIncludeTax` | **As entered, with `pricesIncludeTax`** (Ghana shelf prices are tax-inclusive; Act 772 requires all-in prices). Tax is computed per component at quote time and snapshotted. | Yes |
| 7c | **Job infrastructure** (ADR-0009/0011) | BullMQ+Redis · pg-boss · cloud queue | **BullMQ + transactional outbox, with a separate worker process.** This makes Redis mandatory in production. pg-boss is acceptable if you want fewer moving parts at launch. | Moderate |
| 7d | **Hosting & residency** (ADR-0016) | EU region · in-country · hybrid | **Per client.** App and DB always in the same region. Pharmacy clients on Ghana-hosted infrastructure, with prescriptions never stored on Cloudinary. | Yes |
| 7e | **Prisma 7 timing** (ADR-0017) | Now · first Phase 1 epic · later | **Pin 6.19 in Phase 0; upgrade first thing in Phase 1**, before the schema refactor. Re-baseline migrations once, only if no environment holds real data. | Moderate |
| 7f | **Phase 0 stop-gaps** | — | (a) In Phase 0, either fix discounts at checkout or switch discounts off until Phase 2 (P0-B.3). (b) Hide variant purchasing until Phase 1 (P0-B.11). (c) Freeze tax-rate changes until Phase 2, or apply the minimal fix (P0-B.10). | No |
| 7g | **Does any environment hold real customer or payment data?** | — | **Answered 2026-11-16: no real data yet.** So: re-baseline migrations once at the Prisma 7 upgrade (ADR-0017); restore the order-number start; no Paystack-export reconciliation is needed for DB-01 victims; legacy-data steps in the migration plan (M2, M3, M7 reports, M8 `pricingVersion = 0`) only apply to dev and seed data, which can be reset instead. | — |

## 5. What must happen before this takes real money from real customers

The full verifiable checklist (about 45 items) is in `docs/audit/_work/gap-analysis.md` §6. In short:

1. **All of Phase 0 done.** The 21 repro tests are green, and there are no open Critical or High findings.
2. **Phase 1 foundations live:** variant-as-SKU, `Money`, order and tax snapshots, the inventory reservation ledger, the payment ledger, the worker/outbox, RBAC with MFA for staff, CI/CD with drift and schema gates, managed Postgres with PITR plus a rehearsed restore.
3. **Money:** the charged amount equals the displayed amount for every promotion offered. No customer-callable total changes. Shipping never silently becomes 0. The currency is fixed server-side. One tested rounding rule, signed off by a tax adviser if the client is VAT-registered.
4. **Payments:** webhooks persisted and deduplicated, verified over the raw body, amount and currency checked, attempts never deleted, reconciliation job running with alerts, idempotent capped refunds, COD risk gates (if COD is enabled).
5. **Stock:** state-machine transitions only, no double restore (concurrency-tested), reservations expire exactly once across instances.
6. **Security & privacy:** no PII path from public types, GraphQL limits, no secrets in logs, session revocation, verified-email social linking, rotated leaked credential, supported runtimes.
7. **Legal (Ghana):** DPC registration, Act 772 disclosures and return windows, tax sign-off. No prescription-only medicine listed without the pharmacy pack and legal sign-off.
8. **Ops:** the image starts as non-root, migrations run as a release step, durable notifications over email **and SMS**, structured logs, error tracking and alerts, audit entries for every privileged mutation, and a load test meeting the targets in `03-performance-review.md` §7.

## 6. Recommended first three Phase 0 tasks
1. **P0-F.1 → F.5 → F.6: line endings, repaired unit suite, minimal CI.** Every later fix needs a trustworthy red/green signal. This is one or two sessions.
2. **P0-A.1: context-aware guards and interceptor.** It is the smallest change with the largest impact: it restores the Paystack webhook, payment initialisation, uploads and health, and turns the PLAT-01 and IAM-07 repro tests green.
3. **P0-A.2: field-level authorization on `User`/`Review`/`Order`.** This closes the Critical PII leak (SEC-01), with an anonymous e2e regression test.

Run P0-F.2 (e2e safety guard) and P0-F.3 (environment inventory and credential rotation) alongside these, because they are small and protect your data.

## 7. Audit method

**Agents used** (the model and effort per agent, as the brief requires):

| Agent | Model / effort | Why |
|---|---|---|
| Cartographer | Haiku / low | Mechanical inventory of 154 GraphQL ops, 8 REST routes, env vars, deps |
| Schema & data integrity | Opus / high | Cascades, money types and migration history are subtle and expensive |
| IAM & security | Opus / high | Account takeover and authz bugs; adversarial reasoning |
| Money | Opus / high | Rounding, stacking, concurrency on coupons |
| Order, inventory & payment | Opus / high | State machines, concurrency, webhook idempotency |
| Catalogue A (products, variants, categories, sub-categories) | Sonnet / high | Core catalogue, moderate risk |
| Catalogue B (brand, tag, pickup, shipping zones) | Sonnet / medium | Simpler CRUD |
| Customer features | Sonnet / high | Many object-level authz checks |
| Admin, analytics & platform | Sonnet / medium | Read-heavy, lower stakes |
| Quality & performance | Sonnet / high | Broad sweep; the orchestrator re-checked index claims |
| Dependencies & ops | Sonnet / medium | Analysis of tool output |
| Docs vs code | Sonnet / medium | Large mechanical comparison |
| Ghana research | Sonnet / high + web | Facts that change; cited sources |
| Domain gap analyst | Opus / high | Architecture-shaping synthesis |
| Orchestrator (this report, verification, repro tests, ADRs, roadmap) | Opus 5.5 | Final judgement |

**Verification:**
- **Re-checked against the code:** every Critical and High finding in §3, either by reading the cited code or by running a test (log: `tmp/audit/progress.md`, local only, not in git).
- **Repro tests:** 21 failing tests in 5 files, committed on branch `audit/repro-tests` (commit `df36384`), cut from `0f448fa`. Run them with `npx jest --config test/jest-repro.json`.
- **Not run:** e2e tests and migration drift. There is no `.env.test`, and the e2e helpers would wipe whatever database `.env` points at.
- **Not measured:** performance targets are proposals, not measurements.
- **Unverified research:** the Ghana tax, payment and legal facts come from cited web research (`_work/ghana-research.md`) and still need professional confirmation.

**Deviations from the brief:**
- Lint was run without `--fix`, because `npm run lint` auto-fixes.
- The repro branch lives in a separate git worktree, so your uncommitted changes on `main` were not touched.
- Area reports were drafted by agents and finalised by the orchestrator with verification notes.

**Local-only files:** `TODO.md` and the audit scratch files (agent brief, progress log, raw tool output, cartography, plan) were moved to the untracked `tmp/` folder on 2026-11-16. Findings that cite `TODO.md` refer to the file as it was at audit time; it is now at `tmp/TODO.md`.

**Index of outputs:** `00-system-map.md`, `01`–`06`, `modules/*.md` (31), `_work/` (baseline, cartography, money-flow, order-lifecycle, ghana-research, gap-analysis, progress), `docs/roadmap/ROADMAP.md`, `docs/roadmap/ADRs/0001–0017`, `docs/roadmap/WORKING-AGREEMENT.md`.
