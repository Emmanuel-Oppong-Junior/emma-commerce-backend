# Status

> **This file is the live state of the work.** It is updated at every checkpoint while working, not at the end of a session, because a session can stop at any moment. To resume ("continue"), read **Active task → Next step**, check it against git (see `CLAUDE.md` → Working state), and carry on. Keep it to about one screen.

**Last checkpoint:** 2026-11-16 · **Current phase:** Phase 0 — Stabilise (in progress) · **Plan:** [`ROADMAP.md`](ROADMAP.md)

## Active task
- **Task:** P0-F.6 — Minimal CI (QA-04, QA-08 `lint --fix` part)
- **Branch:** `chore/P0-F.6-minimal-ci` (from `dev`) · **State:** in progress
- **Baseline (dev @ a038906):** tsc 0, jest 62/62, prettier clean, prisma validate ok; eslint 1 error (`adminToken` unused, `test/e2e/order.e2e-spec.ts:14`); `npm audit --omit=dev --audit-level=critical` → 6 critical (form-data via paystack-api→request has no fix; removed by P0-C.4)
- **Steps:**
  - [x] Merge `audit/repro-tests` into this branch (merge commit `e762752`); repro specs prettier-formatted + 1 tsc fix (`platform.repro-spec.ts` handler type). 21/21 repro tests still fail as intended (PAY-01 repro checks the service call, so P0-F.5's repository guard doesn't turn it green)
  - [x] Scripts `typecheck`, `lint:check`, `format:check`, `test:repro`, `audit:prod`; unused `adminToken` + `signInAdmin` call/import removed from `test/e2e/order.e2e-spec.ts`
  - [x] Audit gate: `scripts/check-prod-audit.js` + `scripts/audit-allowlist.json` (5 critical advisories = npm's "6 critical" packages). Passes now; fails on an unlisted advisory; reports stale entries (both paths checked)
  - [x] `.github/workflows/ci.yml` (jobs `checks`, `audit`, `repro`; YAML parses): PRs to `main`/`dev`, push to `dev`; Node 20 (matches Dockerfile); npm ci → prisma generate/validate → typecheck → lint:check → format:check → jest --ci → audit gate; repro suite `continue-on-error`
  - [x] Run each step locally
  - [ ] Commit (waiting on Emmanuel), then mark QA-04/QA-08 in the audit, clear Active task, F.6 → done; push + branch protection are Emmanuel's  ← **Next step**
- **Uncommitted work:** `.github/workflows/ci.yml`, `scripts/check-prod-audit.js`, `scripts/audit-allowlist.json`, `package.json`, `test/e2e/order.e2e-spec.ts`, 2 repro specs (format) + `platform.repro-spec.ts`, STATUS.md
- **Last test run (2026-11-16, local Node 24):** prisma validate ok; `npm run typecheck` 0; `lint:check` 0; `format:check` 0; `npx jest --ci` 720/720; `audit:prod` 5/5 allowlisted (exit 0; unlisted-advisory path exits 1); `test:repro` 21/21 fail as expected. `prisma generate` failed locally only: EPERM, query-engine DLL locked by a running Node process (Windows). `npm ci` not run locally (would wipe the locked node_modules); deps unchanged
- **Not doable here:** proving the workflow on GitHub (needs a push, ask first); required-check branch protection (Emmanuel, GitHub settings)

**Last completed:** P0-F.5. Unit suite green: `npx jest` 62/62 suites, 720 tests (was 14 suites / 32 tests red); `npx tsc --noEmit -p tsconfig.json` 0 errors (was 14). Specs updated to current code, `src/...` imports made relative, order-spec DI fixed. Code change: payment success only moves an order PENDING → PROCESSING (`updateMany` guard, warns otherwise), which partly mitigates PAY-01. Audit marked: QA-01, QA-11, PAY-16 fixed; PRD-23, USR-13, DISC-11, ADR-10, REV-09, ORD-18 compile/DI parts fixed, coverage gaps remain.

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
| 1 | P0-F.6 Minimal CI | now | — (branch from `dev`) |
| 2 | P0-F.3 Environment inventory + gitleaks (credential file already untracked) | ∥ with 1 | Emmanuel rotates the DB password |
| 3 | P0-A.1 Context-aware guards and interceptor (fixes all REST routes) | after 1 | — |
| 4 | P0-A.2 Field-level authorization (Critical PII leak) | after 1, ∥ with 3 | — |

## Phase 0 progress
| Epic | Done / total | Done tasks |
|---|---|---|
| P0-F Safety rails | 3 / 7 | F.1 (`f2b323a`), F.2 (`758068c`), F.5 (`bcc995b`); (`TODO.md` retirement, part of F.4, done 2026-11-16) |
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
| 2026-11-16 | P0-F.6: npm audit gate blocks at critical with a checked-in allowlist of today's 6 known advisories (Emmanuel); CI on Node 20 to match the Dockerfile; unused `adminToken` deleted now so lint can be a gate (overrides the P0-F.1 deferral) | STATUS |
| 2026-11-16 | P0-F.5: keep payment re-initiate as delete-and-retry until P0-C.2 (Emmanuel); payment.service test rewritten to match. PENDING order guard implemented with `updateMany` (Claude's call) | STATUS |
| 2026-11-16 | Integration branch `dev` (created from `main` at `abb2f76`): task branches are cut from and merged into `dev`, not `main`. WORKING-AGREEMENT §1/§2 still say `main` | git, STATUS |
| 2026-11-16 | P0-F.1: Prettier-format the 3 drifted files in this task; unused `adminToken` left for P0-F.7 (Claude's call, Emmanuel can override) | STATUS |
| 2026-11-16 | No environment holds real customer or payment data, so migrations are re-baselined at the Prisma 7 upgrade | SUMMARY 7g, ADR-0017 |
| 2026-11-16 | Workflow setup merged into `main` (fast-forward to `4ddada7`), not pushed | git |
| 2026-11-16 | Workflow: untracked `tmp/` for scratch files; `STATUS.md` is the only state file, updated at every checkpoint | `CLAUDE.md`, WORKING-AGREEMENT §2a |

## ADR status
All 17 ADRs are **Proposed**. See [`ADRs/README.md`](ADRs/README.md).
