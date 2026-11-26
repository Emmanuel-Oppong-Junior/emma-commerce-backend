# Playbook: zero-downtime migrations

How to change the schema while the API and the worker keep serving. It expands ROADMAP "Migration strategy (summary)"
rules 2-5 into steps, using this repository's own migrations as examples.

Related: [backup and restore](backup-and-restore.md) (backup and timed restore before every contract step).

## Why it matters here

A deploy is rolling: for a few minutes old and new API instances, and old and new workers, run side by side against
one database, and `prisma migrate deploy` runs **before** the new code starts (the old code is still serving when the
migration lands). So every migration must work with the code before it, and every release must work with the schema
before and after its own migration. Two rules follow:

1. **A migration never removes or renames something the running code still reads or writes.**
2. **A release never both starts depending on a new column and drops the old one** (ROADMAP rule 2).

Until the first client goes live ("No API clients yet" in `CLAUDE.md`, and no environment with real data), the
repository has shipped expand and contract in the same release for speed. The worked examples below show how each
should be split once a deployment holds real data.

## The four steps

| Step | Ships in | Schema | Code |
|---|---|---|---|
| 1. Expand | Release N | Add the new table/column/index, nullable or with a default; old columns stay | Old code ignores it; new code (if any) writes both |
| 2. Backfill | Release N (or a job after it) | Copy old → new in batches of 5k rows or fewer, idempotent, with a reconciliation report | Writes both (dual write) so rows created during the backfill are not missed |
| 3. Switch | Release N+1 | Constraints on the new shape (`NOT VALID`, then `VALIDATE`) | Reads and writes only the new shape; the old one is untouched |
| 4. Contract | Release N+2 | Drop the old columns/tables; fail fast if the backfill is behind | Nothing reads the old shape any more |

Before step 4: a fresh logical dump, a confirmed PITR restore point, and a timed restore rehearsal
(`bash scripts/dr/restore-drill.sh`, and on a production-sized copy when the table is large) (rule 5).

## Worked examples from this repository

**Variant as SKU (P1-V).** `20261121010000_default_variants` is a model expand + backfill: it creates a default
variant per product, copies price, stock, SKU and barcode, anchors old cart/order/stock rows on a "Legacy" variant,
reports what it could not map into `AuditLog` (read with `scripts/reports/variant-migration-report.sql`) and is safe to
re-run. `20261121020000_variant_contract` drops `Product` price/stock columns and `Variant.size/color`. They shipped
together; with real data the contract waits one release, after the report is clean and the code has read only
variants for a full release.

**Stock ledger (P1-N), order state machines (P1-O.2), promotions (P2-B.1), delivery zones (P5-A.1), pickup points
(P5-E.1).** Each `*_contract` migration starts with a guard that counts rows the backfill has not covered and raises an
exception instead of dropping them, for example `20261124010000_order_state_machines_contract`:

```sql
SELECT count(*) INTO behind FROM "Order" o
WHERE (o."trackingNumber" IS NOT NULL OR o.carrier IS NOT NULL)
  AND NOT EXISTS (SELECT 1 FROM "Shipment" s WHERE s."orderId" = o.id);
IF behind > 0 THEN RAISE EXCEPTION '% order(s) ... rerun the backfill ... first', behind; END IF;
```

Keep this pattern for every contract: the guard turns "dropped data the backfill missed" into "deploy failed, nothing
lost".

**Slugs (P8-C).** `20261217100000_content_seo` adds `slug` with a default `''`, a trigger that fills it on insert, a
re-runnable backfill, and a temporary partial unique index (`WHERE "slug" <> ''`) so the backfill cannot create
duplicates while old rows are still empty. `20261217100100_content_seo_contract` swaps it for the plain unique index
and adds the format CHECK, failing if any slug is still empty. A good shape; on a large table build both indexes
concurrently (below).

**Not zero-downtime: store features (P8-F).** `20261219100000_store_features` moves `Store.loyaltyEnabled` into
`StoreFeature` and drops the column **in the same migration**. During a rolling deploy the old code, still serving,
selects `Store.loyaltyEnabled` and fails until every instance runs the new release. Acceptable before launch; once live
it must be split:

1. Release N: create `StoreFeature`, copy the value, new code reads `StoreFeature` and still writes the column when the
   setting changes (or the setting is frozen for one release).
2. Release N+1: drop `Store.loyaltyEnabled`.

If a one-step change cannot be avoided (an emergency fix), treat it as planned downtime: announce it, scale the API to
zero and stop the workers, migrate, deploy, start. The outbox keeps events, Paystack redelivers webhooks, so a few
minutes of downtime lose nothing.

## Recipes

**Add a column.** Nullable, or `NOT NULL DEFAULT <constant>` (Postgres 11+ adds it without rewriting the table).
Never `NOT NULL` without a default on a table with rows.

**Make a column required.** Backfill first, then:

