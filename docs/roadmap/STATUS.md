# Status

> **This file is the live state of the work.** It is updated at every checkpoint while working, not at the end of a session, because a session can stop at any moment. To resume ("continue"), read **Active task → Next step**, check it against git (see `CLAUDE.md` → Working state), and carry on. Keep it to about one screen.

**Last checkpoint:** 2026-11-16 · **Current phase:** Phase 0 — Stabilise (in progress) · **Plan:** [`ROADMAP.md`](ROADMAP.md)

## Active task
_None._ P0-F.6 done (`b94e75b`), fast-forward merged into `dev`, not pushed. Take the first unblocked item in **Up next**.

**Last completed:** P0-F.6. `.github/workflows/ci.yml` (Node 20): `checks` (npm ci, prisma generate/validate, typecheck, lint:check, format:check, jest --ci), `audit` (`scripts/check-prod-audit.js`: critical prod advisories vs `scripts/audit-allowlist.json`, 5 known), `repro` (allowed to fail). Repro suite merged into `dev`. All steps pass locally except the intended repro failures; **workflow not yet run on GitHub** (needs a push). Follow-ups: `npm audit fix` for the 4 fixable criticals (dependency update, needs approval); Node 20 is EOL (QA-16).

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
| 1 | P0-A.1 Context-aware guards and interceptor (fixes all REST routes) | now | — (branch from `dev`) |
| 2 | P0-A.2 Field-level authorization (Critical PII leak) | ∥ with 1 | — |
| 3 | P0-F.7 E2E in CI against a Postgres service container | ∥ with 1 | — |
| 4 | P0-F.3 Environment inventory + gitleaks (credential file already untracked) | ∥ | Emmanuel rotates the DB password |

## Phase 0 progress
| Epic | Done / total | Done tasks |
|---|---|---|
| P0-F Safety rails | 4 / 7 | F.1 (`f2b323a`), F.2 (`758068c`), F.5 (`bcc995b`), F.6 (`b94e75b`); (`TODO.md` retirement, part of F.4, done 2026-11-16) |
| P0-A Request pipeline & access | 0 / 5 | |
| P0-B Orders & stock | 0 / 11 | |
| P0-C Payments | 0 / 7 | |
| P0-I Identity & sessions | 0 / 6 | |
| P0-O Deployability & ops | 0 / 7 | |
| P0-D Audit & analytics | 0 / 3 | |

Repro tests turned green: **0 / 21** (`test/repro/` on `dev`, `npm run test:repro`; CI job `repro`).

## Waiting on Emmanuel
- [ ] Push `dev` so the CI workflow runs for the first time (Claude asks before pushing), then in GitHub branch protection for `main` and `dev` mark the `checks` and `audit` jobs as required.
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
