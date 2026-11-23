import { PurchaseOrderStatus } from '../../generated/prisma/client';

const S = PurchaseOrderStatus;

/**
 * The purchase-order machine (P4-E.1), no approval step. A DRAFT is sent (or cancelled); a sent order is received in
 * one or more deliveries, or cancelled while nothing has arrived; a partly received order takes further deliveries
 * until everything arrived (RECEIVED) or staff close it short (CLOSED). RECEIVED, CLOSED and CANCELLED are final.
 */
const TRANSITIONS: Record<PurchaseOrderStatus, readonly PurchaseOrderStatus[]> = {
  DRAFT: [S.SENT, S.CANCELLED],
  SENT: [S.PARTIALLY_RECEIVED, S.RECEIVED, S.CANCELLED],
  PARTIALLY_RECEIVED: [S.PARTIALLY_RECEIVED, S.RECEIVED, S.CLOSED],
  RECEIVED: [],
  CLOSED: [],
  CANCELLED: [],
};

export function canPurchaseOrderTransition(from: PurchaseOrderStatus, to: PurchaseOrderStatus): boolean {
  return TRANSITIONS[from].includes(to);
}

/** Statuses a delivery can be received in. */
export function isReceivable(status: PurchaseOrderStatus): boolean {
  return status === S.SENT || status === S.PARTIALLY_RECEIVED;
}

/** The status after a receipt: RECEIVED once every line has all its units, else PARTIALLY_RECEIVED. */
export function statusAfterReceipt(
  lines: { quantityOrdered: number; quantityReceived: number }[],
): PurchaseOrderStatus {
  return lines.every((line) => line.quantityReceived >= line.quantityOrdered) ? S.RECEIVED : S.PARTIALLY_RECEIVED;
}

/** "PO-00042": the human-readable reference of purchase order number 42. */
export function purchaseOrderReference(number: number): string {
  return `PO-${String(number).padStart(5, '0')}`;
}
