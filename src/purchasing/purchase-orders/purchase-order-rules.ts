import { Decimal } from '@prisma/client/runtime/client';
import { PurchaseOrderStatus } from '../../generated/prisma/client';
import { isReceivable } from './purchase-order-status';

export const MAX_PURCHASE_ORDER_LINES = 100;

export interface PurchaseOrderLineDraft {
  variantId: string;
  quantity: number;
  /** Tax-exclusive cost of one unit in the store currency, at most 4 decimal places */
  unitCost: Decimal;
}

/** Why the lines of a purchase order are invalid, or null: 1-100 lines, one per variant, quantity >= 1, cost >= 0. */
export function purchaseOrderLinesProblem(lines: PurchaseOrderLineDraft[]): string | null {
  if (lines.length === 0) return 'A purchase order needs at least one line';
  if (lines.length > MAX_PURCHASE_ORDER_LINES)
    return `A purchase order holds at most ${MAX_PURCHASE_ORDER_LINES} lines`;
  if (new Set(lines.map((line) => line.variantId)).size !== lines.length) {
    return 'A variant can appear only once in a purchase order';
  }
  const badQuantity = lines.find((line) => !Number.isInteger(line.quantity) || line.quantity < 1);
  if (badQuantity) return `Quantity of variant "${badQuantity.variantId}" must be a whole number of at least 1`;
  const badCost = lines.find((line) => line.unitCost.isNegative() || line.unitCost.decimalPlaces() > 4);
  if (badCost) return `Unit cost of variant "${badCost.variantId}" must be at least 0 with at most 4 decimal places`;
  return null;
}

export interface OrderedLine {
  id: string;
  variantId: string;
  quantityOrdered: number;
  quantityReceived: number;
  unitCost: Decimal;
}

export interface ArrivingLine {
  variantId: string;
  quantity: number;
}

export interface ReceiptLinePlan {
  line: OrderedLine;
  quantity: number;
}

/** A receipt the order's status refuses (a CONFLICT), or one that is itself wrong (a BAD_REQUEST). */
export type ReceiptPlan =
  { refusal: 'STATUS' | 'INVALID'; problem: string } | { refusal: null; lines: ReceiptLinePlan[] };

/**
 * What a delivery against a purchase order receives: each line named once, at least one unit, never more than is
 * still outstanding on it (no over-receipt tolerance). The order must be SENT or PARTIALLY_RECEIVED.
 */
export function receiptPlan(
  status: PurchaseOrderStatus,
  ordered: OrderedLine[],
  arriving: ArrivingLine[],
): ReceiptPlan {
  if (!isReceivable(status)) {
    return { refusal: 'STATUS', problem: `A ${status} purchase order cannot receive goods` };
  }
  if (arriving.length === 0) return { refusal: 'INVALID', problem: 'A receipt needs at least one line' };
  if (new Set(arriving.map((line) => line.variantId)).size !== arriving.length) {
    return { refusal: 'INVALID', problem: 'A variant can appear only once in a receipt' };
  }
  const byVariant = new Map(ordered.map((line) => [line.variantId, line]));
  const lines: ReceiptLinePlan[] = [];
  for (const arrival of arriving) {
    const line = byVariant.get(arrival.variantId);
    if (!line) return { refusal: 'INVALID', problem: `Variant "${arrival.variantId}" is not on this purchase order` };
    const outstanding = line.quantityOrdered - line.quantityReceived;
    if (!Number.isInteger(arrival.quantity) || arrival.quantity < 1) {
      return { refusal: 'INVALID', problem: `Quantity of variant "${arrival.variantId}" must be at least 1` };
    }
    if (arrival.quantity > outstanding) {
      return {
        refusal: 'INVALID',
        problem: `Cannot receive ${arrival.quantity} of variant "${arrival.variantId}": only ${outstanding} outstanding`,
      };
    }
    lines.push({ line, quantity: arrival.quantity });
  }
  return { refusal: null, lines };
}
