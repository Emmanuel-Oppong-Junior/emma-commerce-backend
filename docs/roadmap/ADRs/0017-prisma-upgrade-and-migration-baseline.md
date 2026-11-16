# ADR-0017 — Prisma 7 timing and migration baseline

Status: **Proposed** · Date: 2026-11-16

## Context
- **Prisma version and config.** The project is on Prisma 6.19, and the latest is 7.10. `package.json#prisma` config is deprecated in Prisma 7 in favour of `prisma.config.ts`, and the generator output path and driver adapters change (05-deps DEP-05).
- **Squashed migration history.** In commit `6b649e6`, 23 already-applied migrations were squashed into `20260412120208_first_migration` (DB-08). Any database that ran the old history cannot run `migrate deploy` cleanly. Order numbers restart at 1, not 10001.
- **No drift check.** No environment inventory exists, and there is no CI drift check.

**Answer 2026-11-16 (Emmanuel): no environment holds real customer or payment data.** The re-baseline path in step 3 applies.

## Recommendation
1. **Phase 0:** pin Prisma at `6.19.x` and do no upgrade. Make an inventory of every database that has run this schema (step 0 of the migration strategy).
2. **Phase 1, first epic, before the core schema refactor:** upgrade to Prisma 7. Doing it after the refactor would rewrite every repository twice. Prerequisites are CI and an e2e harness that runs against real Postgres. Verify `cuid()` support and driver-adapter behaviour under the concurrency tests.
3. **Re-baseline:**
   - **If no environment holds real data:** re-baseline the migrations once, at the upgrade. Restore the order-number start value. Never edit or squash applied migrations again; a CI check rejects changes to existing migration folders.
   - **If an environment does hold real data:** for each one, run `prisma migrate diff --from-url` against the schema, reconcile, then run `prisma migrate resolve --applied`.
4. **CI drift gate:** `prisma migrate diff --exit-code` between the migrations and the schema.

## Reversibility
Moderate.
