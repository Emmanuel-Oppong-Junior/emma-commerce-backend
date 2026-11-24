import { Decimal } from '@prisma/client/runtime/client';

export const MAX_REVIEW_PHOTOS = 4;
export const MAX_REVIEW_TITLE_LENGTH = 120;
export const MAX_REVIEW_COMMENT_LENGTH = 2000;
export const MAX_REVIEW_REPLY_LENGTH = 2000;
export const MAX_REPORT_NOTE_LENGTH = 500;
export const MAX_MODERATION_REASON_LENGTH = 500;

export const reviewPhotoFolder = (reviewId: string) => `reviews/${reviewId}`;

/** One of the customer's order lines for the product, with what happened to its units. */
export interface PurchasedLine {
  orderItemId: string;
  orderStatus: string;
  orderedAt: Date;
  quantity: number;
  /** Units in DELIVERED shipments */
  deliveredUnits: number;
  /** Units on refunds that did not fail */
  refundedUnits: number;
}

/**
 * Units the customer received and kept. A COMPLETED order had every unit delivered or refunded, so all its unrefunded
 * units count (orders completed before split shipments have no shipment rows). Otherwise only units in DELIVERED
 * shipments count, less what was refunded.
 */
export function keptDeliveredUnits(line: PurchasedLine): number {
  const delivered = line.orderStatus === 'COMPLETED' ? line.quantity : line.deliveredUnits;
  return Math.max(0, Math.min(delivered, line.quantity - line.refundedUnits));
}

/** The latest order line that makes a review a verified purchase, or null when the customer kept no delivered unit. */
export function verifyingLine(lines: readonly PurchasedLine[]): string | null {
  const qualifying = lines
    .filter((line) => keptDeliveredUnits(line) > 0)
    .sort((a, b) => b.orderedAt.getTime() - a.orderedAt.getTime() || b.orderItemId.localeCompare(a.orderItemId));
  return qualifying[0]?.orderItemId ?? null;
}

export type RatingDistribution = [number, number, number, number, number];

export interface ProductRatingSummary {
  ratingCount: number;
  ratingAverage: Decimal | null;
  rating1Count: number;
  rating2Count: number;
  rating3Count: number;
  rating4Count: number;
  rating5Count: number;
}

/** Counts per star (index 0 = 1 star) of the given published scores. */
export function ratingDistribution(scores: readonly { score: number; count: number }[]): RatingDistribution {
  const distribution: RatingDistribution = [0, 0, 0, 0, 0];
  for (const { score, count } of scores) {
    if (!Number.isInteger(score) || score < 1 || score > 5) throw new Error(`Review score ${score} is outside 1-5`);
    distribution[score - 1] += count;
  }
  return distribution;
}

/** The stored rating of a product: count, per-star counts and the mean rounded half-up to 2 decimals. */
export function ratingSummary(distribution: RatingDistribution): ProductRatingSummary {
  const ratingCount = distribution.reduce((sum, count) => sum + count, 0);
  const total = distribution.reduce((sum, count, index) => sum + count * (index + 1), 0);
  return {
    ratingCount,
    ratingAverage:
      ratingCount === 0 ? null : new Decimal(total).div(ratingCount).toDecimalPlaces(2, Decimal.ROUND_HALF_UP),
    rating1Count: distribution[0],
    rating2Count: distribution[1],
    rating3Count: distribution[2],
    rating4Count: distribution[3],
    rating5Count: distribution[4],
  };
}

export type ModerationAction = 'HIDE' | 'UNHIDE';

/** Why a moderation action is refused for content in `status`, or null when it applies. */
export function moderationRefusal(status: 'PUBLISHED' | 'HIDDEN', action: ModerationAction): string | null {
  if (action === 'HIDE' && status === 'HIDDEN') return 'It is already hidden';
  if (action === 'UNHIDE' && status === 'PUBLISHED') return 'It is not hidden';
  return null;
}

/** Why a customer may not report this content, or null when they may. */
export function reportRefusal(authorId: string, reporterId: string): string | null {
  return authorId === reporterId ? 'You cannot report your own content' : null;
}

/** Trimmed text, or null when nothing is left. */
export function cleanText(value: string | null | undefined): string | null {
  const trimmed = value?.trim();
  return trimmed ? trimmed : null;
}
