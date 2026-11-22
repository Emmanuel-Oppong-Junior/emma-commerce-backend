import { BadRequestException, ConflictException, NotFoundException } from '@nestjs/common';
import { Prisma } from '../../generated/prisma/client';
import { COLLECTED_AT_CLOCK_SKEW_MS, RIDER_NOT_STAFF } from './cash-collection';

export const DISCREPANCY_NOTE_REQUIRED = 'DISCREPANCY_NOTE_REQUIRED';
export const COLLECTION_ALREADY_REMITTED = 'COLLECTION_ALREADY_REMITTED';

export enum DiscrepancyKind {
  SHORT = 'SHORT',
  OVER = 'OVER',
}

export interface RemittanceTotals {
  /** What the covered collections add up to. */
  expectedAmount: Prisma.Decimal;
  /** amount - expectedAmount: negative when the rider handed in less, positive when more. */
  discrepancy: Prisma.Decimal;
  kind: DiscrepancyKind | null;
}

export function discrepancyKind(discrepancy: Prisma.Decimal): DiscrepancyKind | null {
  if (discrepancy.isZero()) return null;
  return discrepancy.isNegative() ? DiscrepancyKind.SHORT : DiscrepancyKind.OVER;
}

export function remittanceTotals(collections: { amount: Prisma.Decimal }[], amount: Prisma.Decimal): RemittanceTotals {
  const expectedAmount = collections.reduce((sum, { amount: collected }) => sum.plus(collected), new Prisma.Decimal(0));
  const discrepancy = amount.minus(expectedAmount);
  return { expectedAmount, discrepancy, kind: discrepancyKind(discrepancy) };
}

/** A short or over remittance must say why; returns the trimmed note (null when blank). */
export function remittanceNote(totals: RemittanceTotals, note: string | null | undefined): string | null {
  const trimmed = note?.trim() || null;
  if (totals.kind && !trimmed) {
    throw new BadRequestException({
      message: `The remittance is ${totals.kind.toLowerCase()} by ${totals.discrepancy.abs().toFixed(2)} (expected ${totals.expectedAmount.toFixed(2)}); add a note explaining the difference`,
      extensions: { reason: DISCREPANCY_NOTE_REQUIRED },
    });
  }
  return trimmed;
}

/**
 * The request names at least one collection, or is an adjusting entry: cash with no collections (e.g. the rest of a
 * short remittance handed in later), which is all discrepancy and so needs its note.
 */
export function assertRemittanceNotEmpty(collectionIds: string[], amount: Prisma.Decimal): void {
  if (collectionIds.length === 0 && amount.isZero()) {
    throw new BadRequestException('A remittance needs at least one collection or an amount');
  }
  if (new Set(collectionIds).size !== collectionIds.length) {
    throw new BadRequestException('A collection is listed more than once');
  }
}

export function assertReceivedAt(receivedAt: Date, now: Date): void {
  if (receivedAt.getTime() > now.getTime() + COLLECTED_AT_CLOCK_SKEW_MS) {
    throw new BadRequestException(`receivedAt ${receivedAt.toISOString()} is in the future`);
  }
}

export interface RemittableCollection {
  id: string;
  riderId: string | null;
  remittanceId: string | null;
}

/** Every requested collection exists, was collected by this rider and has not been remitted yet. */
export function assertCollectionsRemittable(
  collectionIds: string[],
  found: RemittableCollection[],
  riderId: string,
): void {
  const byId = new Map(found.map((collection) => [collection.id, collection]));
  const missing = collectionIds.filter((id) => !byId.has(id));
  if (missing.length > 0) throw new NotFoundException(`Cash collection(s) not found: ${missing.join(', ')}`);
  const otherRider = found.filter((collection) => collection.riderId !== riderId);
  if (otherRider.length > 0) {
    throw new BadRequestException(
      `Cash collection(s) ${otherRider.map(({ id }) => id).join(', ')} were not collected by rider "${riderId}"`,
    );
  }
  const remitted = found.filter((collection) => collection.remittanceId !== null);
  if (remitted.length > 0) {
    throw new ConflictException({
      message: `Cash collection(s) ${remitted.map(({ id }) => id).join(', ')} have already been remitted`,
      extensions: { reason: COLLECTION_ALREADY_REMITTED },
    });
  }
}

export interface RemittingRiderFacts {
  isActive: boolean;
  isStaff: boolean;
  hasCollections: boolean;
}

/**
 * Cash is handed in by an active staff member, or by anyone who collected cash before (a rider who has since left
 * still owes what they collected).
 */
export function assertRemittingRider(rider: RemittingRiderFacts | null, riderId: string): void {
  if (!rider || !((rider.isStaff && rider.isActive) || rider.hasCollections)) {
    throw new BadRequestException({
      message: `Rider "${riderId}" must be an active staff member of the store or have collected cash before`,
      extensions: { reason: RIDER_NOT_STAFF },
    });
  }
}
