# Runbook: Postgres backup and restore

Postgres is the system of record: orders, the payment ledger, stock, refunds, the outbox. This runbook covers how it
is backed up, how to restore it (to a point in time or from a dump) and how to prove the restored copy is sound. It is
provider-neutral until hosting is chosen (ADR-0016: one deployment per client, app and database in the same region;
backups stay in that region too, and pharmacy deployments keep them in Ghana).

Related: [Redis loss](redis-loss.md), [zero-downtime migrations](zero-downtime-migrations.md),
[quarterly drill](quarterly-drill-checklist.md). Tools: `scripts/dr/restore-drill.sh`, `scripts/dr/verify.sql`,
`scripts/dr/fingerprint.sql`.

## What a database backup does not cover

- **Encryption keys.** `PaymentProviderConfig.encryptedSecretKey` is encrypted with `PAYMENT_CONFIG_ENCRYPTION_KEY`,
  `User.mfaSecret` and the recovery-code hashes with `MFA_ENCRYPTION_KEY`. A restore is only usable with the same keys:
  keep them in the secret manager, backed up separately from the database and never in the same place as a dump.
  Losing `MFA_ENCRYPTION_KEY` means every staff member re-enrols MFA; losing `PAYMENT_CONFIG_ENCRYPTION_KEY` means the
  Owner re-enters the Paystack keys.
- **Redis** (queues, codes, counters): rebuilt, not restored. See [Redis loss](redis-loss.md).
- **Files in Cloudinary** (product images, proof-of-delivery photos): the database holds their URLs; the provider holds
  the files.
- **Paystack** holds the authoritative record of money that moved. After any restore that loses time, reconcile
  against it (below).

## Backups

Two kinds, for different failures. Run both once a database holds real data.

| | Provider PITR (point-in-time recovery) | Logical dump (`pg_dump --format=custom`) |
|---|---|---|
| What | Continuous WAL archiving plus periodic base backups, managed by the Postgres provider | A consistent snapshot of one database, as a file |
| Restores to | Any second inside the retention window | The moment the dump started |
| RPO | Seconds to minutes (WAL shipping lag) | Time since the last dump (24 h for a nightly dump) |
| Protects against | Bad deploy or migration, accidental delete or update, lost instance | All of those at coarser grain, plus losing the provider account or region; extracting one table; moving providers |
| Restore speed | Provider-dependent; whole instance | Proportional to size; `pg_restore --jobs` parallelises |
| Where it lives | The provider, in the deployment's region | Storage outside the provider account, same jurisdiction, encrypted at rest, access limited to ops |

**Proposed defaults (for Emmanuel to decide):** PITR on with 14 days of retention; a nightly logical dump kept 30
days plus the first dump of each month kept 12 months; an extra dump and a confirmed PITR restore point before every
contract migration (ROADMAP migration rule 5). Targets: see [quarterly drill](quarterly-drill-checklist.md).

Taking a logical dump (from a host with network access to the database and the Postgres 16 client, or a
`postgres:16` container):

```bash
pg_dump "$DATABASE_URL" --format=custom --compress=6 --file="emma-$(date -u +%Y%m%dT%H%M%SZ).dump"
pg_restore --list emma-*.dump > /dev/null   # the archive is readable
```

`pg_dump` takes a consistent snapshot without blocking writes. Use a role that can read every table; the dump includes
`_prisma_migrations`, sequences, triggers and functions, so the restored database is at the same migration.

## Restore: choosing the method

- Mistake inside the last 14 days (bad migration, wrong bulk update, deleted rows): **PITR** to just before it.
- Instance or region lost, provider account unusable, or need an older state: **logical dump**.
- One table damaged and the rest fine: restore a dump or PITR copy **next to** production and copy the rows back by
  hand, in a reviewed transaction. Never restore over the live database.

Always restore into a **new** database or instance. The old one stays untouched until the new one is verified, so the
restore can be repeated and the incident investigated.

## Procedure A: point-in-time restore

1. **Declare the incident** and freeze writes: scale the API to zero (or put it behind a maintenance response) and stop
   the workers. Payments that arrive meanwhile wait in Paystack and are redelivered as webhooks later.
2. **Pick the target time** `T`: the last moment the data was right. Use the audit log, the deploy time, the log
   timestamp of the bad request (search by `requestId`). Write it down in UTC.
3. **Restore with the provider** to a new instance at `T`, in the same region.
4. **Verify the new instance** (see "Verifying a restore"). Do not switch until it passes.
5. **Point the app at it**: set `DATABASE_URL` for the API and the worker and start them. Use a fresh, empty Redis DB
   index (`REDIS_DB`) or flush the old one: the old queues hold jobs for outbox events that no longer exist after `T`.
6. **Re-drive what Redis lost**: follow [Redis loss](redis-loss.md) steps 3 to 5 with the window `T - 1 hour` to `T`
   (events the relay published just before `T` may not have been processed).
7. **Reconcile the gap** between `T` and the freeze:
   - Payments: Paystack charges made in the gap belong to orders the database no longer has. Export the gap from the
     Paystack dashboard (or let the next `payments.diff-previous-day` run report mismatches) and treat unknown
     references like DB-01 victims: refund or recreate the order, never guess.
   - Customers who placed orders, registered or verified a phone in the gap must do it again; their confirmation emails
     already went out. Prepare a message for support.
   - Staff changes in the gap (prices, stock counts, refunds recorded as cash) are gone: the people who made them redo
     them from the audit log of the old instance.
8. **Keep the old instance** read-only for at least 7 days for investigation, then delete it.

## Procedure B: restore from a logical dump

