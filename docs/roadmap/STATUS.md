# Status

> **This file is the live state of the work.** It is updated at every checkpoint while working, not at the end of a session, because a session can stop at any moment. To resume ("continue"), read **Active task → Next step**, check it against git (see `CLAUDE.md` → Working state), and carry on. Keep it to about one screen.

**Last checkpoint:** 2026-11-16 · **Current phase:** Phase 0 — Stabilise (in progress) · **Plan:** [`ROADMAP.md`](ROADMAP.md)

## Active task
- **Task:** P0-A.4 — GraphQL hardening (PLAT-05, PERF-01, DOC-06, USR-14)
- **Branch:** `fix/P0-A.4-graphql-hardening` (from `dev` @ `ca25094`) · **State:** in progress
- **Steps:**
  - [x] `graphql-query-complexity@2.0.0` added (pulls `lodash.get`, deprecated but tiny)
  - [x] `src/commons/graphql/query-limits.ts`: depth ≤ 8 + aliases ≤ 15 validation rules, cost ≤ **3000** plugin (1000 was too low: a 50-product page with variants + reviews ≈ 2800); introspection exempt. 12 unit tests
  - [x] Landing page disabled in production (`ApolloServerPluginLandingPageDisabled`)
  - [x] `src/commons/filters/error-classification.ts` used by `AllExceptionsFilter` (13 unit tests). ValidationPipe failures → `InputValidationException` → `BAD_USER_INPUT`; the 7 duplicated pipe configs now use `createValidationPipe()` (`src/commons/validation-pipe.ts`). `formatError` treats `GRAPHQL_VALIDATION_FAILED`/`GRAPHQL_PARSE_FAILED` as safe
  - [x] `test/e2e/graphql-hardening.e2e-spec.ts` 8/8 (deleting a category with sub-categories → `CONFLICT`, was 500). CLAUDE.md + frontend docs updated
  - [x] Gates (2026-11-17): typecheck 0; lint:check 0; format clean; `npx jest --ci` 808/808; repro 3/21; `audit:prod` 5/5 allowlisted (no new critical); e2e Linux node:20 205/205
  - [ ] Commit/merge/push (waiting on Emmanuel); mark PLAT-05/PERF-01/DOC-06/USR-14 in audit; clear Active task  ← **Next step**
- **Uncommitted work:** STATUS.md only

**Previously:** P0-A.3 done (`c6f5fe5`), CI green on `ca25094`.

**Last completed:** P0-A.3. Public `products`/`product` show only active + `PUBLISHED`; new `adminProducts`/`adminProduct` (ADMIN, SUPER_ADMIN) and `status` filter; nested `products` on Category/SubCategory/Brand published-only, `first` 1–100 (default 20). Seeds set `PUBLISHED`. Unit 784/784, e2e 197/197 (Linux node:20). **Breaking for the admin UI:** draft listing must use `adminProducts`/`adminProduct`. Not fixed: drafts can be added to cart; expiry (PRD-04); one query per parent for nested products.

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
| 1 | P0-A.4 GraphQL hardening: depth/complexity/alias limits, landing page off in prod, Prisma error codes | now | — (branch from `dev`) |
| 2 | P0-A.5 Logging: no variable values or tokens in logs (repro PLAT-02) | ∥ with 1 | — |
| 3 | P0-F.3 Environment inventory + gitleaks (credential file already untracked) | ∥ | Emmanuel rotates the DB password |

## Phase 0 progress
| Epic | Done / total | Done tasks |
|---|---|---|
| P0-F Safety rails | 5 / 7 | F.1 (`f2b323a`), F.2 (`758068c`), F.5 (`bcc995b`), F.6 (`b94e75b`), F.7 (`9b3747b`); (`TODO.md` retirement, part of F.4, done 2026-11-16) |
| P0-A Request pipeline & access | 3 / 5 | A.1 (`e42d16e`), A.2 (`c788131`), A.3 (`c6f5fe5`) |
| P0-B Orders & stock | 0 / 11 | |
| P0-C Payments | 0 / 7 | |
| P0-I Identity & sessions | 0 / 6 | |
| P0-O Deployability & ops | 0 / 7 | |
| P0-D Audit & analytics | 0 / 3 | |

Repro tests turned green: **3 / 21** (PLAT-01, IAM-07, SEC-01) (`test/repro/` on `dev`, `npm run test:repro`; CI job `repro`).

## Waiting on Emmanuel
- [ ] In GitHub branch protection for `main` and `dev`, mark the `checks`, `e2e` and `audit` jobs as required (`dev` pushed 2026-11-16; CI run #1 on `43052f2` green: `checks` ✓, `audit` ✓, `repro` failed as expected).
- [ ] Decide what to do with `origin/main`: it shares no history with local `main`/`dev` (different root commits). Its history also contains a committed `.env` (`bcbae7b Delete .env`), so rotate whatever secrets it held.
- [ ] Tell the frontend: review queries must select `user { displayName }` instead of `user { name }` (P0-A.2); admin draft listing must use `adminProducts`/`adminProduct` (P0-A.3).
- [ ] Rotate the DB password that was committed in `.claude/settings.local.json`. The file is untracked now, but the password is still in git history.
- [ ] Decide the Phase 0 stop-gaps before these tasks start:
  - **P0-B.3:** fix discounts at checkout, or switch them off until Phase 2?
  - **P0-B.10:** minimal tax fix, or freeze tax-rate changes?
  - **P0-B.11:** hide variant purchasing until Phase 1?
- [ ] Accept, amend or reject the ADRs (needed before **Phase 1**).

## Decisions log
| Date | Decision | Where recorded |
|---|---|---|
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
