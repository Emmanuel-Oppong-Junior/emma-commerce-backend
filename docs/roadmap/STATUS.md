# Status

> **This file is the live state of the work.** It is updated at every checkpoint while working, not at the end of a session, because a session can stop at any moment. To resume ("continue"), read **Active task → Next step**, check it against git (see `CLAUDE.md` → Working state), and carry on. Keep it to about one screen.

**Last checkpoint:** 2026-11-16 · **Current phase:** Phase 0 — Stabilise (in progress) · **Plan:** [`ROADMAP.md`](ROADMAP.md)

## Active task
- **Task:** P0-F.2 — E2E safety guard + `.env.test.example` + fix `db.helper.ts` (QA-02, DOC-11)
- **Branch:** `fix/P0-F.2-e2e-db-guard` (from `main` `abb2f76`) · **State:** in progress
- **Steps:**
  - [x] Branch created; plan approved incl. adding `test/helpers` to unit Jest roots in `package.json`
  - [x] Guard `test/helpers/test-database-guard.ts` + spec (6 tests); `test/setup.ts` requires `.env.test`, loads with `override: true`, asserts DB name ends `_test`; `package.json` jest `roots` += `test/helpers`
  - [x] `.env.test.example` (required vars only, incl. `JWT_RESET_SECRET`); `db.helper.ts` `taxRate` → `tax`; `CLAUDE.md` testing note
  - [x] Verified (see Last test run); QA-02 / DOC-11 marked fixed (commit pending) in `docs/audit/04-…` and `06-…`
  - [ ] Commit when Emmanuel asks ← **Next step**
- **Uncommitted work:** `test/setup.ts`, `test/helpers/{test-database-guard.ts,test-database-guard.spec.ts,db.helper.ts}`, `.env.test.example`, `package.json`, `CLAUDE.md`, audit docs 04/06, `STATUS.md`
- **Last test run:** 2026-11-16 `npx jest test-database-guard` → 6/6 pass; `npx jest` → 14 failed / 48 passed suites (same 14 as before, P0-F.5); `npx tsc --noEmit -p tsconfig.json` → 14 errors (was 15; `taxRate` gone); eslint on touched files clean; `prettier --check` pass; e2e run of `tag.e2e-spec.ts` without `.env.test` (dummy unreachable `DATABASE_URL`) → aborts in `setup.ts`, 0 tests ran.

**Last completed:** P0-F.1. eslint 29,611 → 1 error (unused `adminToken`, left for P0-F.7); `prettier --check` passes. Gotcha for other Windows clones: after pulling, run `git ls-files -z | xargs -0 touch && git checkout-index -f -a && git add --renormalize .` to get an LF working tree (`checkout-index` skips entries whose stat is fresh).

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
| 1 | P0-F.2 E2E safety guard + `.env.test.example` + fix `db.helper.ts` | now | — |
| 2 | P0-F.3 Environment inventory + gitleaks (credential file already untracked) | ∥ with 1 | Emmanuel rotates the DB password |
| 3 | P0-F.5 Repair the 14 failing unit suites | ∥ with 1 | — |
| 4 | P0-F.6 Minimal CI | after 3 | — |
| 5 | P0-A.1 Context-aware guards and interceptor (fixes all REST routes) | after 4 | — |
| 6 | P0-A.2 Field-level authorization (Critical PII leak) | after 4, ∥ with 5 | — |

## Phase 0 progress
| Epic | Done / total | Done tasks |
|---|---|---|
| P0-F Safety rails | 1 / 7 | F.1 (`f2b323a`); (`TODO.md` retirement, part of F.4, done 2026-11-16) |
| P0-A Request pipeline & access | 0 / 5 | |
| P0-B Orders & stock | 0 / 11 | |
| P0-C Payments | 0 / 7 | |
| P0-I Identity & sessions | 0 / 6 | |
| P0-O Deployability & ops | 0 / 7 | |
| P0-D Audit & analytics | 0 / 3 | |

Repro tests turned green: **0 / 21** (branch `audit/repro-tests`, `test/repro/`).

## Waiting on Emmanuel
- [ ] Rotate the DB password that was committed in `.claude/settings.local.json`. The file is untracked now, but the password is still in git history.
- [ ] Decide the Phase 0 stop-gaps before these tasks start:
  - **P0-B.3:** fix discounts at checkout, or switch them off until Phase 2?
  - **P0-B.10:** minimal tax fix, or freeze tax-rate changes?
  - **P0-B.11:** hide variant purchasing until Phase 1?
- [ ] Accept, amend or reject the ADRs (needed before **Phase 1**).

## Decisions log
| Date | Decision | Where recorded |
|---|---|---|
| 2026-11-16 | P0-F.1: Prettier-format the 3 drifted files in this task; unused `adminToken` left for P0-F.7 (Claude's call, Emmanuel can override) | STATUS |
| 2026-11-16 | No environment holds real customer or payment data, so migrations are re-baselined at the Prisma 7 upgrade | SUMMARY 7g, ADR-0017 |
| 2026-11-16 | Workflow setup merged into `main` (fast-forward to `4ddada7`), not pushed | git |
| 2026-11-16 | Workflow: untracked `tmp/` for scratch files; `STATUS.md` is the only state file, updated at every checkpoint | `CLAUDE.md`, WORKING-AGREEMENT §2a |

## ADR status
All 17 ADRs are **Proposed**. See [`ADRs/README.md`](ADRs/README.md).
