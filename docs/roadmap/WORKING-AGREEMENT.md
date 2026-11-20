# Working agreement for executing the roadmap

How future Claude Code sessions (and humans) take work from `ROADMAP.md` to `main`. This file is the contract; if a session cannot follow it, the session stops and asks.

## 1. Unit of work
- **One epic per branch, one task per session.** A task from `ROADMAP.md` (ID `P<phase>-<epic>.<task>`, e.g. `P0-A.2`) is sized for one session. If it isn't, split it in `ROADMAP.md` first and get Emmanuel's OK.
- Branch naming: `<type>/<task-id>-<slug>`, e.g. `fix/P0-A.2-order-cancel-guard`, `feat/P1-C.1-money-value-object`, `chore/P0-F.1-gitattributes`. Types: `fix`, `feat`, `refactor`, `chore`, `docs`, `test`.
- Several tasks of the same epic may land on one epic branch (`epic/P1-C-money`) when they must ship together; each task is still its own commit.
- Tasks marked **parallel-safe** in the roadmap may run in separate sessions/worktrees at the same time; tasks marked **sequential** wait for their predecessors to merge.

## 2. Starting a session
1. Read `CLAUDE.md`, this file, the task in `ROADMAP.md`, the linked ADRs and the module report(s) in `docs/audit/modules/`.
2. Confirm the ADRs the task depends on are **Accepted**. If an ADR is still Proposed, stop and ask.
3. Restate the task's acceptance criteria and planned file list; for multi-file or design changes wait for go-ahead (global rule).
4. Create the branch from up-to-date `dev`.

## 2a. State tracking between sessions
- `docs/roadmap/STATUS.md` is the single source of truth for progress: current phase, active task with its exact next step, up next, blockers and decisions.
- It is updated **continuously at checkpoints** (task start, each finished step, each test run, each commit, blockers and decisions, task completion), never only at session end, because sessions can be deleted without warning. On resume it is cross-checked against git. See `CLAUDE.md` → Working state.
- `ROADMAP.md` is the plan and the at-a-glance checklist: each task is `- [ ]` to do, `- [ ] 🔄` in progress or `- [x]` done (with its commit), and a Progress table counts tasks per phase. Update the marks when a task starts and completes; change the plan itself (split or reorder tasks) only with Emmanuel's OK.
- Scratch and local-only files go in the gitignored `tmp/` folder.
- STATUS checkpoints are local edits made as the work happens; they are pushed together with the code, never in a push of their own (a lone checkpoint push once stalled a task for 98 minutes).

## 2b. Speed rules (Emmanuel, 2026-11-20)
1. Independent lanes run in parallel, each agent with its own worktree, `_test` database and Redis DB index; the orchestrator resolves conflicts in shared files.
2. While iterating, run only the affected tests (`npm test -- <paths>`, an e2e subset via `scripts/e2e/run.sh … <filter>`); run the full gates once at the end of each step and the full e2e suite once at the end of the task.
3. When `dev` fast-forwards to the exact commit the agent tested, the orchestrator does not re-run its gates: CI is the independent check. Gates are re-run when branches are combined or the orchestrator changes code.
4. Report once `dev` is pushed; CI is watched in the background and a failure is fixed straight away.
5. Each wrap-up collects the decisions the next task needs, so its agent starts on Emmanuel's go.
6. e2e runs through `scripts/e2e/run.sh`, which reuses a runner image with `node_modules` installed, rebuilt only when `package-lock.json` changes.
7. On large epics, steps the roadmap marks parallel (∥) may go to two agents.

