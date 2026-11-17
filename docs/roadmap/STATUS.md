# Status

> **This file is the live state of the work.** It is updated at every checkpoint while working, not at the end of a session, because a session can stop at any moment. To resume ("continue"), read **Active task → Next step**, check it against git (see `CLAUDE.md` → Working state), and carry on. Keep it to about one screen.

**Last checkpoint:** 2026-11-16 · **Current phase:** Phase 0 — Stabilise (in progress) · **Plan:** [`ROADMAP.md`](ROADMAP.md)

## Active task
_None._ Parallel batch 2 (2026-11-17) done and merged into `dev`. Next: P0-B.8 / P0-O.6 (migrations, one at a time). Worktrees `b2-*` under `.claude/worktrees/` can be removed.

**Last completed (batch 2):** P0-O.1 (`a98a123`), P0-O.4 (`c51ee81`), P0-I.5 (`fc59f37`), P0-B.7 (`97c1978`), P0-B.9 (`c38316c`). Combined gates on dev: typecheck/lint/format clean, unit 1041/1041, build → `dist/main.js`, e2e 228/228 (Linux node:20), repro 13/21 (no repro tests for these findings). New CI job `docker` builds the image and smoke-runs `/health/live`. Follow-ups noted: no migration release step/`migrate:deploy` script (OPS-20); liveness depends on DB (Prisma connects at boot); `OTEL_EXPORTER_OTLP_ENDPOINT` is also read as base URL so metrics go to a wrong path; payment-success vs expiry not atomic (PAY); FAILED payment row blocks retry (PAY-04); refunds don't release coupons (policy); CI test jobs still Node 20.

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
| 2 | P0-B.8 stock writes + `CHECK (quantity >= 0)` (migration), P0-O.6 indexes (migration) | now, one at a time | migrations |
| 3 | P0-C.1 payment ledger schema (ADR-0007, big migration) → C.2 → C.3 | sequential | ADR-0007 still Proposed |
| 4 | P0-B.3 discounts, P0-B.10 tax, P0-B.11 variants | — | Emmanuel's stop-gap decisions |
| 5 | P0-O.2 dependency upgrades | — | Emmanuel's approval |
| 6 | P0-F.3 Environment inventory + gitleaks | — | Emmanuel rotates the DB password |

## Phase 0 progress
| Epic | Done / total | Done tasks |
|---|---|---|
| P0-F Safety rails | 5 / 7 | F.1 (`f2b323a`), F.2 (`758068c`), F.5 (`bcc995b`), F.6 (`b94e75b`), F.7 (`9b3747b`); (`TODO.md` retirement, part of F.4, done 2026-11-16) |
| P0-A Request pipeline & access | **5 / 5** | A.1 (`e42d16e`), A.2 (`c788131`), A.3 (`c6f5fe5`), A.4 (`c3000bf`), A.5 (`5e71ff2`) |
| P0-B Orders & stock | 7 / 11 | B.1 (`9028bb3`), B.2 (`a54fded`), B.4 (`53c3da4`), B.5 (`1d33fff`), B.6 (`ff15318`), B.7 (`97c1978`), B.9 (`c38316c`) |
| P0-C Payments | 0 / 7 | |
| P0-I Identity & sessions | 3 / 6 | I.1 (`d2445ad`), I.5 (`fc59f37`), I.6 (`d11e961`); IAM-04 `jti` part of I.2 done in P0-F.7 |
| P0-O Deployability & ops | 5 / 7 | O.1 (`a98a123`), O.3 (`fd0543c`), O.4 (`c51ee81`), O.5 (`66eb517`), O.7 (`e18cf27`) |
| P0-D Audit & analytics | 0 / 3 | |

Repro tests turned green: **13 / 21** (PLAT-01, IAM-07, SEC-01, PLAT-02 ×5, ORD-01, ORD-03, ORD-04, IAM-05, SHZ-01) (`test/repro/` on `dev`, `npm run test:repro`; CI job `repro`).