```sql
ALTER TABLE "T" ADD CONSTRAINT "T_col_not_null" CHECK ("col" IS NOT NULL) NOT VALID;  -- instant, new rows checked
-- after a query proves zero violators:
ALTER TABLE "T" VALIDATE CONSTRAINT "T_col_not_null";  -- scans without blocking writes
ALTER TABLE "T" ALTER COLUMN "col" SET NOT NULL;        -- uses the validated CHECK, no second scan
ALTER TABLE "T" DROP CONSTRAINT "T_col_not_null";
```

Prisma's `schema.prisma` then marks the field required; keep the migration SQL as above (hand-edited after
`--create-only`) and confirm `prisma migrate diff` reports no drift.

**Add a CHECK or a foreign key** to a table with rows: `ADD CONSTRAINT ... NOT VALID` in one migration, `VALIDATE
CONSTRAINT` in the next (or a later statement), after a clean-up query shows no violators. `NOT VALID` takes a brief
lock; `VALIDATE` scans under a lock that allows reads and writes. This repository has not needed it yet (tables were
small); `scripts/dr/verify.sql` fails on any constraint left unvalidated, so a forgotten `VALIDATE` shows up in the
drill.

**Add an index to a large table.** `CREATE INDEX` blocks writes for the whole build; `CREATE INDEX CONCURRENTLY` does
not, but cannot run inside a transaction block, and a migration file with several statements may be run as one. Pattern:

1. Before the deploy, run the statement by hand (or as a release step) against production:
   `CREATE INDEX CONCURRENTLY IF NOT EXISTS "T_col_idx" ON "T" ("col");`
   If it fails it leaves an INVALID index: `DROP INDEX CONCURRENTLY "T_col_idx";` and retry.
2. The migration contains the same index with `CREATE INDEX IF NOT EXISTS "T_col_idx" ON "T" ("col");`: a no-op where
   it already exists, a normal build on fresh, empty databases (CI, e2e, new deployments). Same name and definition as
   Prisma generates, so there is no drift.

Unique indexes the same way (`CREATE UNIQUE INDEX CONCURRENTLY`), then attach as a constraint if needed with
`ALTER TABLE ... ADD CONSTRAINT ... UNIQUE USING INDEX`.

**Rename a column or table.** Never in one step. Add the new one, dual-write, backfill, switch reads, drop the old one
(four steps above). A view or generated column is not a shortcut with Prisma.

**Change a column type.** Same as a rename (new column of the new type). Exceptions done in place: a longer
`varchar(n)`, or a `numeric` with more precision and the same scale (`20261119010000_widen_money_columns` notes it).
A change of scale, a shorter length or a different type rewrites the table under an exclusive lock.

**Enum values.** Adding a value is safe (`ALTER TYPE ... ADD VALUE`); new code must not write it until every old
instance is gone, because the old generated Prisma client does not know the value and may fail to read the row. Removing or renaming a value is a contract step.

**Triggers and functions.** Use `CREATE OR REPLACE FUNCTION` for a new body compatible with old code. Reference tables
schema-qualified or rely on the default `search_path` consistently; the restore drill restores every function and
trigger and probes the append-only ones, so run it after adding one.

**Backfills.** Idempotent (`WHERE new IS NULL`, `ON CONFLICT DO NOTHING`), batched (5k rows or fewer per transaction)
so locks stay short, and with a reconciliation report of what could not be mapped (`scripts/reports/*.sql`). Large
ones run as a job after the deploy, not inside `prisma migrate deploy`. Never guess money.

## Rolling deploy of the API and the worker

1. Take the pre-migration backup (contract steps: dump + PITR point + timed rehearsal).
2. Run `prisma migrate deploy` once, from one release job, before any new instance starts. On failure stop: the old
   release keeps serving. Prisma records the migration as failed in `_prisma_migrations`; check what it changed (a
   contract guard raises before changing anything), fix it, mark it with `prisma migrate resolve --rolled-back` and
   deploy again.
3. Roll the **worker** first: workers drain on SIGTERM (BullMQ finishes the running job), the outbox relay's
   `FOR UPDATE SKIP LOCKED` lets old and new workers share the work. Job payloads must stay readable by both versions
   during the overlap (add fields, do not rename them; event types are versioned, `*.v2` next to `*.v1`).
4. Roll the **API**, a few instances at a time, watching `api_errors_total` and `graphql_operation_duration_seconds`.
5. Only in a **later** release: the contract migration.

Rollback: Prisma has no down migrations. Roll the code back to release N-1, which still works because the expand step
removed nothing. A bad contract is rolled back by PITR to the restore point taken in step 1
([backup and restore](backup-and-restore.md), Procedure A).

## Checklist for a migration PR

- [ ] Works with the code currently deployed (nothing it drops or renames is still read or written).
- [ ] New columns nullable or with a constant default; `NOT NULL` via `NOT VALID` CHECK + `VALIDATE`.
- [ ] Indexes on large tables created concurrently before the deploy, `IF NOT EXISTS` in the migration.
- [ ] Backfill idempotent, batched, with a report; contract guarded by a "backfill behind" check.
- [ ] Contract in a later release than the code switch; backup + timed restore rehearsal before it.
- [ ] `prisma migrate diff` shows no drift; `bash scripts/dr/restore-drill.sh` passes.
