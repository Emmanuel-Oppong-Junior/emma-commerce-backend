# Checklist: quarterly disaster-recovery drill

Once a quarter, per live deployment, prove that a backup restores, that the restored data is sound, and how long it
takes. A backup that has never been restored is a hope, not a backup.

Related: [backup and restore](backup-and-restore.md), [Redis loss](redis-loss.md),
[zero-downtime migrations](zero-downtime-migrations.md).

## Targets (proposed, for Emmanuel to decide)

| Target | Proposed default | Why |
|---|---|---|
| **RPO** (data that may be lost) | 15 minutes or less with provider PITR; 24 hours if only nightly dumps exist | Orders and payments in the gap can be rebuilt from Paystack and customer emails, but each one costs support time; managed Postgres PITR usually ships WAL within minutes |
| **RTO** (time until the store serves again) | 2 hours or less | Covers deciding the restore point, the provider restore, the checks in the backup runbook and the switch-over, by one person following the runbook, for a single-store database of a few GB |
| PITR retention | 14 days | A data mistake is often noticed days later (a weekly report, a customer complaint) |
| Logical dumps | Nightly, kept 30 days; first of the month kept 12 months; one before every contract migration | Survives losing the provider account or region; the source of the drill copy |
| Drill frequency | Quarterly per deployment, plus before the first contract migration on real data | ROADMAP migration rule 5 |

Measured so far: the scripted local drill (`scripts/dr/restore-drill.sh`, 400 orders, about 8,800 rows, 1 MB dump)
restores and verifies in about 15 seconds; with `--orders 20000` (about 279,000 rows, 14 MB dump) in about 47 seconds
(2026-11-26, developer laptop, other workloads running). That proves the procedure, not the production RTO: the quarterly drill measures the
real one on a production-sized copy.

## Roles

| Role | Who (fill per deployment) | Does |
|---|---|---|
| Drill lead | | Runs the steps, keeps time, writes the record |
| Second person | | Follows along with the runbook, notes every place it was unclear or wrong |
| Approver | Emmanuel (or the client's owner) | Accepts the result, decides on follow-ups and target changes |

## Before the drill

- [ ] Pick the date; tell the client the drill touches no production traffic.
- [ ] Confirm access: provider console (PITR restore), the dump storage, the secret manager (encryption keys), a
      machine with Docker and this repository at the deployed commit.
- [ ] Confirm the latest nightly dump exists and its age is within the RPO target.
- [ ] Note the deployed commit and its latest migration.

## The drill

Record the clock time at each step.

1. [ ] **Scripted drill on the current code**: `bash scripts/dr/restore-drill.sh` passes (catches a migration that no
       longer restores cleanly). Attach its report from `tmp/dr/`.
2. [ ] **PITR restore**: restore production to a new instance at a chosen point (for example 30 minutes ago), same
       region. Time from request to "available".
3. [ ] **Dump restore**: restore last night's dump into another new database (backup runbook, Procedure B). Time it.
4. [ ] **Verify both** (backup runbook, "Verifying a restore"): `prisma migrate status`, drift check,
       `psql -f scripts/dr/verify.sql` (all `ok`), schema fingerprint identical to a freshly migrated database.
5. [ ] **Data spot checks** on the PITR copy: the newest order before the restore point is there with its payment
       intent; `SELECT max("orderNumber") FROM "Order"` and `"nextOrderNumber"` from `"Store"` agree with production at
       that time; a purchase order number sequence is past the last purchase order.
6. [ ] **App on the copy** (staging-like, never connected to production Redis, Paystack live keys or real email):
       start the API and a worker against it with a scratch Redis DB, check `/health/ready`, sign in as staff, open
       recent orders. Use the same encryption keys from the secret manager and confirm the Paystack settings page shows
       the stored key's last four digits (decryption works).
7. [ ] **Redis loss tabletop**: walk through [Redis loss](redis-loss.md) with the second person; run the outbox
       re-drive query (the review `SELECT` only) against the copy.
8. [ ] **Tear down** the restored instances and databases; confirm nothing restored is left running or exposed.

## Record the result

Copy this block into the deployment's ops log (one per drill):

```text
Drill date (UTC):            Deployment:            Deployed commit / last migration:
Drill lead:                  Second person:
Scripted drill:              PASS / FAIL   report: tmp/dr/restore-drill-<stamp>.txt
PITR restore:                requested hh:mm  available hh:mm  (minutes)   restore point:
Dump restore:                dump age (hours):  restore minutes:  dump size:
verify.sql:                  all ok / FAIL rows:
Fingerprint vs fresh schema: identical / differences:
App on the copy:             ok / problems:
Measured RTO (decision to verified copy):          target 2 h: met / missed
Measured RPO (restore point vs newest dump/WAL):   target 15 min: met / missed
Runbook corrections needed:
Follow-ups (owner, date):
Approved by:
```

## After the drill

- [ ] Fix every runbook step that was wrong or unclear (same week).
- [ ] If RTO or RPO missed its target: open a task (bigger instance class for restores, more frequent dumps, a
      standby replica) or change the target with the approver's agreement.
- [ ] If the fixture no longer covers a new table with an append-only trigger, the scripted drill fails: add rows for
      it in `scripts/dr/fixture.sql`.
