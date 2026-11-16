# ADR-0014 — Order, payment and fulfilment state machines

Status: **Proposed** · Date: 2026-11-16

## Context
- **Admin can set any status.** `updateOrderStatus` moves any status to any other, e.g. CANCELLED → SHIPPED (ORD-04).
- **Payment success forces PROCESSING.** It is applied unconditionally, even to DELIVERED or CANCELLED orders (PAY-01).
- **Cancel is unguarded.** It accepts orders that are already cancelled (ORD-01).
- **COD jumps to DELIVERED.** Recording COD cash sets DELIVERED regardless of the current state.
- **Status writes are not part of the transaction.** They use the root Prisma client, not the transaction client (ORD-02).
- **Statuses are missing.** There is no `PAID`, `READY_FOR_PICKUP`, `OUT_FOR_DELIVERY`, `PARTIALLY_FULFILLED`, `REFUNDED`, `EXPIRED` or `PAYMENT_REVIEW`.

## Recommendation
- Model three cooperating machines as **pure transition tables** (no I/O), each unit-tested exhaustively:
  - **Order:** `DRAFT → PLACED (stock reserved) → CONFIRMED (paid / COD accepted) → IN_FULFILMENT → COMPLETED`. Side states: `CANCELLED`, `EXPIRED`, `PAYMENT_REVIEW` (paid after cancel/expiry).
  - **Payment intent:** `PENDING → AUTHORIZED? → CAPTURED → PARTIALLY_REFUNDED → REFUNDED`. Failure states: `FAILED` and `CANCELLED`.
  - **Fulfilment per shipment:** `PENDING → PICKING → PACKED → READY_FOR_PICKUP | OUT_FOR_DELIVERY → DELIVERED | FAILED_DELIVERY → RETURNED`. One order can have several shipments (partial fulfilment).
- **Every transition is a conditional write in the same transaction as its side effects:** `UPDATE order SET status = :to, version = version + 1 WHERE id = :id AND status = ANY(:allowedFrom)`. If zero rows are affected, raise a `CONFLICT` error. Reserve, release and consume stock, coupon reservations and outbox events in the same transaction.
- **Each transition has a permission** (ADR-0013) and an audit entry with actor and reason.
- **The status history** (`OrderStatusEvent`) is the customer-visible tracking timeline.

## Reversibility
Moderate. Status enums need a data migration, which is a mechanical mapping.
