# Status

> **This file is the live state of the work.** It is updated at every checkpoint while working, not at the end of a session, because a session can stop at any moment. To resume ("continue"), read **Active task → Next step**, check it against git (see `CLAUDE.md` → Working state), and carry on. Keep it to about one screen.

**Last checkpoint:** 2026-11-16 · **Current phase:** Phase 0 — Stabilise (in progress) · **Plan:** [`ROADMAP.md`](ROADMAP.md)

## Active task
- **Task:** P0-F.5 — Repair the 14 failing unit suites (QA-01, QA-11)
- **Branch:** `fix/P0-F.5-unit-suite` (from `dev`) · **State:** in progress
- **Baseline:** `npx jest` 14/62 suites, 32/560 tests fail; `npx tsc --noEmit -p tsconfig.json` 14 errors (all specs). Raw: `tmp/jest-baseline.txt`, `tmp/tsc-baseline.txt`
- **Steps:**
  - [x] Group A spec drift: products ×3 (+3 new tax/sort tests), discount ×2, review, users.resolver (also `adminUpdateUser` drift hidden behind the TS error), addresses.resolver (+1 ADMIN-without-userId test). All 12 related suites green
  - [x] Group B: `src/...` imports → relative (`discount.resolver.ts`, `commons/upload.controller.ts`)
  - [x] Group C: mock `ReturnsService` / `UsersLoader`; plus 2 drifts hidden behind DI errors (address test lacked an active user; `createOrderFromCart` now takes a params object). Order suites 50/50 green
  - [x] Group D (payment + users suites 105/105 green; `updateOrderStatus` now returns whether it moved the order, service warns when it didn't): users.service tests updated + SUPER_ADMIN-never-listed test; payment.repository include test updated; PENDING guard implemented via `updateMany` (test kept, asserts `updateMany`); payment.service re-init test rewritten to current delete-and-retry behaviour
  - [x] Run jest, tsc, lint check, prettier check
  - [ ] Commit (waiting on Emmanuel's go-ahead), then mark QA-01/QA-11 `Fixed in <hash>` in `docs/audit/04-tests-and-quality.md`, clear Active task, F.5 → done  ← **Next step**
- **Uncommitted work:** 17 files under `src/` (13 specs, 4 source) + STATUS.md (all on `fix/P0-F.5-unit-suite`)
- **Last test run (2026-11-16):** `npx jest` → 62/62 suites, 720/720 tests; `npx tsc --noEmit -p tsconfig.json` → 0 errors; `npx eslint <changed .ts>` → clean; `npx prettier --check <changed .ts>` → clean
- **Gotchas:** PENDING guard uses `updateMany`, not `update`: `verifyPayment` has no already-completed short-circuit, so webhook + callback both verify, and `update` would throw P2025 on the second.

**Last completed:** P0-F.2. E2E setup aborts unless `.env.test` exists and its DB name ends `_test` (guard + 6 unit tests); `.env.test.example` added; tsc 15 → 14 errors. Open: README e2e instructions (DOC-11, not in scope); Emmanuel to eyeball `.env.test.example` (Claude is blocked from reading `.env*`).

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
| 1 | P0-F.5 Repair the 14 failing unit suites | now | — (branch from `dev`) |
| 2 | P0-F.3 Environment inventory + gitleaks (credential file already untracked) | ∥ with 1 | Emmanuel rotates the DB password |
| 3 | P0-F.6 Minimal CI | after 1 | — |
| 4 | P0-A.1 Context-aware guards and interceptor (fixes all REST routes) | after 3 | — |
| 5 | P0-A.2 Field-level authorization (Critical PII leak) | after 3, ∥ with 4 | — |

## Phase 0 progress
| Epic | Done / total | Done tasks |
|---|---|---|
| P0-F Safety rails | 2 / 7 | F.1 (`f2b323a`), F.2 (`758068c`); (`TODO.md` retirement, part of F.4, done 2026-11-16) |
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
| 2026-11-16 | P0-F.5: keep payment re-initiate as delete-and-retry until P0-C.2 (Emmanuel); payment.service test rewritten to match. PENDING order guard implemented with `updateMany` (Claude's call) | STATUS |
| 2026-11-16 | Integration branch `dev` (created from `main` at `abb2f76`): task branches are cut from and merged into `dev`, not `main`. WORKING-AGREEMENT §1/§2 still say `main` | git, STATUS |
| 2026-11-16 | P0-F.1: Prettier-format the 3 drifted files in this task; unused `adminToken` left for P0-F.7 (Claude's call, Emmanuel can override) | STATUS |
| 2026-11-16 | No environment holds real customer or payment data, so migrations are re-baselined at the Prisma 7 upgrade | SUMMARY 7g, ADR-0017 |
| 2026-11-16 | Workflow setup merged into `main` (fast-forward to `4ddada7`), not pushed | git |
| 2026-11-16 | Workflow: untracked `tmp/` for scratch files; `STATUS.md` is the only state file, updated at every checkpoint | `CLAUDE.md`, WORKING-AGREEMENT §2a |

## ADR status
All 17 ADRs are **Proposed**. See [`ADRs/README.md`](ADRs/README.md).
