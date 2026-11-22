import { BadRequestException } from '@nestjs/common';
import { Prisma } from '../../generated/prisma/client';

export const RIDER_NOT_STAFF = 'RIDER_NOT_STAFF';
export const COLLECTION_AMOUNT_MISMATCH = 'COLLECTION_AMOUNT_MISMATCH';
export const INVALID_COLLECTION_TIME = 'INVALID_COLLECTION_TIME';

/** Allowance for clocks of staff devices running a little ahead of the server. */
export const COLLECTED_AT_CLOCK_SKEW_MS = 5 * 60 * 1000;

export interface RiderCandidate {
  isActive: boolean;
  isStaff: boolean;
}

/** Riders are staff accounts for now (P5-C adds a Rider role): an active user with a store membership. */
export function assertStaffRider(rider: RiderCandidate | null, riderId: string): asserts rider is RiderCandidate {
  if (!rider || !rider.isStaff || !rider.isActive) {
    throw new BadRequestException({
      message: `Rider "${riderId}" must be an active staff member of the store`,
      extensions: { reason: RIDER_NOT_STAFF },
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