## 3. Definition of done (every task)
- [ ] **A failing test first** for every bug fix (use or extend the matching file on `audit/repro-tests` / `test/repro/`; once fixed, move the test into the module's spec and delete the repro copy).
- [ ] New behaviour covered by unit tests of the pure logic and at least one integration test against real Postgres for anything touching transactions, locking, constraints or money.
- [ ] `npx tsc --noEmit -p tsconfig.json` (includes specs) passes; `npx eslint` (no `--fix` in CI) passes; `npx prettier --check` passes; `npx jest` passes; e2e passes when the task touches an API flow.
- [ ] **Migrations:** generated with `prisma migrate dev --create-only`, reviewed by hand, expand/contract for anything that renames/drops; never edit an applied migration; data backfills are idempotent scripts; `prisma migrate diff` shows no drift.
- [ ] **Money:** no `number` arithmetic on money; uses the `Money` value object (ADR-0004) once it exists.
- [ ] **Security checklist:** object-level authz on every new resolver/field; no `User`/PII on public types; DTO whitelist; rate limit on sensitive mutations; no secrets/PII in logs; errors mapped to standard codes.
- [ ] **API:** `schema.gql` regenerated and committed; breaking changes called out (CI `graphql-inspector`) and marked `[breaking-api]` (allowed freely until the first frontend or client integrates: see `CLAUDE.md` → "No API clients yet"); `FRONTEND_API_DOCUMENTATION.md` updated for every changed operation (docs must match code — they were 40 discrepancies behind).
- [ ] **Docs:** module report in `docs/audit/modules/<module>.md` updated: findings fixed get `Status: Fixed in <commit>`; verdict changed if the definition of done is now met; ADR status updated if the task implements one.
- [ ] `docs/roadmap/STATUS.md` shows the task completed: Active task cleared, progress counts updated (see §2a); the task ticked in `ROADMAP.md` with its commit and the Progress table updated.
- [ ] Report what ran (commands), what passed, what failed, what wasn't run.

## 4. Updating verdicts
A module moves to **CLOSED** only when every item in its "Definition of done to close this module" is satisfied and evidenced (test names/commits). Whoever closes it edits the verdict line to `Verdict: CLOSED (YYYY-MM-DD, <commit>)` and updates the verdict table in `docs/audit/SUMMARY.md`.

## 5. Commits and PRs
- Once every gate passes, commit, merge into `dev` and push `dev` without asking (Emmanuel, 2026-11-17); see §2b for which gates the orchestrator re-runs. Ask only when a product or business decision is needed, or before moving to the next phase. Pushing `main` still needs Emmanuel's say-so. Message: short imperative subject focused on why, referencing the task ID: `Guard order cancel against repeat stock restore (P0-A.2)`.
- PR description: task ID, findings closed (IDs), tests added, migration notes, rollback notes.
- No `--no-verify`, no force-push to shared branches.

## 6. Safety rails
- Never run `npm run test:e2e` unless `.env.test` exists **and** its `DATABASE_URL` database name ends in `_test` (P0-F.2 adds this guard in code).
- Never run `prisma migrate reset`/`db push` against anything but a local or test database.
- Never print `.env` values or secrets.
- Paystack: test keys only outside production.

## 7. Proposed `CLAUDE.md` for this repo
(Adopted into `CLAUDE.md` in P0-F.4, adapted to what the code enforces today; kept here for reference.)

```markdown
# CLAUDE.md

NestJS 10 + Apollo GraphQL (code-first) + Prisma/PostgreSQL e-commerce backend, Ghana-first (GHS, Paystack, MoMo, COD).

## Source of truth
- Progress and the next task: `docs/roadmap/STATUS.md`. Read it first; update it at every checkpoint while working, and cross-check it with git on resume.
- Plan: `docs/roadmap/ROADMAP.md` (task IDs P<phase>-<epic>.<task>). Rules: `docs/roadmap/WORKING-AGREEMENT.md`.
- Decisions: `docs/roadmap/ADRs/` — only implement Accepted ADRs.
- Known defects per module: `docs/audit/modules/<module>.md`. Update findings and verdicts when you fix them.
- `FRONTEND_API_DOCUMENTATION.md` must be updated with every API change.

## Commands
- Typecheck incl. specs: `npx tsc --noEmit -p tsconfig.json`   (the build excludes specs — don't rely on `npm run build`)
- Lint (check only): `npx eslint "{src,test}/**/*.ts"`   (`npm run lint` auto-fixes)
- Unit tests: `npx jest`   · Repro/regression: `npx jest --config test/jest-repro.json`
- E2E: `npm run test:e2e` — ONLY with `.env.test` pointing at a `*_test` database.
- Prisma: `npx prisma migrate dev --create-only` then review SQL; `npx prisma generate`.

## Non-negotiables
- Money: integer minor units via `Money` (ADR-0004). Never `Number()` money. Prices are always recomputed server-side.
- Stock: change only via reservation/movement APIs (ADR-0008); never write absolute quantities.
- Status changes: only via the state machine with conditional updates (ADR-0014).
- Authz: every resolver AND every sensitive field resolver has an explicit policy. Never expose `User` on public types.
- Guards/interceptors must work for both `http` and `graphql` contexts.
- Side effects (email, SMS, indexing) go through the outbox/queue, never fire-and-forget.
- No secrets or PII in logs.

## Layout
feature/{module,resolver,service,repository}.ts, dto/, entities/, enums/; pure domain logic in `feature/domain/*.ts` (no I/O, fully unit-tested).
```