## Waiting on Emmanuel
- [ ] In GitHub branch protection for `main` and `dev`, mark the `checks`, `e2e` and `audit` jobs as required (`dev` pushed 2026-11-16; CI run #1 on `43052f2` green: `checks` ✓, `audit` ✓, `repro` failed as expected).
- [ ] Decide what to do with `origin/main`: it shares no history with local `main`/`dev` (different root commits). Its history also contains a committed `.env` (`bcbae7b Delete .env`), so rotate whatever secrets it held.
- [ ] Tell the frontend: review queries must select `user { displayName }` instead of `user { name }` (P0-A.2); admin draft listing must use `adminProducts`/`adminProduct` (P0-A.3); invalid order status changes now return `CONFLICT` (P0-B.1); open orders must be cancelled before deleting (P0-B.2); Order gains `subtotal`, `shippingFee`, `pickupLocationSnapshot`; createOrder rejects uncovered cities, inactive pickup locations and non-GHS products; zone city overlaps → CONFLICT; payment `currency` must be GHS if sent (P0-B.4–B.6); uploads are admin-only (customers 403), non-JPEG/PNG/WebP or >40 MP → 400, missing file → 400; an ADMIN acting on any ADMIN account (incl. own via `updateUser`/`removeUser`) → FORBIDDEN (P0-I.5); a coupon at its limit now fails at checkout with BAD_REQUEST, and cancelled/expired orders give the use back (P0-B.9).
- [ ] Deployment (P0-O.1): image is now Node 24, runs as non-root, CMD `node dist/main.js`, HEALTHCHECK on `/health/live`. Add a release step that runs `npx prisma migrate deploy` once per release with the image (e.g. `docker run --rm -e DATABASE_URL=… <image> npx prisma migrate deploy`). Consider marking the new CI `docker` job as required too.
- [ ] Purge logs on any deployed server or log shipper (they may hold real refresh/reset tokens and PII from before P0-A.5); treat those tokens as compromised.
- [ ] Add `NODE_ENV=development` to your local `.env` if it is missing (now required, P0-O.3), and update `.env.example` with: NODE_ENV, PORT, ALLOWED_ORIGINS, LOG_LEVEL, DATABASE_URL, JWT_SECRET/JWT_REFRESH_SECRET/JWT_RESET_SECRET (≥32 chars, all different), JWT_TOKEN_AUDIENCE, JWT_TOKEN_ISSUER, JWT_ACCESS/REFRESH/RESET_TOKEN_TTL, GOOGLE_CLIENT_ID/SECRET, FACEBOOK_APP_ID/SECRET, PAYSTACK_SECRET_KEY, PAYSTACK_CALLBACK_URL, CLOUDINARY_CLOUD_NAME/API_KEY/API_SECRET, REDIS_HOST (prod)/PORT/PASSWORD, RESEND_API_KEY, RESEND_FROM_EMAIL, OTEL_ENABLED (true|false), OTEL_SERVICE_NAME, OTEL_EXPORTER_OTLP_ENDPOINT, SUPER_ADMIN_EMAIL/PASSWORD.
- [ ] On your machine: stop the dev server, run `npx prisma generate` (local generate hit the Windows DLL lock) and `npx prisma migrate dev` to apply `20261117111256_add_order_fee_breakdown_and_pickup_snapshot`. Dev seeder has no shipping zones: create zones (e.g. Greater Accra) or delivery orders will now be rejected.
- [ ] Rotate the DB password that was committed in `.claude/settings.local.json`. The file is untracked now, but the password is still in git history.
- [ ] Decide the Phase 0 stop-gaps before these tasks start:
  - **P0-B.3:** fix discounts at checkout, or switch them off until Phase 2?
  - **P0-B.10:** minimal tax fix, or freeze tax-rate changes?
  - **P0-B.11:** hide variant purchasing until Phase 1?
- [ ] Accept, amend or reject the ADRs (needed before **Phase 1**).

## Decisions log
| Date | Decision | Where recorded |
|---|---|---|
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
