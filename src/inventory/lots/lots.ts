import { Prisma } from '../../generated/prisma/client';

export const MAX_LOT_NUMBER_LENGTH = 100;
export const DEFAULT_EXPIRING_WITHIN_DAYS = 30;
export const MAX_EXPIRING_WITHIN_DAYS = 365;

/** Units taken from or added to one lot. */
export interface LotQuantity {
  lotId: string;
  quantity: number;
}

/** A lot's units at one location, as FEFO sees them. */
export interface LotUnits {
  lotId: string;
  expiresAt: Date;
  /** When the lot was first received: the tie-break between lots that expire together (oldest first) */
  createdAt: Date;
  onHand: number;
}

export interface LotSpec {
  lotNumber: string;
  expiresAt?: Date | null;
  manufacturedAt?: Date | null;
}

/**
 * Which lots a removal draws from. SALE: a consumed sale must happen, so the unexpired lots first and, if they run
 * short, the expired ones (the caller warns). TRANSFER: unexpired lots only, nothing expired is shipped to another
 * location. REMOVAL (adjustment or stock-take shortage without a lot named): unexpired first, then expired.
 */
export enum DrawPolicy {
  Sale = 'SALE',
  Transfer = 'TRANSFER',
  Removal = 'REMOVAL',
}

/** A lot is unsellable from the instant it expires. */
export function isExpired(expiresAt: Date, now: Date): boolean {
  return expiresAt.getTime() <= now.getTime();
}

/** Earliest expiry first; lots that expire together go oldest first. */
export function byExpiry<T extends { expiresAt: Date; createdAt: Date }>(a: T, b: T): number {
  return a.expiresAt.getTime() - b.expiresAt.getTime() || a.createdAt.getTime() - b.createdAt.getTime();
}

/** Takes `quantity` from the lots in the order given; null when they hold fewer units. */
function drawInOrder(lots: readonly LotUnits[], quantity: number): LotQuantity[] | null {
  const drawn: LotQuantity[] = [];
  let left = quantity;
  for (const lot of lots) {
    if (left === 0) break;
    const take = Math.min(lot.onHand, left);
    if (take > 0) drawn.push({ lotId: lot.lotId, quantity: take });
    left -= take;
  }
  return left === 0 ? drawn : null;
}

/**
 * First expiry, first out: `quantity` units from the unexpired lots with the earliest expiry first (ties: the oldest
 * lot), then, unless the policy is TRANSFER, from the expired ones in the same order. Null when the lots allowed hold
 * fewer units.
 */
export function fefoDraw(
  lots: readonly LotUnits[],
  quantity: number,
  now: Date,
  policy: DrawPolicy,
): LotQuantity[] | null {
  const sorted = [...lots].sort(byExpiry);
  const fresh = sorted.filter((lot) => !isExpired(lot.expiresAt, now));
  const expired = policy === DrawPolicy.Transfer ? [] : sorted.filter((lot) => isExpired(lot.expiresAt, now));
  return drawInOrder([...fresh, ...expired], quantity);
}

/** Units of a variant's expired lots at one location. */
export interface ExpiredLotUnits {
  variantId: string;
  locationId: string;
  units: number;
}

/**
 * The variant's levels with the units of its expired lots taken off onHand, so availability (onHand - reserved)
 * counts only what can be sold.
 */
export function sellableLevels<L extends { locationId: string; onHand: number }>(
  variantId: string,
  levels: readonly L[],
  expired: readonly ExpiredLotUnits[],
): L[] {
  return levels.map((level) => {
    const units = expired.find((e) => e.variantId === variantId && e.locationId === level.locationId)?.units ?? 0;
    return { ...level, onHand: level.onHand - units };
  });
}

/** Units in lots that have expired: on hand but not sellable. */
export function expiredUnits(lots: readonly Pick<LotUnits, 'expiresAt' | 'onHand'>[], now: Date): number {
  return lots.reduce((sum, lot) => sum + (isExpired(lot.expiresAt, now) ? lot.onHand : 0), 0);
}

