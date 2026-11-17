# Status

> **This file is the live state of the work.** It is updated at every checkpoint while working, not at the end of a session, because a session can stop at any moment. To resume ("continue"), read **Active task → Next step**, check it against git (see `CLAUDE.md` → Working state), and carry on. Keep it to about one screen.

**Last checkpoint:** 2026-11-16 · **Current phase:** Phase 0 — Stabilise (in progress) · **Plan:** [`ROADMAP.md`](ROADMAP.md)

## Active task
- **Task:** Parallel batch 3 (2026-11-17): P0-I.2 + P0-I.3 (identity agent), P0-C.1 (payments agent), P0-F.4 (orchestrator) · **State:** in progress
- **Worktrees** (based on `dev` `da2c42a`, under `.claude/worktrees/`):
  - `b3-identity` · `fix/p0-i2-i3-sessions-social-login` · e2e DB `emma_wt_identity_test`
  - `b3-payments` · `feat/p0-c1-payment-ledger-schema` · e2e DB `emma_wt_fulfil_test` (only migration in this batch)
- P0-D.2 moved after C.1 (revenue depends on the new payment/refund tables). I.3 without email verification: never auto-link to an existing local account; require sign-in to link (I.4 later allows verified linking).
- **Steps:**
  - [x] worktrees created
  - [x] P0-F.4 done (`ab01fcd`, docs only): CLAUDE.md gains project line, check-only commands, Non-negotiables (matched to current code; ADR-0004/0008/0014 still Proposed); WORKING-AGREEMENT §5 now records the commit/merge/push rule, branches from `dev`
  - [x] P0-C.1 merged (`ddc81cb`, migration `20261117220000_payment_ledger`): gates on dev unit 1053/1053, e2e 247/247, repro 14/21 (PAY-03 green), drift exit 0; backfill proven by the agent on seeded legacy rows. Pushed.
  - [ ] identity agent (P0-I.2, I.3) still implementing ← **Next step** (if a session died: check `b3-identity` `git log dev..HEAD`)
  - [ ] review, rebase, gates (unit + Linux e2e + migrate deploy + drift), merge, audit, push

**Last completed:** P0-O.6 (`26efe7d`, migration `20261117210000_add_hot_query_indexes_drop_redundant`): adds `OrderItem(orderId)`, `Order(createdAt)`, `Order(status, createdAt)`; drops 9 redundant/unused indexes; keeps `Product(isActive, status)` (used by the public catalogue since P0-A.3); Payment reference unique left for P0-C.1. New e2e `db-indexes` failed 5/5 before the migration; after deploy the schema/DB drift check is empty. Unit 1050/1050, e2e 240/240, repro 13/21.

**Earlier:** P0-B.8 (`53b736f`, migration `20261117200000_add_stock_non_negative_checks`). `quantity` removed from UpdateProductInput/UpdateVariantInput (`stockStatus` stays editable, Emmanuel); new `adjustProductStock`/`adjustVariantStock` (signed delta, required reason, never below 0, ADJUSTMENT log); checkout decrement conditional on `quantity >= n`; DB CHECK `quantity >= 0` on Product and Variant. Unit 1050/1050, e2e 236/236 (Linux node:20, migration applied), repro 13/21. Deferred: initial stock on create is still unlogged; variant `price` still written directly. Changed existing tests: variant e2e update inputs no longer send `quantity` (admin update now asserts stock unchanged); order unit test mocks the new null-on-short-stock contract.

**Last completed (batch 2):** P0-O.1 (`a98a123`), P0-O.4 (`c51ee81`), P0-I.5 (`fc59f37`), P0-B.7 (`97c1978`), P0-B.9 (`c38316c`). Combined gates on dev: typecheck/lint/format clean, unit 1041/1041, build → `dist/main.js`, e2e 228/228 (Linux node:20), repro 13/21 (no repro tests for these findings). New CI job `docker` builds the image and smoke-runs `/health/live`. CI on `d60f230`: checks, e2e, audit, docker ✓; repro fails as expected. Follow-ups noted: no migration release step/`migrate:deploy` script (OPS-20); liveness depends on DB (Prisma connects at boot); `OTEL_EXPORTER_OTLP_ENDPOINT` is also read as base URL so metrics go to a wrong path; payment-success vs expiry not atomic (PAY); FAILED payment row blocks retry (PAY-04); refunds don't release coupons (policy); CI test jobs still Node 20.

