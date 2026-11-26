# Runbook: Redis lost or flushed

Redis holds no system of record. Orders, payments, stock, refunds and the outbox live in Postgres; Redis holds queues,
short-lived security state, counters and caches. Losing it (instance replaced, data flushed, failover to an empty
replica) interrupts work in flight and signs some users out of short flows, but loses no order or payment. This runbook
says what goes, what heals by itself and what an operator re-drives.

Related: [backup and restore](backup-and-restore.md) (Postgres), [quarterly drill](quarterly-drill-checklist.md).

## Symptoms

- `/health/ready` fails on the API and the worker (`PING`), the `WorkerDependencyUnavailable` alert fires, and the
  orchestrator stops routing traffic to the API.
- Redis is required at startup (`REDIS_HOST`), so new instances do not start until Redis answers.
- After Redis comes back empty: `queue_jobs` drops to zero, the failed-jobs list (`failedJobs`) is empty, users are
  asked to sign in to step-up again.

## What is lost, and what the app does about it

| What lived in Redis | Lifetime | Effect of losing it | Recovery |
|---|---|---|---|
| BullMQ jobs waiting, delayed or running (`notifications`, `webhooks`, `maintenance`, `imports` queues) | Until processed | Emails and SMS not sent; webhook jobs not run; an import job stops | See "Re-drive the outbox" and the rows below. Webhooks heal themselves. |
| BullMQ failed set (30 days) | 30 days | `failedJobs` / `retryFailedJob` show nothing older | Failed webhook events are still in `WebhookEvent` (`processedAt` null) and the payment sweep retries them; failed emails are gone unless re-driven from the outbox |
| Repeatable job schedulers (`maintenance` queue) | Permanent | No expiry, payment sweep, reconciliation, digests, rollups until recreated | **Restart every worker**: each upserts the schedulers at startup (`src/worker/maintenance-jobs.ts`) |
| Email/SMS "sent once" markers (per job id, 30 days) | 30 days | A re-driven event may send its email or SMS again | Emails carry a Resend idempotency key, so Resend drops a repeat within its own window; SMS has no provider-side guard: a re-driven `sms.*` job can send twice |
| Phone verification codes (`PhoneOtpStore`: code, cooldown, daily caps) | 10 min (caps 24 h) | Codes in flight stop working; daily caps reset | Customers request a new code. The caps start again from zero: watch SMS spend for a day |
| Step-up verifications (`StepUpStore`) | 10 min | Staff get `STEP_UP_REQUIRED` on their next sensitive action | Staff run `stepUp` again. Sessions themselves (JWTs, refresh tokens in Postgres) survive |
| MFA challenge after password sign-in | 5 min | none (the challenge is a signed token, not Redis) | — |
| Delivery codes (`DeliveryCodes`: keyed hash per shipment and dispatch, attempt counter) | 7 days | Riders' `completeMyDelivery` gets `NOT_ISSUED` for shipments already out for delivery (`delivery_code_failures_total{result="NOT_ISSUED"}` rises) | Two options per shipment: staff with `delivery.override` complete it with `completeDelivery` + `overrideReason` (recorded as an OVERRIDE proof of delivery), or the rider marks it FAILED_DELIVERY and dispatches again, which sends a new code by SMS. Prefer the override only when the rider is with the customer |
| Velocity counters (`velocity:*`) | Their window | Limits restart from zero; a burst right after the loss is not caught | Nothing to do; soft-limit flags resume as counts rebuild |
| Throttler counters | Their window | Rate limits restart from zero | Nothing to do |
| Analytics funnel counters (`analytics:*`, per day) | 400 days | Counts not yet copied by the 15-minute rollup are gone; the funnel for the current day undercounts | Accept and note it on the day in the analytics report |
| Caches (cache-manager catalogue entries, store feature switches) | Minutes | Slower requests until refilled | Nothing to do |

## Procedure

1. **Bring Redis back** (same endpoint, or update `REDIS_HOST`/`REDIS_PORT`/`REDIS_PASSWORD`/`REDIS_DB` and roll the
   API and worker). Persistence is the provider's: with AOF or snapshots, a restart keeps most queues and this
   runbook shrinks to step 3.
2. **Note the loss window**: the time of the last good snapshot (or when Redis went away if it was flushed) as `T_lost`,
   and the time it was back as `T_back`. Record both in the incident notes.
3. **Restart every worker** so the maintenance schedulers are recreated. Check the worker log for the scheduler upsert
   and that `queue_jobs{queue="maintenance"}` shows delayed jobs again.
4. **Payments heal themselves**: the payment sweep (every 5 minutes) re-processes stored webhook events whose
   `processedAt` is null and verifies open payment attempts with Paystack, so captured payments confirm their orders
   without the lost webhook jobs. Watch the next sweep's log line (`Payment sweep done | webhooks processed: ...`).
5. **Re-drive the outbox** for events published while Redis was losing data. The relay marks an event published as
   soon as BullMQ accepts it, so events in the window were handed to the lost queues:

   ```sql
   -- Review first: what will be sent again.
   SELECT "type", count(*) FROM "OutboxEvent"
   WHERE "publishedAt" >= :'t_lost' AND "publishedAt" < :'t_back' GROUP BY 1 ORDER BY 1;

   -- Then hand them back to the relay (it publishes them with the same job ids within a second).
   UPDATE "OutboxEvent" SET "publishedAt" = NULL, "attempts" = 0, "lastError" = NULL
   WHERE "publishedAt" >= :'t_lost' AND "publishedAt" < :'t_back';
   ```

   Consumers are idempotent on the job id, but the sent markers went with Redis: customers may receive an email
   twice (outside Resend's idempotency window) or an SMS twice. Leave out event types where a repeat is worse than a
   miss (for example SMS milestones older than a few hours) by adding `AND "type" NOT IN (...)` after reviewing the
   counts.

   Direct email jobs queued by `NotificationsService` without an outbox row (sign-up, password reset) are not in the
   outbox and cannot be re-driven: affected users request them again.
6. **Imports** (`imports` queue): a bulk import whose job was lost stays in its last status. Ask the staff member who
   started it to check the import list and start it again from its file.
7. **Deliveries out for delivery**: list the shipments dispatched in the last 7 days that are still OUT_FOR_DELIVERY
   and tell the riders their codes no longer work (see the delivery codes row).
8. **Verify**: `outbox_unpublished_events` back to near zero, `queue_jobs` moving, no growth in `job_failures_total`,
   one test order paid online reaches CONFIRMED and its confirmation email arrives.

## User impact to communicate

- Customers verifying a phone for cash on delivery: request a new code.
- Staff: step up again before refunds, price and role changes.
- Riders with deliveries out: codes may fail; follow the dispatcher's instruction (override or re-dispatch).
- Some customers may get a duplicate order email or SMS.
