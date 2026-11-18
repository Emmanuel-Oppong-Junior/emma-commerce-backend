# ADR-0009 — Background jobs, domain events and outbox

Status: **Accepted** (Emmanuel, 2026-11-18) · Date: 2026-11-16

## Context
- **Crons on every instance.** Two in-process `@Cron` jobs run on every instance with no lock (CRON-01).
- **Fire-and-forget email.** Emails are sent on the request path. Failures are invisible (NOT-01), and the `.then` has no `.catch`, so an error can surface as an unhandled rejection (NOT-02).
- **No retries or queue** for webhooks, emails or reconciliation.
- **Side effects outside transactions.** Audit writes and notifications happen outside the business transaction (AUD-04).

## Options
- **BullMQ on Redis.** Mature in Node, NestJS has `@nestjs/bullmq`, and it supports repeatable jobs, retries with backoff and rate limits. Redis is already needed for cache and throttling (ADR-0011).
- **pg-boss on Postgres.** No extra infrastructure, and job enqueueing is transactional with the business write. Lower throughput, but fine at SME scale.
- **A cloud queue (SQS or Pub/Sub).** Ties the system to one hosting provider.

## Recommendation
**BullMQ + transactional outbox.**
- Business code writes `OutboxEvent(id, type, aggregateId, payload, createdAt, publishedAt)` **in the same Prisma transaction** as the state change. Examples: `OrderPlaced`, `PaymentSucceeded`, `OrderCancelled`, `StockLow`, `RefundIssued`.
- A relay worker polls unpublished events (`FOR UPDATE SKIP LOCKED`), pushes them to BullMQ and marks them published. Consumers are idempotent and keyed by event ID.
- Notifications, search indexing, analytics roll-ups, the audit log projection and webhook processing are all consumers.
- Repeatable jobs (reservation expiry, payment reconciliation, FX refresh, low-stock digest) are BullMQ repeatables, so each runs **once per cluster**. From Phase 1, the **worker runs as a separate process** from the API (same image, `ROLE=worker`). This makes Redis mandatory in production. Event names are versioned (`order.placed.v1`) because they become a contract once there are consumers.
- If Emmanuel prefers fewer moving parts at launch, pg-boss with the same outbox and consumer interfaces is an acceptable swap (see SUMMARY decision 7).

## Reversibility
Moderate. The outbox pattern is broker-agnostic.