**Earlier (batch 1):** P0-I.1 (`d2445ad`), P0-I.6 (`d11e961`); P0-O.3 (`fd0543c`), P0-O.5 (`66eb517`), P0-O.7 (`e18cf27`); P0-B.4 (`53c3da4`, migration `20261117111256_add_order_fee_breakdown_and_pickup_snapshot`), P0-B.5 (`1d33fff`), P0-B.6 (`ff15318`). Combined gates on dev: unit 983/983, e2e 218/218 (Linux node:20, migration applied), repro 13/21. One rebase conflict (two imports in payment.service.ts), resolved by keeping both. Worktrees started from old `main`; agents re-based onto `dev` themselves — set the base explicitly next time.

**Last completed:** P0-B.2. Soft delete only for DELIVERED/CANCELLED, never moves stock; refunds move money only (returned goods restocked by admin via `restockProduct`); cancellation is the single automatic restore, one log per item. Unit 861/861, e2e 212/212, repro 11/21. **Admin UI:** open orders must be cancelled before deleting.

<!-- Shape while a task is active (keep it current):
- **Task:** P0-X.n — <title>
- **Branch:** <type>/<task-id>-<slug> · **State:** in progress | blocked | in review
- **Steps:**
  - [x] step done (commit abc1234 / files touched)
  - [ ] step in progress  ← **Next step** (exact next action)
  - [ ] step to do
- **Uncommitted work:** <files changed but not committed, or "none">
- **Last test run:** <command> → <result>
- **Gotchas:** …
-->

## Up next (in order)
| # | Task | Run | Blocked by |
|---|---|---|---|
| 1 | Batch 3 candidates (∥, nothing pending): P0-I.2 refresh-token rotation/revocation then P0-I.3 social-login linking (one identity agent, same module), P0-D.2 revenue definition (analytics; now after P0-C.1) | now | one agent per module |
| 1b | P0-I.4 email verification (likely migration; after I.2, shares revoke-on-email-change), P0-D.1 audit log in privileged mutations (touches many modules: run alone) | after batch 3 | file overlap |
| 3 | P0-C.2 → C.3 → C.4–C.7, then P0-D.2 (revenue on the new ledger) | sequential (payment module) | — |
| 4 | P0-B.3 discounts, P0-B.10 tax, P0-B.11 variants | — | Emmanuel's stop-gap decisions |
| 5 | P0-O.2 dependency upgrades | — | Emmanuel's approval |
| 6 | P0-F.3 Environment inventory + gitleaks | — | Emmanuel rotates the DB password |

## Phase 0 progress
| Epic | Done / total | Done tasks |
|---|---|---|
| P0-F Safety rails | 6 / 7 | F.1 (`f2b323a`), F.2 (`758068c`), F.4 (`ab01fcd`), F.5 (`bcc995b`), F.6 (`b94e75b`), F.7 (`9b3747b`); (`TODO.md` retirement, part of F.4, done 2026-11-16) |
| P0-A Request pipeline & access | **5 / 5** | A.1 (`e42d16e`), A.2 (`c788131`), A.3 (`c6f5fe5`), A.4 (`c3000bf`), A.5 (`5e71ff2`) |
| P0-B Orders & stock | 8 / 11 | B.1 (`9028bb3`), B.2 (`a54fded`), B.4 (`53c3da4`), B.5 (`1d33fff`), B.6 (`ff15318`), B.7 (`97c1978`), B.8 (`53b736f`), B.9 (`c38316c`) |
| P0-C Payments | 1 / 7 | C.1 (`ddc81cb`) |
| P0-I Identity & sessions | 3 / 6 | I.1 (`d2445ad`), I.5 (`fc59f37`), I.6 (`d11e961`); IAM-04 `jti` part of I.2 done in P0-F.7 |
| P0-O Deployability & ops | 6 / 7 | O.1 (`a98a123`), O.3 (`fd0543c`), O.4 (`c51ee81`), O.5 (`66eb517`), O.6 (`26efe7d`), O.7 (`e18cf27`) |
| P0-D Audit & analytics | 0 / 3 | |

Repro tests turned green: **14 / 21** (PAY-03, PLAT-01, IAM-07, SEC-01, PLAT-02 ×5, ORD-01, ORD-03, ORD-04, IAM-05, SHZ-01) (`test/repro/` on `dev`, `npm run test:repro`; CI job `repro`).

