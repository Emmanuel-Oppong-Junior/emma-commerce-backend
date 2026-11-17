# Status

> **This file is the live state of the work.** It is updated at every checkpoint while working, not at the end of a session, because a session can stop at any moment. To resume ("continue"), read **Active task → Next step**, check it against git (see `CLAUDE.md` → Working state), and carry on. Keep it to about one screen.

**Last checkpoint:** 2026-11-16 · **Current phase:** Phase 0 — Stabilise (in progress) · **Plan:** [`ROADMAP.md`](ROADMAP.md)

## Active task
_None._ P0-A.5 done (`5e71ff2`), merged into `dev` and pushed; check its CI run. **Epic P0-A complete (5/5).** Take the first unblocked item in **Up next**.

**Last completed:** P0-A.5. GraphQL log lines: `op Name > rootField | Variables: {keys: "[redacted]"}`, no query text; Prisma errors logged by code (`Prisma P2002 on User.email`); email recipients masked; 4 local log files deleted. Unit 818/818, e2e 205/205, repro 8/21. Residual: GraphQL validation messages can quote a mistyped value (`formatError` logs them).

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
| 1 | P0-B.1 Order status transition table + conditional writes in the transaction (ADR-0014; ORD-02, ORD-04) | now | — (branch from `dev`) |
| 2 | P0-B.4 Shipping: unmatched city rejected, no silent free delivery (repro SHZ-01) | ∥ with 1 | — |
| 3 | P0-B.5 Pickup orders validate an active pickup location | ∥ | — |
| 4 | P0-B.6 Charge currency fixed server-side to GHS | ∥ | — |
| 5 | P0-F.3 Environment inventory + gitleaks (credential file already untracked) | ∥ | Emmanuel rotates the DB password |

## Phase 0 progress
| Epic | Done / total | Done tasks |
|---|---|---|
| P0-F Safety rails | 5 / 7 | F.1 (`f2b323a`), F.2 (`758068c`), F.5 (`bcc995b`), F.6 (`b94e75b`), F.7 (`9b3747b`); (`TODO.md` retirement, part of F.4, done 2026-11-16) |
| P0-A Request pipeline & access | **5 / 5** | A.1 (`e42d16e`), A.2 (`c788131`), A.3 (`c6f5fe5`), A.4 (`c3000bf`), A.5 (`5e71ff2`) |
| P0-B Orders & stock | 0 / 11 | |
| P0-C Payments | 0 / 7 | |
| P0-I Identity & sessions | 0 / 6 | |
| P0-O Deployability & ops | 0 / 7 | |
| P0-D Audit & analytics | 0 / 3 | |

Repro tests turned green: **8 / 21** (PLAT-01, IAM-07, SEC-01, PLAT-02 ×5) (`test/repro/` on `dev`, `npm run test:repro`; CI job `repro`).

## Waiting on Emmanuel
- [ ] In GitHub branch protection for `main` and `dev`, mark the `checks`, `e2e` and `audit` jobs as required (`dev` pushed 2026-11-16; CI run #1 on `43052f2` green: `checks` ✓, `audit` ✓, `repro` failed as expected).
- [ ] Decide what to do with `origin/main`: it shares no history with local `main`/`dev` (different root commits). Its history also contains a committed `.env` (`bcbae7b Delete .env`), so rotate whatever secrets it held.
- [ ] Tell the frontend: review queries must select `user { displayName }` instead of `user { name }` (P0-A.2); admin draft listing must use `adminProducts`/`adminProduct` (P0-A.3).
- [ ] Purge logs on any deployed server or log shipper (they may hold real refresh/reset tokens and PII from before P0-A.5); treat those tokens as compromised.
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