```bash
createdb "$NEW_DATABASE"           # on the new instance
pg_restore --dbname="$NEW_DATABASE_URL" --no-owner --no-privileges --exit-on-error --jobs=4 emma-<stamp>.dump
vacuumdb --dbname="$NEW_DATABASE_URL" --analyze-only
```

`--no-owner --no-privileges` lets the restore run as the new instance's role; `--exit-on-error` stops at the first
problem instead of leaving a half-restored database; `--jobs` restores tables and builds indexes in parallel (it needs
a file, not a pipe). `analyze` matters: without statistics the first queries plan badly.

Then continue with Procedure A from step 4 (verify, switch, Redis, reconcile), with `T` = the time the dump started.

## Verifying a restore

Run all of these against the restored database before any traffic reaches it. The drill runs the same checks.

1. **Migrations**, from a checkout of the commit that is deployed:

   ```bash
   DATABASE_URL="$NEW_DATABASE_URL" npx prisma migrate status            # "Database schema is up to date"
   DATABASE_URL="$NEW_DATABASE_URL" npx prisma migrate diff --from-config-datasource \
     --to-schema prisma/schema.prisma --exit-code                           # exit 0: no drift
   ```

2. **Integrity**: `psql "$NEW_DATABASE_URL" -X -f scripts/dr/verify.sql`. It exits 3 on any FAIL row. It checks the
   stock ledger (levels = movements = active reservations, the nightly `inventory.reconcile-stock` queries), lots and
   serial units, the payment ledger (intent amounts, refunds within captures, intent status after refunds, cash
   collections and remittances), sequences at or past their columns, `Store.nextOrderNumber` past the last order,
   every append-only/forbid-delete trigger present and refusing its operation (probed inside a rolled-back
   transaction), no disabled trigger, no unvalidated constraint, and reports the unpublished outbox events (the worker
   publishes them once started). Safe on production: one transaction, rolled back.
3. **Schema fingerprint**: migrate an empty scratch database from the deployed commit (`prisma migrate deploy`), then
   compare its schema with the restored one:

   ```bash
   psql "$SCRATCH_URL" -X -At -v checksums=false -f scripts/dr/fingerprint.sql | grep -Ev '^(table|sequence)\|' > expected.txt
   psql "$NEW_DATABASE_URL" -X -At -v checksums=false -f scripts/dr/fingerprint.sql | grep -Ev '^(table|sequence)\|' > restored.txt
   diff expected.txt restored.txt        # no output: every trigger, constraint, index, function and enum is there
   ```

   When the source still exists (a dump restore), also compare full fingerprints with checksums (row counts and a
   checksum of every row per table): identical output means nothing was lost. Checksums read every row; run them on a
   replica or out of hours.
4. **Smoke test** once the app points at it: `/health/ready` on API and worker, sign in as staff, open a recent order,
   watch `outbox_unpublished_events` fall to near zero and `stock_reconciliation_mismatches_total` stay flat after the
   next reconciliation.

Known benign difference: a CHECK written with `BETWEEN` or nested `AND`s prints with fewer brackets after a restore
(Postgres re-parses `(a AND b) AND c` as `a AND b AND c`). `fingerprint.sql` ignores brackets in CHECK texts for that
reason; Prisma's drift check already treats them as equal.

## The restore drill

`bash scripts/dr/restore-drill.sh` rehearses Procedure B end to end on a throwaway copy, using only bash and Docker:

1. starts two `postgres:16` containers (`emma-dr-source`, `emma-dr-target`) on a private Docker network, no host ports;
2. builds the source in the e2e runner image: `prisma migrate deploy`, `prisma db seed`, then `scripts/dr/fixture.sql`
   (customers, staff, orders in every state with their payment ledger, refunds, a return, a dispute, COD collections
   and a remittance, shipments with proof of delivery, lot- and serial-tracked stock on a received purchase order,
   loyalty, consent, unpublished outbox events);
3. checks the source with `verify.sql` (the dataset itself must be consistent) and fingerprints it;
4. `pg_dump --format=custom`, then `pg_restore --jobs=4` into the target and `vacuumdb --analyze-only`;
5. checks the target: `prisma migrate status` + drift, `verify.sql`, and the full fingerprint diff against the source;
6. prints the timings, the measured RTO (restore + analyze + checks) and PASS/FAIL, writes the report to
   `tmp/dr/restore-drill-<stamp>.txt`, removes the containers, and exits 1 on any mismatch.

Options: `--orders N` (default 400) to grow the dataset, `--keep` to leave the containers for inspection (`--cleanup`
removes them). The drill also fails when the dataset stops covering what it should check: no unpublished outbox
event, or an append-only trigger on a table the fixture leaves empty. When a new append-only table is added, add a row
for it in `fixture.sql`.

Reference runs (2026-11-26, developer laptop): 400 orders (131 tables, about 8,800 rows, 1 MB dump): restore 3.9 s,
analyze 0.7 s, checks 10.5 s, measured RTO 15 s. `--orders 20000` (about 279,000 rows, 14 MB dump): restore 12.7 s,
analyze 4.6 s, checks 29.7 s, measured RTO 47 s; building that dataset takes about 6 minutes. The migration check runs
`npx prisma` in a container, so it dominates on a busy machine. Production restores scale with data size: rehearse
with a production-sized copy before trusting a target (see the quarterly checklist).

**Proposal (not set up):** a weekly CI job running `bash scripts/dr/restore-drill.sh` on `ubuntu-latest` (Docker is
available there; about 2 minutes), failing the run on a mismatch, so a migration that breaks restores (for example a
trigger function that depends on `search_path`) is caught within a week. It would need `.github/workflows` changes, so
it waits for Emmanuel's approval.
