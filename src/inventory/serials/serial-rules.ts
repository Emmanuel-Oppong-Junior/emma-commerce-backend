import { BadRequestException } from '@nestjs/common';
import { SerialUnitStatus } from '../../generated/prisma/client';

const S = SerialUnitStatus;

/**
 * The life of a serialised unit (P4-D.1). IN_STOCK units are picked for an order line (ASSIGNED, still on the shelf)
 * and SOLD when the shipment is dispatched; unassigning or cancelling before dispatch puts them back, and a sold unit
 * comes back IN_STOCK when its return is restocked or its order is cancelled after a failed delivery. Transfers carry
 * units IN_TRANSIT; units missing on arrival, and units adjusted away, are WRITTEN_OFF until a FOUND (or CORRECTION)
 * adjustment brings them back.
 */
const TRANSITIONS: Record<SerialUnitStatus, readonly SerialUnitStatus[]> = {
  IN_STOCK: [S.ASSIGNED, S.IN_TRANSIT, S.WRITTEN_OFF],
  ASSIGNED: [S.IN_STOCK, S.SOLD],
  SOLD: [S.IN_STOCK],
  IN_TRANSIT: [S.IN_STOCK, S.WRITTEN_OFF],
  WRITTEN_OFF: [S.IN_STOCK],
};

export function canSerialTransition(from: SerialUnitStatus, to: SerialUnitStatus): boolean {
  return TRANSITIONS[from].includes(to);
}

/** The statuses a unit can reach `to` from, for conditional updates. */
export function serialStatusesFrom(to: SerialUnitStatus): SerialUnitStatus[] {
  return (Object.keys(TRANSITIONS) as SerialUnitStatus[]).filter((from) => TRANSITIONS[from].includes(to));
}

/** Units physically on a location's shelf. */
export const ON_SHELF_STATUSES: SerialUnitStatus[] = [S.IN_STOCK, S.ASSIGNED];

/**
 * Why `serials` cannot record `quantity` units of a tracked variant, or null: the stock change needs exactly one
 * serial per unit.
 */
export function serialCountProblem(quantity: number, serials: readonly string[] | undefined): string | null {
  if (!serials || serials.length === 0) {
    return `This product tracks serial numbers: name the ${quantity} unit${quantity === 1 ? '' : 's'} by serial`;
  }
  if (serials.length !== quantity) {
    return `Name exactly ${quantity} serial${quantity === 1 ? '' : 's'}, one per unit; got ${serials.length}`;
  }
  return null;
}

export interface SerialisedLine {
  orderItemId: string;
  quantity: number;
  assigned: number;
}

/** The serialised lines of an order that do not have exactly their quantity of units assigned; dispatch waits. */
export function linesNotReadyToDispatch<T extends SerialisedLine>(lines: readonly T[]): T[] {
  return lines.filter((line) => line.assigned !== line.quantity);
}

/** Why `adding` more units cannot be assigned to a line, or null. */
export function assignmentProblem(line: SerialisedLine, adding: number): string | null {
  if (line.assigned + adding > line.quantity) {
    return (
      `Order line "${line.orderItemId}" is for ${line.quantity} unit${line.quantity === 1 ? '' : 's'} and has ` +
      `${line.assigned} assigned: ${adding} more would be too many`
    );
  }
  return null;
}

export interface WarrantyWindow {
  startsAt: Date;
  endsAt: Date;
}

/**
 * The warranty of a unit delivered at `deliveredAt`: `months` calendar months later (UTC), on the last day of the
 * month when it is shorter (31 January + 1 month = 28/29 February). Null when the product has no warranty.
 */
export function warrantyWindow(deliveredAt: Date, months: number | null): WarrantyWindow | null {
  if (months === null) return null;
  const endsAt = new Date(deliveredAt);
  const day = endsAt.getUTCDate();
  endsAt.setUTCDate(1);
  endsAt.setUTCMonth(endsAt.getUTCMonth() + months);
  const lastDay = new Date(Date.UTC(endsAt.getUTCFullYear(), endsAt.getUTCMonth() + 1, 0)).getUTCDate();
  endsAt.setUTCDate(Math.min(day, lastDay));
  return { startsAt: new Date(deliveredAt), endsAt };
}

export interface TrackingFacts {
  /** On-hand units of the product's variants at every location */
  onHand: number;
  /** Units of its variants on transfers dispatched and not yet received */
  inTransit: number;
  /** Its variants' lines on orders still open (placed, confirmed, in fulfilment or awaiting payment review) */
  openOrderLines: number;
  /** Its serial units on a shelf or in transit */
  trackedUnits: number;
}

/**
 * Why a product's trackSerials flag cannot change now, or null. It turns on only while none of its units exist
 * untracked (nothing on hand, in transit or on an open order), since those units have no serial to dispatch or count
 * by; it turns off only while no serial unit is on a shelf or in transit, so no unit is left with a status nobody
 * maintains.
 */
export function trackSerialsChangeProblem(turnOn: boolean, facts: TrackingFacts): string | null {
  if (turnOn) {
    const blockers = [
      facts.onHand > 0 && `${facts.onHand} on hand`,
      facts.inTransit > 0 && `${facts.inTransit} in transit`,
      facts.openOrderLines > 0 && `${facts.openOrderLines} open order line${facts.openOrderLines === 1 ? '' : 's'}`,
    ].filter(Boolean);
    if (blockers.length > 0) {
      return (
        `Serial tracking can only be turned on while the product has no untracked stock (${blockers.join(', ')}): ` +
        'adjust it to zero and finish its open orders and transfers first'
      );
    }
    return null;
  }
  if (facts.trackedUnits > 0) {
    return (
      `Serial tracking cannot be turned off while ${facts.trackedUnits} serial unit` +
      `${facts.trackedUnits === 1 ? ' is' : 's are'} in stock, assigned or in transit`
    );
  }
  return null;
}

/**
 * A product that tracks serials takes no opening stock on its variants: its units are received with their serials
 * (restockVariant). Throws BadRequestException otherwise.
 */
export function assertNoSerialisedOpeningStock(trackSerials: boolean, variants: readonly { quantity: number }[]): void {
  if (trackSerials && variants.some((variant) => variant.quantity > 0)) {
    throw new BadRequestException(
      'This product tracks serial numbers: create its variants without opening stock and receive the units with ' +
        'their serials (restockVariant)',
    );
  }
}