/** How many units of a draw came from expired lots. */
export function expiredInDraw(drawn: readonly LotQuantity[], lots: readonly LotUnits[], now: Date): number {
  const expiredIds = new Set(lots.filter((lot) => isExpired(lot.expiresAt, now)).map((lot) => lot.lotId));
  return drawn.reduce((sum, part) => sum + (expiredIds.has(part.lotId) ? part.quantity : 0), 0);
}

/**
 * Why a lot given with a receipt is refused, or null. A receipt needs the expiry, in the future; an adjustment or a
 * return names a lot, with the expiry needed only to create a new one. An existing lot keeps its expiry: a different
 * one is refused (another lot number is another lot).
 */
export function lotSpecProblem(
  spec: LotSpec,
  existing: { expiresAt: Date; manufacturedAt: Date | null } | null,
  now: Date,
  expiryRequired: boolean,
): string | null {
  const lotNumber = spec.lotNumber.trim();
  if (!lotNumber) return 'The lot number cannot be blank';
  if (lotNumber.length > MAX_LOT_NUMBER_LENGTH) {
    return `The lot number is limited to ${MAX_LOT_NUMBER_LENGTH} characters`;
  }
  if (!spec.expiresAt && (expiryRequired || !existing)) {
    return `Lot "${lotNumber}" needs its expiry date (expiresAt)`;
  }
  if (existing) {
    if (spec.expiresAt && spec.expiresAt.getTime() !== existing.expiresAt.getTime()) {
      return `Lot "${lotNumber}" expires at ${existing.expiresAt.toISOString()}, not ${spec.expiresAt.toISOString()}`;
    }
    if (spec.manufacturedAt && existing.manufacturedAt?.getTime() !== spec.manufacturedAt.getTime()) {
      return `Lot "${lotNumber}" was recorded with another manufacturing date`;
    }
  }
  const expiresAt = spec.expiresAt ?? existing?.expiresAt;
  if (expiresAt && isExpired(expiresAt, now)) {
    return `Lot "${lotNumber}" expired at ${expiresAt.toISOString()}; expired goods cannot be received`;
  }
  if (spec.manufacturedAt && spec.manufacturedAt.getTime() > now.getTime()) {
    return `Lot "${lotNumber}" cannot be manufactured in the future`;
  }
  if (spec.manufacturedAt && expiresAt && spec.manufacturedAt.getTime() >= expiresAt.getTime()) {
    return `Lot "${lotNumber}" must be manufactured before it expires`;
  }
  return null;
}

/**
 * Spreads the units that arrived on a transfer over the lots dispatched with it, earliest expiry first, so a
 * shortfall falls on the lots that expire last. Receipt counts units per variant, not per lot, so this is a fixed rule
 * rather than a guess; it keeps the stock that must sell soonest on the books. Lots that receive nothing are left out.
 */
export function assignTransferReceipt(
  dispatched: readonly (LotQuantity & { expiresAt: Date; createdAt: Date })[],
  received: number,
): LotQuantity[] {
  const total = dispatched.reduce((sum, lot) => sum + lot.quantity, 0);
  if (received > total) throw new Error(`Received ${received} units but only ${total} were dispatched in lots`);
  const units = dispatched.map((lot) => ({ ...lot, onHand: lot.quantity }));
  return drawInOrder([...units].sort(byExpiry), received) ?? [];
}

/**
 * Puts `quantity` units back into the lots an order drew them from (earliest expiry first). Null when the order
 * drew fewer units from those lots.
 */
export function allocateFromDrawn(drawn: readonly LotUnits[], quantity: number): LotQuantity[] | null {
  return drawInOrder([...drawn].sort(byExpiry), quantity);
}

/**
 * What the expiry job writes off at one location: the units of expired lots (earliest first), but never more than
 * the level has free (`available` = onHand - reserved), since units held for orders cannot be written off. What is
 * left stays until the orders release or consume it.
 */
