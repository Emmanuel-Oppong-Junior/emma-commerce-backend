import { Prisma, ReturnReason, ReturnResolution } from '../generated/prisma/client';
import { RefundRequestParts } from './refund-plan';

export const RETURN_PHOTO_LIMIT = 3;
export const MAX_RETURN_LINES = 50;
const DAY_MS = 24 * 60 * 60 * 1000;

export const NOT_RETURNABLE = 'NOT_RETURNABLE';
export const NOT_DELIVERED = 'NOT_DELIVERED';
export const OUTSIDE_RETURN_WINDOW = 'OUTSIDE_RETURN_WINDOW';
export const RETURN_QUANTITY_EXCEEDED = 'RETURN_QUANTITY_EXCEEDED';
export const EXCHANGE_NOT_ALLOWED = 'EXCHANGE_NOT_ALLOWED';
export const EXCHANGE_OUT_OF_STOCK = 'EXCHANGE_OUT_OF_STOCK';

/** Cloudinary folder of a customer's return photos for one order. */
export function returnPhotoFolder(orderId: string): string {
  return `returns/${orderId}`;
}

export interface ReturnPolicy {
  storeWindowDays: number;
  productType: { name: string; returnable: boolean; returnWindowDays: number | null };
}

/** Days after delivery the line may be returned in: its product type's own window, else the store's. */
export function windowDaysFor(policy: ReturnPolicy): number {
  return policy.productType.returnWindowDays ?? policy.storeWindowDays;
}

/** What an order line has delivered, refunded and under return. */
export interface LineUnits {
  /** Units of the line in each DELIVERED shipment and when it was delivered (null: not recorded). */
  deliveries: { deliveredAt: Date | null; quantity: number }[];
  /** Units refunded outside any return (FAILED refunds excluded). */
  refundedOutsideReturns: number;
  /** Units claimed by other live returns (not rejected or cancelled; the units received once received). */
  claimedByReturns: number;
}

export function deliveredUnits(units: LineUnits): number {
  return units.deliveries.reduce((sum, delivery) => sum + delivery.quantity, 0);
}

/** Delivered units not yet refunded or under another return. */
export function returnableUnits(units: LineUnits): number {
  return Math.max(0, deliveredUnits(units) - units.refundedOutsideReturns - units.claimedByReturns);
}

/**
 * Returnable units still inside the window: those of shipments delivered at most `windowDays` days ago (a shipment
 * whose delivery time was not recorded is outside). Units already refunded or returned are counted against the
 * shipments outside the window first, the reading most favourable to the customer.
 */
export function returnableInWindow(units: LineUnits, windowDays: number, now: Date): number {
  const inWindow = units.deliveries
    .filter((delivery) => delivery.deliveredAt && delivery.deliveredAt.getTime() + windowDays * DAY_MS >= now.getTime())
    .reduce((sum, delivery) => sum + delivery.quantity, 0);
  return Math.min(inWindow, returnableUnits(units));
}

export interface LineRefusal {
  kind: 'BAD_REQUEST' | 'CONFLICT';
  reason: string;
  message: string;
}

/**
 * Why `quantity` units of the line cannot be returned now, or null. A staff override (`policyOverride`) skips the
 * product type's returnable flag and the window, never the units delivered.
 */
export function returnLineRefusal(
  line: { orderItemId: string; productName: string; quantity: number },
  units: LineUnits,
  policy: ReturnPolicy,
  now: Date,
  policyOverride = false,
): LineRefusal | null {
  const what = `"${line.productName}" (order line "${line.orderItemId}")`;
  if (!policyOverride && !policy.productType.returnable) {
    return {
      kind: 'BAD_REQUEST',
      reason: NOT_RETURNABLE,
      message: `${what} is a ${policy.productType.name} product, which cannot be returned`,
    };
  }
  if (deliveredUnits(units) === 0) {
    return { kind: 'BAD_REQUEST', reason: NOT_DELIVERED, message: `${what} has not been delivered yet` };
  }
  const left = returnableUnits(units);
  if (line.quantity > left) {
    return {
      kind: 'CONFLICT',
      reason: RETURN_QUANTITY_EXCEEDED,
      message: `${what} has ${left} delivered units left to return; ${line.quantity} requested`,
    };
  }
  if (policyOverride) return null;
  const days = windowDaysFor(policy);
  const inWindow = returnableInWindow(units, days, now);
  if (line.quantity > inWindow) {
    return {
      kind: 'BAD_REQUEST',
      reason: OUTSIDE_RETURN_WINDOW,
      message: `${what}: ${inWindow} units are within the ${days}-day return window after delivery; ${line.quantity} requested`,
    };
  }
  return null;
}

