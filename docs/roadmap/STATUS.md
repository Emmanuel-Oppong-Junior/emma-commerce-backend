# Status

> **This file is the live state of the work.** It is updated at every checkpoint while working, not at the end of a session, because a session can stop at any moment. To resume ("continue"), read **Active task → Next step**, check it against git (see `CLAUDE.md` → Working state), and carry on. Keep it to about one screen.

**Last checkpoint:** 2026-11-16 · **Current phase:** Phase 0 — Stabilise (in progress) · **Plan:** [`ROADMAP.md`](ROADMAP.md)

## Active task
**Follow-up on P0-F.7 (in progress):** CI run #5 on `3886cab`: `checks` ✓, `audit` ✓, **`e2e` ✗** (`npm run test:e2e` exit 1; logs need GitHub sign-in). Reproduced in a Linux `node:20` container (tag + category, 35 tests): old `clearDatabase` (`test/e2e.utils.ts`) skips `ReturnRequest`, so after payment-return runs, `order.deleteMany` hits `ReturnRequest_orderId_fkey`; Windows ran those suites first. Fix on `fix/P0-F.7-ci-e2e`: `clearDatabase` delegates to `resetDb`. Confirmed: Linux node:20 container 184/184; Windows clearDatabase suites 95/95. Next: commit/merge/push with Emmanuel's OK, then confirm CI `e2e` green.

**Last completed:** P0-F.7. CI `e2e` job (Postgres 16 service, `scripts/write-test-env.js`, migrate deploy, test:e2e). Specs: 11 `createOrder` calls updated; `refreshToken` + `signOut` e2e restored. IAM-04 fixed (`jwtid` on tokens). `ConfigModule` ignores `.env` when `NODE_ENV=test`. Local e2e 184/184, unit 775/775. Local container `emma-e2e-pg` left running (`docker rm -f emma-e2e-pg` to remove).

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
| 1 | P0-A.3 Public catalogue visibility (draft products, unpaginated nested products) | now | — (branch from `dev`) |
| 2 | P0-F.3 Environment inventory + gitleaks (credential file already untracked) | ∥ | Emmanuel rotates the DB password |

## Phase 0 progress
| Epic | Done / total | Done tasks |
|---|---|---|
| P0-F Safety rails | 5 / 7 | F.1 (`f2b323a`), F.2 (`758068c`), F.5 (`bcc995b`), F.6 (`b94e75b`), F.7 (`9b3747b`); (`TODO.md` retirement, part of F.4, done 2026-11-16) |
| P0-A Request pipeline & access | 2 / 5 | A.1 (`e42d16e`), A.2 (`c788131`) |
| P0-B Orders & stock | 0 / 11 | |
| P0-C Payments | 0 / 7 | |
| P0-I Identity & sessions | 0 / 6 | |
| P0-O Deployability & ops | 0 / 7 | |
| P0-D Audit & analytics | 0 / 3 | |

Repro tests turned green: **3 / 21** (PLAT-01, IAM-07, SEC-01) (`test/repro/` on `dev`, `npm run test:repro`; CI job `repro`).

## Waiting on Emmanuel
- [ ] In GitHub branch protection for `main` and `dev`, mark the `checks`, `e2e` and `audit` jobs as required (`dev` pushed 2026-11-16; CI run #1 on `43052f2` green: `checks` ✓, `audit` ✓, `repro` failed as expected).
- [ ] Decide what to do with `origin/main`: it shares no history with local `main`/`dev` (different root commits). Its history also contains a committed `.env` (`bcbae7b Delete .env`), so rotate whatever secrets it held.
- [ ] Tell the frontend: review queries must select `user { displayName }` instead of `user { name }` (P0-A.2).
- [ ] Rotate the DB password that was committed in `.claude/settings.local.json`. The file is untracked now, but the password is still in git history.
- [ ] Decide the Phase 0 stop-gaps before these tasks start:
  - **P0-B.3:** fix discounts at checkout, or switch them off until Phase 2?
  - **P0-B.10:** minimal tax fix, or freeze tax-rate changes?
  - **P0-B.11:** hide variant purchasing until Phase 1?
- [ ] Accept, amend or reject the ADRs (needed before **Phase 1**).

## Decisions log
| Date | Decision | Where recorded |
|---|---|---|
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