export function expiryWriteOff(
  lots: readonly LotUnits[],
  available: number,
  now: Date,
): { writeOff: LotQuantity[]; blocked: number } {
  const expired = lots.filter((lot) => isExpired(lot.expiresAt, now) && lot.onHand > 0).sort(byExpiry);
  const due = expired.reduce((sum, lot) => sum + lot.onHand, 0);
  const allowed = Math.max(0, Math.min(due, available));
  return { writeOff: drawInOrder(expired, allowed) ?? [], blocked: due - allowed };
}

/** Why lot tracking cannot be switched on or off now, or null. Only a product with no stock anywhere may switch. */
export function lotTrackingChangeProblem(
  enable: boolean,
  stock: { onHand: number; inTransit: number; awaitingDispatch: number },
): string | null {
  if (stock.onHand === 0 && stock.inTransit === 0 && stock.awaitingDispatch === 0) return null;
  return (
    `Lot tracking can only be turned ${enable ? 'on' : 'off'} when the product holds no stock: ${stock.onHand} on ` +
    `hand, ${stock.inTransit} in transit, ${stock.awaitingDispatch} sold awaiting dispatch. ` +
    (enable
      ? 'Adjust the stock out (CORRECTION) and receive it again with lot numbers'
      : 'Sell, adjust or write off the lots first')
  );
}

/** Why the report window is refused, or null. */
export function expiringWindowProblem(withinDays: number): string | null {
  if (!Number.isInteger(withinDays) || withinDays < 1 || withinDays > MAX_EXPIRING_WITHIN_DAYS) {
    return `withinDays must be a whole number from 1 to ${MAX_EXPIRING_WITHIN_DAYS}, got ${withinDays}`;
  }
  return null;
}

/** One lot at one location, as the expiring-stock query reads it. */
export interface ExpiringLotRow {
  lotId: string;
  lotNumber: string;
  expiresAt: Date;
  manufacturedAt: Date | null;
  lotCreatedAt: Date;
  variantId: string;
  sku: string;
  productId: string;
  productName: string;
  price: Prisma.Decimal | null;
  locationId: string;
  locationName: string;
  onHand: number;
}

export interface ExpiringStockLine {
  lotId: string;
  lotNumber: string;
  expiresAt: Date;
  manufacturedAt: Date | null;
  expired: boolean;
  variantId: string;
  sku: string;
  productId: string;
  productName: string;
  locations: { locationId: string; locationName: string; onHand: number }[];
  onHand: number;
  unitPrice: Prisma.Decimal | null;
  /** onHand at the variant's current selling price (cost arrives with purchasing) */
  value: Prisma.Decimal | null;
}

/** Groups the rows per lot (locations by name), soonest expiry first, with the units valued at the current price. */
export function expiringStockLines(rows: readonly ExpiringLotRow[], now: Date): ExpiringStockLine[] {
  const lines = new Map<string, ExpiringStockLine>();
  const receivedAt = new Map<string, Date>();
  for (const row of rows) {
    if (row.onHand <= 0) continue;
    let line = lines.get(row.lotId);
    if (!line) {
      line = {
        lotId: row.lotId,
        lotNumber: row.lotNumber,
        expiresAt: row.expiresAt,
        manufacturedAt: row.manufacturedAt,
        expired: isExpired(row.expiresAt, now),
        variantId: row.variantId,
        sku: row.sku,
        productId: row.productId,
        productName: row.productName,
        locations: [],
        onHand: 0,
        unitPrice: row.price,
        value: null,
      };
      lines.set(row.lotId, line);
      receivedAt.set(row.lotId, row.lotCreatedAt);
    }
    line.locations.push({ locationId: row.locationId, locationName: row.locationName, onHand: row.onHand });
    line.onHand += row.onHand;
  }
  const sortKey = (line: ExpiringStockLine) => ({ expiresAt: line.expiresAt, createdAt: receivedAt.get(line.lotId)! });
  return [...lines.values()]
    .sort((a, b) => byExpiry(sortKey(a), sortKey(b)))
    .map((line) => ({
      ...line,
      locations: line.locations.sort((a, b) => a.locationName.localeCompare(b.locationName)),
      value: line.unitPrice ? line.unitPrice.mul(line.onHand) : null,
    }));
}
