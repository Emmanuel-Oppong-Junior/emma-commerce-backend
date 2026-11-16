# ADR-0008 — Inventory model

Status: **Proposed** · Date: 2026-11-16

## Context
- **Stock can be restored repeatedly.** It is restored without status guards: on repeated cancel, on delete, on refund after cancel, and once per extra instance of the expiry job (ORD-01/02/03, RET-01, CRON-01).
- **Absolute stock writes.** Admin product and variant updates overwrite stock with an absolute value and no log (INV-02).
- **Two disconnected counters.** Product and variant stock are independent (INV-01).
- **No reservation expiry.** Abandoned online orders that have a Payment row keep their stock forever (ORD-07).
- **Missing capabilities.** There are no locations, lots or serials.
- **Sound part to keep.** The decrement at order creation is atomic.

## Recommendation
- **`StockLevel(skuId, locationId, onHand, reserved, version)`** with `CHECK (onHand >= 0 AND reserved >= 0 AND reserved <= onHand)`. Available stock is `onHand - reserved`.
- **Reservations:** `StockReservation(id, skuId, locationId, orderId, qty, expiresAt, status: ACTIVE|CONSUMED|RELEASED)`. Placing an order reserves stock with a conditional update (`reserved = reserved + q WHERE onHand - reserved >= q`). Payment success (or COD confirmation) consumes it, which decrements `onHand` and `reserved`. Cancel or expiry releases it. Every transition is conditional on the reservation's status, so restoring stock twice is impossible by construction.
- **Ledger:** append-only `StockMovement(skuId, locationId, qty ±, reason: RECEIPT|SALE|RETURN_RESTOCK|ADJUSTMENT|TRANSFER|RESERVATION…, refType, refId, actorId, lotId?, serialId?)`. It is written in the same transaction as the `StockLevel` change. Admins never set absolute values; the API is `adjustStock(delta, reason)` or a stock-take that records the difference.
- **Locations:** `StockLocation` (warehouse, branch, pickup point) per store. Fulfilment picks a location by rule.
- **Lots and expiry (food, pharmacy):** `Lot(skuId, lotNumber, expiresAt, receivedAt)` with stock per lot. Allocation is first-expiry-first-out (FEFO). Expired lots are not sellable. Enabled per product type (`trackLots`).
- **Serials (electronics):** `SerialUnit(skuId, serial/IMEI UNIQUE, status, orderLineId?)`. A serial is assigned at pick time. Enabled with `trackSerials`.
- **Expiry job:** release reservations whose `expiresAt` has passed, using a distributed lock (ADR-0009). It is idempotent because of the conditional updates.
- **Low-stock alerts:** emitted as events from `StockMovement` when stock crosses the threshold, not by a 6-hourly full scan.
- Purchase orders and suppliers come in a later phase on the same ledger.

## Reversibility
Expensive once real stock history exists. Phase 0 fixes the restore bugs inside the current model. Phase 1/4 moves to this model.
