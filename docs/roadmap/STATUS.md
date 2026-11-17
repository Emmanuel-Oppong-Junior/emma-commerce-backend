# Status

> **This file is the live state of the work.** It is updated at every checkpoint while working, not at the end of a session, because a session can stop at any moment. To resume ("continue"), read **Active task → Next step**, check it against git (see `CLAUDE.md` → Working state), and carry on. Keep it to about one screen.

**Last checkpoint:** 2026-11-16 · **Current phase:** Phase 0 — Stabilise (in progress) · **Plan:** [`ROADMAP.md`](ROADMAP.md)

## Active task
**Parallel batch (in progress, 2026-11-17):** three sub-agents in their own git worktrees, each with its own e2e DB. Agents do not edit STATUS/audit; the orchestrator merges into `dev` and updates both.
- **Fulfilment** (P0-B.4 shipping, P0-B.5 pickup, P0-B.6 currency) · DB `emma_wt_fulfil_test` · only agent allowed a migration
- ~~**Identity**~~ ✅ merged + pushed: P0-I.1 (`d2445ad`), P0-I.6 (`d11e961`). Gates on dev: unit 905/905, e2e 212/212 (Linux node:20), repro 12/21. Frontend: sign-in accepts up to 128 chars; reset/change/admin-create now follow the full policy; forgotPassword limited 3/h per email
- **Ops** (P0-O.3 env validation, P0-O.5 health readiness, P0-O.7 email errors) · DB `emma_wt_ops_test`
- **Next step:** wait for agent reports → review diff, run gates on the merged result, merge into `dev`, update STATUS/audit per task.

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
| 1 | P0-B.4 Shipping: unmatched city rejected, no silent free delivery (repro SHZ-01) | now | — (branch from `dev`) |
| 2 | P0-B.5 Pickup orders validate an active pickup location | ∥ with 1 | — |
| 3 | P0-B.6 Charge currency fixed server-side to GHS | ∥ | — |
| 4 | P0-F.3 Environment inventory + gitleaks (credential file already untracked) | ∥ | Emmanuel rotates the DB password |

## Phase 0 progress
| Epic | Done / total | Done tasks |
|---|---|---|
| P0-F Safety rails | 5 / 7 | F.1 (`f2b323a`), F.2 (`758068c`), F.5 (`bcc995b`), F.6 (`b94e75b`), F.7 (`9b3747b`); (`TODO.md` retirement, part of F.4, done 2026-11-16) |
| P0-A Request pipeline & access | **5 / 5** | A.1 (`e42d16e`), A.2 (`c788131`), A.3 (`c6f5fe5`), A.4 (`c3000bf`), A.5 (`5e71ff2`) |
| P0-B Orders & stock | 2 / 11 | B.1 (`9028bb3`), B.2 (`a54fded`) |
| P0-C Payments | 0 / 7 | |
| P0-I Identity & sessions | 2 / 6 | I.1 (`d2445ad`), I.6 (`d11e961`); IAM-04 `jti` part of I.2 done in P0-F.7 |
| P0-O Deployability & ops | 0 / 7 | |
| P0-D Audit & analytics | 0 / 3 | |

Repro tests turned green: **12 / 21** (PLAT-01, IAM-07, SEC-01, PLAT-02 ×5, ORD-01, ORD-03, ORD-04, IAM-05) (`test/repro/` on `dev`, `npm run test:repro`; CI job `repro`).

## Waiting on Emmanuel
- [ ] In GitHub branch protection for `main` and `dev`, mark the `checks`, `e2e` and `audit` jobs as required (`dev` pushed 2026-11-16; CI run #1 on `43052f2` green: `checks` ✓, `audit` ✓, `repro` failed as expected).
- [ ] Decide what to do with `origin/main`: it shares no history with local `main`/`dev` (different root commits). Its history also contains a committed `.env` (`bcbae7b Delete .env`), so rotate whatever secrets it held.
- [ ] Tell the frontend: review queries must select `user { displayName }` instead of `user { name }` (P0-A.2); admin draft listing must use `adminProducts`/`adminProduct` (P0-A.3); invalid order status changes now return `CONFLICT` (P0-B.1); open orders must be cancelled before deleting (P0-B.2).
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