export interface RequestedReturnLine {
  orderItemId: string;
  quantity: number;
  reason: ReturnReason;
  note?: string | null;
  photoPublicIds?: string[] | null;
  exchangeVariantId?: string | null;
}

export interface CheckedReturnLine {
  orderItemId: string;
  quantity: number;
  reason: ReturnReason;
  note: string | null;
  photoPublicIds: string[];
  exchangeVariantId: string | null;
}

/**
 * Checks the shape of a request and returns its lines normalised (notes trimmed, null when blank), or the problem.
 * Every line of an EXCHANGE names the variant wanted; a REFUND names none. Photos must come from the order's upload
 * folder.
 */
export function checkReturnLines(
  orderId: string,
  resolution: ReturnResolution,
  lines: RequestedReturnLine[],
): CheckedReturnLine[] | string {
  if (lines.length === 0) return 'Choose at least one order line to return';
  if (lines.length > MAX_RETURN_LINES) return `A return has at most ${MAX_RETURN_LINES} lines`;
  const seen = new Set<string>();
  const checked: CheckedReturnLine[] = [];
  for (const line of lines) {
    if (seen.has(line.orderItemId)) return `Order line "${line.orderItemId}" is listed more than once`;
    seen.add(line.orderItemId);
    if (!Number.isInteger(line.quantity) || line.quantity < 1) {
      return `Quantity for order line "${line.orderItemId}" must be a whole number of at least 1`;
    }
    const note = line.note?.trim() || null;
    if (line.reason === ReturnReason.OTHER && !note) {
      return `A note is required when the reason for order line "${line.orderItemId}" is OTHER`;
    }
    const photos = line.photoPublicIds ?? [];
    if (photos.length > RETURN_PHOTO_LIMIT) {
      return `At most ${RETURN_PHOTO_LIMIT} photos per line; order line "${line.orderItemId}" has ${photos.length}`;
    }
    if (new Set(photos).size !== photos.length) return `Order line "${line.orderItemId}" lists a photo twice`;
    const foreign = photos.find((publicId) => !publicId.startsWith(`${returnPhotoFolder(orderId)}/`));
    if (foreign !== undefined) return `Photo "${foreign}" was not uploaded for order "${orderId}"`;
    const exchangeVariantId = line.exchangeVariantId ?? null;
    if (resolution === ReturnResolution.EXCHANGE && !exchangeVariantId) {
      return `An exchange names the variant wanted for every line; order line "${line.orderItemId}" has none`;
    }
    if (resolution === ReturnResolution.REFUND && exchangeVariantId) {
      return `A refund return names no exchange variant; ask for resolution EXCHANGE instead`;
    }
    checked.push({
      orderItemId: line.orderItemId,
      quantity: line.quantity,
      reason: line.reason,
      note,
      photoPublicIds: photos,
      exchangeVariantId,
    });
  }
  return checked;
}

/** A variant offered in exchange for a returned line: what makes it eligible. */
export interface ExchangeCandidate {
  id: string;
  productId: string;
  /** Current selling price, tax included; null when not for sale. */
  price: Prisma.Decimal | null;
  /** Why it cannot be sold (inactive, unpublished, ...), or null. */
  notSellable: string | null;
}

/**
 * Why the variant cannot replace the returned line, or null: it must be another (or the same) variant of the same
 * product, on sale, at the unit price the line was ordered at (its catalogue price then, before discounts), so the
 * exchange moves no money.
 */
export function exchangeRefusal(
  line: { orderItemId: string; productId: string; unitListPrice: Prisma.Decimal },
  replacement: ExchangeCandidate,
): string | null {
  if (replacement.productId !== line.productId) {
    return `Variant "${replacement.id}" is not a variant of the product of order line "${line.orderItemId}"`;
  }
  if (replacement.notSellable) return `Variant "${replacement.id}" cannot be sold: ${replacement.notSellable}`;
  if (!replacement.price || !replacement.price.eq(line.unitListPrice)) {
    return (
      `Variant "${replacement.id}" costs ${replacement.price?.toFixed(2) ?? 'nothing'}, order line ` +
      `"${line.orderItemId}" was ${line.unitListPrice.toFixed(2)} a unit; only an exchange at the same price is possible`
    );
  }
  return null;
}

