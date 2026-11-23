import { BadRequestException } from '@nestjs/common';
import { FulfillmentType, Prisma } from '../../generated/prisma/client';
import { RiderAssignmentReason } from '../../delivery/rider-assignment';

export const RIDER_NOT_STAFF = 'RIDER_NOT_STAFF';
export const COLLECTION_AMOUNT_MISMATCH = 'COLLECTION_AMOUNT_MISMATCH';
export const INVALID_COLLECTION_TIME = 'INVALID_COLLECTION_TIME';

/** Allowance for clocks of staff devices running a little ahead of the server. */
export const COLLECTED_AT_CLOCK_SKEW_MS = 5 * 60 * 1000;

export interface RiderCandidate {
  isActive: boolean;
  isStaff: boolean;
  /** The staff role lists delivery.ride (P5-C.1). */
  isRider?: boolean;
}

/** Whoever took the cash is an active user with a store membership. */
export function assertStaffRider(rider: RiderCandidate | null, riderId: string): asserts rider is RiderCandidate {
  if (!rider || !rider.isStaff || !rider.isActive) {
    throw new BadRequestException({
      message: `Rider "${riderId}" must be an active staff member of the store`,
      extensions: { reason: RIDER_NOT_STAFF },
    });
  }
}

/**
 * Cash for a delivery is taken by a rider (P5-C.1: a staff member whose role holds delivery.ride); at the pickup
 * counter any active staff member takes it. Collections recorded earlier by other staff stay valid.
 */
export function assertCollector(
  rider: RiderCandidate | null,
  riderId: string,
  fulfillmentType: FulfillmentType,
): asserts rider is RiderCandidate {
  assertStaffRider(rider, riderId);
  if (fulfillmentType === FulfillmentType.DELIVERY && !rider.isRider) {
    throw new BadRequestException({
      message: `Rider "${riderId}" is not a rider (a staff member whose role holds delivery.ride)`,
      extensions: { reason: RiderAssignmentReason.NOT_A_RIDER },
    });
  }
}

/**
 * The cash taken must be the amount due: the payment is captured for the order total, so a short collection is not
 * recorded here. Cash the rider fails to hand in shows up as a short remittance instead.
 */
export function assertCollectedAmount(amountDue: Prisma.Decimal, amount: Prisma.Decimal): void {
  if (!amount.equals(amountDue)) {
    throw new BadRequestException({
      message: `The cash collected (${amount.toFixed(2)}) must equal the amount due (${amountDue.toFixed(2)})`,
      extensions: { reason: COLLECTION_AMOUNT_MISMATCH },
    });
  }
}

/** A collection time may be backdated (recorded later at the shop) but never before dispatch nor in the future. */
export function assertCollectedAt(collectedAt: Date, now: Date, dispatchedAt: Date | null): void {
  if (collectedAt.getTime() > now.getTime() + COLLECTED_AT_CLOCK_SKEW_MS) {
    throw new BadRequestException({
      message: `collectedAt ${collectedAt.toISOString()} is in the future`,
      extensions: { reason: INVALID_COLLECTION_TIME },
    });
  }
  if (dispatchedAt && collectedAt.getTime() < dispatchedAt.getTime()) {
    throw new BadRequestException({
      message: `collectedAt ${collectedAt.toISOString()} is before the order was dispatched (${dispatchedAt.toISOString()})`,
      extensions: { reason: INVALID_COLLECTION_TIME },
    });
  }
}