## Waiting on Emmanuel
- [ ] In GitHub branch protection for `main` and `dev`, mark the `checks`, `e2e` and `audit` jobs as required (`dev` pushed 2026-11-16; CI run #1 on `43052f2` green: `checks` ✓, `audit` ✓, `repro` failed as expected).
- [ ] Decide what to do with `origin/main`: it shares no history with local `main`/`dev` (different root commits). Its history also contains a committed `.env` (`bcbae7b Delete .env`), so rotate whatever secrets it held.
- [ ] Tell the frontend: review queries must select `user { displayName }` instead of `user { name }` (P0-A.2); admin draft listing must use `adminProducts`/`adminProduct` (P0-A.3); invalid order status changes now return `CONFLICT` (P0-B.1); open orders must be cancelled before deleting (P0-B.2); Order gains `subtotal`, `shippingFee`, `pickupLocationSnapshot`; createOrder rejects uncovered cities, inactive pickup locations and non-GHS products; zone city overlaps → CONFLICT; payment `currency` must be GHS if sent (P0-B.4–B.6); uploads are admin-only (customers 403), non-JPEG/PNG/WebP or >40 MP → 400, missing file → 400; an ADMIN acting on any ADMIN account (incl. own via `updateUser`/`removeUser`) → FORBIDDEN (P0-I.5); a coupon at its limit now fails at checkout with BAD_REQUEST, and cancelled/expired orders give the use back (P0-B.9); `updateProduct`/`updateVariant` no longer accept `quantity` (HTTP 400 schema error): stock edits use `restockProduct`/`restockVariant` or the new `adjustProductStock`/`adjustVariantStock(input: { …Id, delta, reason })` (P0-B.8).
- [ ] **Payment ledger deploy (P0-C.1), irreversible:** before deploying, run `DATABASE_URL=… node scripts/payment-ledger-backfill-report.js` against the target DB and resolve any BLOCKING rows; take a backup; deploy app + `migrate deploy` together (old code needs `Payment`, new code needs the ledger). Afterwards ops must match every Paystack reference against the Paystack export (unknown successes = customers charged on unpaid orders → refund or fulfil), confirm each backfilled Refund (PENDING → PROCESSED/FAILED), and review flagged `completed_payment_on_unpaid_or_cancelled_order` rows. Frontend: `removePayment` removed; `PaymentStatus.ABANDONED` added; payment lists now show one row per attempt.
- [ ] Deployment (P0-O.1): image is now Node 24, runs as non-root, CMD `node dist/main.js`, HEALTHCHECK on `/health/live`. Add a release step that runs `npx prisma migrate deploy` once per release with the image (e.g. `docker run --rm -e DATABASE_URL=… <image> npx prisma migrate deploy`). Consider marking the new CI `docker` job as required too.
- [ ] Purge logs on any deployed server or log shipper (they may hold real refresh/reset tokens and PII from before P0-A.5); treat those tokens as compromised.
- [ ] Add `NODE_ENV=development` to your local `.env` if it is missing (now required, P0-O.3), and update `.env.example` with: NODE_ENV, PORT, ALLOWED_ORIGINS, LOG_LEVEL, DATABASE_URL, JWT_SECRET/JWT_REFRESH_SECRET/JWT_RESET_SECRET (≥32 chars, all different), JWT_TOKEN_AUDIENCE, JWT_TOKEN_ISSUER, JWT_ACCESS/REFRESH/RESET_TOKEN_TTL, GOOGLE_CLIENT_ID/SECRET, FACEBOOK_APP_ID/SECRET, PAYSTACK_SECRET_KEY, PAYSTACK_CALLBACK_URL, CLOUDINARY_CLOUD_NAME/API_KEY/API_SECRET, REDIS_HOST (prod)/PORT/PASSWORD, RESEND_API_KEY, RESEND_FROM_EMAIL, OTEL_ENABLED (true|false), OTEL_SERVICE_NAME, OTEL_EXPORTER_OTLP_ENDPOINT, SUPER_ADMIN_EMAIL/PASSWORD.
- [ ] On your machine: stop the dev server, run `npx prisma generate` (local generate hit the Windows DLL lock) and `npx prisma migrate dev` to apply `20261117111256_add_order_fee_breakdown_and_pickup_snapshot` `20261117200000_add_stock_non_negative_checks` and `20261117210000_add_hot_query_indexes_drop_redundant` (the stock one fails if any product/variant has negative stock: fix those first). Dev seeder has no shipping zones: create zones (e.g. Greater Accra) or delivery orders will now be rejected.
- [ ] Rotate the DB password that was committed in `.claude/settings.local.json`. The file is untracked now, but the password is still in git history.
- [ ] Decide the Phase 0 stop-gaps before these tasks start:
  - **P0-B.3:** fix discounts at checkout, or switch them off until Phase 2?
  - **P0-B.10:** minimal tax fix, or freeze tax-rate changes?
  - **P0-B.11:** hide variant purchasing until Phase 1?
- [ ] Accept, amend or reject the ADRs (needed before **Phase 1**).

## Decisions log
| Date | Decision | Where recorded |
|---|---|---|
| 2026-11-17 | P0-C.1 (Claude, within ADR-0007): one PaymentIntent per order (`orderId` unique; drop it if a MoMo deposit ever needs a second intent); legacy refunds backfilled as Refund PENDING; WebhookEvent stays deletable for pruning; expand+contract in one guarded, lossless migration | STATUS |
| 2026-11-17 | ADR-0007 (payment provider port + payment-attempt ledger + idempotent webhook inbox; Paystack first) **Accepted** (Emmanuel). Unblocks P0-C.1–C.7 | ADR-0007, STATUS |
| 2026-11-17 | P0-B.8: `stockStatus` stays editable on product updates; only `quantity` leaves the update inputs (Emmanuel). Initial-stock logging on create deferred (Claude) | STATUS |
| 2026-11-17 | Working rules (Emmanuel): once all gates pass, commit, merge into `dev` and push `dev` without asking; ask only for real decisions or a phase change. Independent tasks run in parallel via worktree sub-agents grouped by module (one migration at a time). Overrides WORKING-AGREEMENT "commit only when Emmanuel asks" | STATUS, memory |
| 2026-11-17 | P0-B.2: refunds never restock; returned goods go back via admin `restockProduct` after inspection (Emmanuel). Soft delete limited to CANCELLED/DELIVERED (Claude, per ORD-03 fix) | STATUS |
| 2026-11-17 | P0-B.1: unpaid ONLINE orders leave PENDING only via confirmed payment; admins cannot move them to PROCESSING by hand (Emmanuel). Missed webhooks wait for reconciliation (P0-C.5) | STATUS |
| 2026-11-17 | P0-A.4: add `graphql-query-complexity` for cost limits (Emmanuel); depth/alias limits hand-written (no `graphql-depth-limit`, unmaintained) | STATUS |
| 2026-11-17 | P0-A.3: admins see drafts via new `adminProducts`/`adminProduct` queries; public `products`/`product` always filtered (Emmanuel). Admin UI must switch its draft listing | STATUS |
| 2026-11-16 | P0-A.2: public reviewer name = first name + last initial ("Kwame A."), "Customer" when no name (Emmanuel). Field name stays `Review.user`, type becomes `PublicProfile`; field middleware, not `fieldResolverEnhancers` (Claude, per ADR-0012) | STATUS |
| 2026-11-16 | Force-pushed local `dev` over `origin/dev` (was `9f98050`, whose commits all remain in `origin/main`); local and remote histories are unrelated (Emmanuel) | git, STATUS |
| 2026-11-16 | P0-F.6: npm audit gate blocks at critical with a checked-in allowlist of today's 6 known advisories (Emmanuel); CI on Node 20 to match the Dockerfile; unused `adminToken` deleted now so lint can be a gate (overrides the P0-F.1 deferral) | STATUS |
| 2026-11-16 | P0-F.5: keep payment re-initiate as delete-and-retry until P0-C.2 (Emmanuel); payment.service test rewritten to match. PENDING order guard implemented with `updateMany` (Claude's call) | STATUS |
| 2026-11-16 | Integration branch `dev` (created from `main` at `abb2f76`): task branches are cut from and merged into `dev`, not `main`. WORKING-AGREEMENT §1/§2 still say `main` | git, STATUS |
| 2026-11-16 | P0-F.1: Prettier-format the 3 drifted files in this task; unused `adminToken` left for P0-F.7 (Claude's call, Emmanuel can override) | STATUS |
| 2026-11-16 | No environment holds real customer or payment data, so migrations are re-baselined at the Prisma 7 upgrade | SUMMARY 7g, ADR-0017 |
| 2026-11-16 | Workflow setup merged into `main` (fast-forward to `4ddada7`), not pushed | git |
| 2026-11-16 | Workflow: untracked `tmp/` for scratch files; `STATUS.md` is the only state file, updated at every checkpoint | `CLAUDE.md`, WORKING-AGREEMENT §2a |

## ADR status
All 17 ADRs are **Proposed**. See [`ADRs/README.md`](ADRs/README.md).
