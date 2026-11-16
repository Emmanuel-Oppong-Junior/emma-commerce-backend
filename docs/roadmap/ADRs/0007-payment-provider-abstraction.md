# ADR-0007 — Payment provider abstraction and payment ledger

Status: **Proposed** · Date: 2026-11-16

## Context
- **One Payment per order.** `Payment.orderId @unique` allows only one payment per order. A retry hard-deletes the pending row, so a late success on the old reference is lost (PAY-03/DB-01). A retry after a failure collides with the unique key (PAY-04).
- **Verification trusts too much.** Verify does not compare amount or currency (PAY-05). It revives any order to PROCESSING (PAY-01).
- **Webhooks always fail.** Every webhook currently returns 500 (PLAT-01), and processing failures are acknowledged with 200 anyway (PAY-06). There is no reconciliation.
- **Weak signature check.** The HMAC is computed over re-serialised JSON, not the raw request body.
- **Refunds can be issued twice.** Refunds call Paystack before a non-conditional status write (RET-02).
- **Unmaintained SDK.** `paystack-api` is unmaintained.

Research (`_work/ghana-research.md`):
- **Paystack first:** 1.95% on cards and MoMo, T+1 settlement in GHS, HMAC-SHA512 webhook, refund API. Whether MoMo payments can be refunded is still to be confirmed.
- **Flutterwave second:** its documented idempotency key is a plus, but its webhook only carries a static hash, so every webhook must be re-verified through the API.
- **Bank of Ghana notice (Nov 2026):** payment providers may not hold merchant funds.

## Recommendation
1. **Port + adapters:** `PaymentProvider` interface (`initialize`, `verify`, `refund`, `parseWebhook(rawBody, headers) → VerifiedEvent`, `capabilities`). `PaystackAdapter` is the first, using a thin HTTP client with timeouts instead of `paystack-api`. `CashOnDeliveryAdapter` handles pay-on-delivery. Adapters are picked per store and per payment method (ADR-0001).
2. **Ledger, not a single row:**
   - `PaymentIntent(orderId, amount, currency, status)` holds what the order needs paid.
   - `PaymentAttempt(intentId, provider, reference UNIQUE, amount, currency, status, rawStatus, createdAt)` records each try. Attempts are never deleted.
   - `Refund(attemptId, amount, status, providerRef, idempotencyKey UNIQUE)` records refunds.
   - Total refunds are capped at the captured amount.
3. **Webhook inbox:** a raw-body HMAC with `timingSafeEqual`, then an `INSERT` into `WebhookEvent(provider, eventId/reference+event UNIQUE, payload, receivedAt, processedAt)`. Return 200 once the event is stored, and process it asynchronously on the queue (ADR-0009). Duplicates are no-ops.
4. **Verification rule:** an attempt is marked succeeded only if the provider's `verify` reports success **and** the amount and currency equal the attempt's **and** the reference matches.
5. **Order transitions** go only through the state machine (ADR-0014). A success on a CANCELLED or EXPIRED order goes to `PAID_REQUIRES_ACTION`. That state triggers an automatic refund or a staff decision; the order is never silently revived.
6. **Reconciliation job:** every 15 minutes, verify attempts left `PENDING` for more than N minutes. Each night, reconcile against the provider's transaction list.
7. **Idempotency keys:** `initiatePayment`, `createOrder` and `refund` accept an `Idempotency-Key`. Store it with the response for 24 h.
8. **Pay on delivery:** an `OfflineCod` adapter is the second implementation of the port. It needs `CashCollection(orderId, riderId, amount, collectedAt)` and `Remittance(riderId, amount, settledAt)` records, and proof of delivery. Risk gates are switched on per store: SMS-verified phone, a cap on open COD orders per phone and address, a basket cap, an area allow-list, a blacklist after refusals, and an optional MoMo deposit above a threshold. See SUMMARY decision 3.
9. **Phasing:** the ledger tables (`PaymentIntent`, `PaymentAttempt`, `PaymentEvent`/`WebhookEvent`, `Refund`, `CashCollection`) land in **Phase 0**, because they fix DB-01/02 and PAY-03/04, and missing payment history cannot be rebuilt later.

## Reversibility
Moderate. The ledger tables are the important part to get right in Phase 0, because they hold real money history.