/** Checks a receipt: every line listed once with 0 to its quantity received, and something received. */
export function receiptProblem(
  lines: { id: string; quantity: number }[],
  received: { returnLineId: string; receivedQuantity: number }[],
): string | null {
  const byId = new Map(lines.map((line) => [line.id, line]));
  const seen = new Set<string>();
  for (const entry of received) {
    const line = byId.get(entry.returnLineId);
    if (!line) return `Return line "${entry.returnLineId}" is not part of this return`;
    if (seen.has(entry.returnLineId)) return `Return line "${entry.returnLineId}" is listed more than once`;
    seen.add(entry.returnLineId);
    if (!Number.isInteger(entry.receivedQuantity) || entry.receivedQuantity < 0) {
      return `Received quantity for return line "${entry.returnLineId}" must be a whole number of at least 0`;
    }
    if (entry.receivedQuantity > line.quantity) {
      return `Return line "${entry.returnLineId}" returns ${line.quantity} units; ${entry.receivedQuantity} received`;
    }
  }
  const missing = lines.find((line) => !seen.has(line.id));
  if (missing) return `Say how many units of return line "${missing.id}" arrived (0 if none)`;
  if (received.every((entry) => entry.receivedQuantity === 0)) {
    return 'Nothing arrived: reject the return instead of receiving it';
  }
  return null;
}

/** Checks an inspection: every line with units received listed once, restocked + written off = received. */
export function inspectionProblem(
  lines: { id: string; receivedQuantity: number }[],
  inspected: { returnLineId: string; restockQuantity: number; writeOffQuantity: number }[],
): string | null {
  const byId = new Map(lines.map((line) => [line.id, line]));
  const seen = new Set<string>();
  for (const entry of inspected) {
    const line = byId.get(entry.returnLineId);
    if (!line) return `Return line "${entry.returnLineId}" is not part of this return`;
    if (seen.has(entry.returnLineId)) return `Return line "${entry.returnLineId}" is listed more than once`;
    seen.add(entry.returnLineId);
    const counts = [entry.restockQuantity, entry.writeOffQuantity];
    if (counts.some((count) => !Number.isInteger(count) || count < 0)) {
      return `Restock and write-off quantities for return line "${entry.returnLineId}" must be whole numbers of at least 0`;
    }
    if (entry.restockQuantity + entry.writeOffQuantity !== line.receivedQuantity) {
      return (
        `Return line "${entry.returnLineId}" received ${line.receivedQuantity} units; restock and write-off must add ` +
        `up to that, got ${entry.restockQuantity} + ${entry.writeOffQuantity}`
      );
    }
  }
  const missing = lines.find((line) => line.receivedQuantity > 0 && !seen.has(line.id));
  if (missing) return `Say what happens to the units received on return line "${missing.id}"`;
  return null;
}

/** The refund of a return: the units received on each line (and the delivery fee when staff choose). */
export function returnRefundParts(
  lines: { orderItemId: string; receivedQuantity: number | null }[],
  shipping: boolean,
): RefundRequestParts {
  return {
    lines: lines
      .filter((line) => (line.receivedQuantity ?? 0) > 0)
      .map((line) => ({ orderItemId: line.orderItemId, quantity: line.receivedQuantity! })),
    shipping,
    amount: null,
  };
}

/** The replacement order of an exchange: the variant wanted for each unit received. */
export function replacementLines(
  lines: { orderItemId: string; exchangeVariantId: string | null; receivedQuantity: number | null }[],
): { orderItemId: string; variantId: string; quantity: number }[] {
  return lines
    .filter((line) => (line.receivedQuantity ?? 0) > 0)
    .map((line) => {
      if (!line.exchangeVariantId) throw new Error(`Return line for "${line.orderItemId}" names no exchange variant`);
      return { orderItemId: line.orderItemId, variantId: line.exchangeVariantId, quantity: line.receivedQuantity! };
    });
}
