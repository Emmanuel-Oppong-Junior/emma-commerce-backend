import { Injectable } from '@nestjs/common';
import { ModerationStatus, Prisma, Review, ReviewPhoto } from '../generated/prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { PUBLIC_PRODUCT_WHERE } from '../products/products.service';
import { PurchasedLine, ratingDistribution, ratingSummary } from './review-rules';
import { ReviewSort } from './dto/review-list.args';

type Tx = Prisma.TransactionClient;

const ORDER_BY: Record<ReviewSort, Prisma.ReviewOrderByWithRelationInput[]> = {
  [ReviewSort.NEWEST]: [{ createdAt: 'desc' }, { id: 'desc' }],
  [ReviewSort.HIGHEST]: [{ score: 'desc' }, { createdAt: 'desc' }, { id: 'desc' }],
  [ReviewSort.LOWEST]: [{ score: 'asc' }, { createdAt: 'desc' }, { id: 'desc' }],
};

const page = (first: number, after?: string | null): { take: number; skip?: number; cursor?: { id: string } } =>
  after ? { take: first, skip: 1, cursor: { id: after } } : { take: first };

@Injectable()
export class ReviewRepository {
  constructor(private readonly prisma: PrismaService) {}

  transaction<T>(work: (tx: Tx) => Promise<T>): Promise<T> {
    return this.prisma.$transaction(work);
  }

  async isPublicProduct(productId: string): Promise<boolean> {
    return (await this.prisma.product.count({ where: { id: productId, ...PUBLIC_PRODUCT_WHERE } })) > 0;
  }

  /** Serialises every review change of a product, so its stored rating never loses an update. */
  async lockProduct(tx: Tx, productId: string): Promise<boolean> {
    const rows = await tx.$queryRaw<unknown[]>`SELECT 1 FROM "Product" WHERE "id" = ${productId} FOR UPDATE`;
    return rows.length > 0;
  }

  async lockReview(tx: Tx, reviewId: string): Promise<void> {
    await tx.$queryRaw`SELECT 1 FROM "Review" WHERE "id" = ${reviewId} FOR UPDATE`;
  }

  /** Recomputes the product's stored rating from its published reviews; call under lockProduct. */
  async refreshRating(tx: Tx, productId: string): Promise<void> {
    const groups = await tx.review.groupBy({
      by: ['score'],
      where: { productId, status: ModerationStatus.PUBLISHED },
      _count: { _all: true },
    });
    const summary = ratingSummary(ratingDistribution(groups.map((g) => ({ score: g.score, count: g._count._all }))));
    // Raw so Product.updatedAt stays the time the product itself last changed.
    await tx.$executeRaw`
      UPDATE "Product" SET "ratingCount" = ${summary.ratingCount}, "ratingAverage" = ${summary.ratingAverage?.toFixed(2) ?? null}::numeric,
        "rating1Count" = ${summary.rating1Count}, "rating2Count" = ${summary.rating2Count},
        "rating3Count" = ${summary.rating3Count}, "rating4Count" = ${summary.rating4Count},
        "rating5Count" = ${summary.rating5Count}
      WHERE "id" = ${productId}`;
  }

  /** The customer's order lines for the product with their delivered and refunded units. */
  async purchasedLines(tx: Tx, userId: string, productId: string): Promise<PurchasedLine[]> {
    const lines = await tx.orderItem.findMany({
      where: { productId, order: { userId } },
      select: {
        id: true,
        quantity: true,
        order: { select: { status: true, createdAt: true } },
        shipmentItems: { where: { shipment: { status: 'DELIVERED' } }, select: { quantity: true } },
        refundLines: { where: { refund: { status: { not: 'FAILED' } } }, select: { quantity: true } },
      },
    });
    return lines.map((line) => ({
      orderItemId: line.id,
      orderStatus: line.order.status,
      orderedAt: line.order.createdAt,
      quantity: line.quantity,
      deliveredUnits: line.shipmentItems.reduce((sum, item) => sum + item.quantity, 0),
      refundedUnits: line.refundLines.reduce((sum, item) => sum + item.quantity, 0),
    }));
  }

  findOwn(tx: Tx, userId: string, productId: string): Promise<Review | null> {
    return tx.review.findUnique({ where: { userId_productId: { userId, productId } } });
  }

  findById(reviewId: string, tx: Tx = this.prisma): Promise<Review | null> {
    return tx.review.findUnique({ where: { id: reviewId } });
  }

  create(tx: Tx, data: Prisma.ReviewUncheckedCreateInput): Promise<Review> {
    return tx.review.create({ data });
  }

  update(tx: Tx, reviewId: string, data: Prisma.ReviewUncheckedUpdateInput): Promise<Review> {
    return tx.review.update({ where: { id: reviewId }, data });
  }

  delete(tx: Tx, reviewId: string): Promise<Review> {
    return tx.review.delete({ where: { id: reviewId } });
  }

  findPublished(productId: string, sort: ReviewSort, first: number, after?: string | null): Promise<Review[]> {
    return this.prisma.review.findMany({
      where: { productId, status: ModerationStatus.PUBLISHED },
      orderBy: ORDER_BY[sort],
      ...page(first, after),
    });
  }

  findByUser(userId: string, first: number, after?: string | null): Promise<Review[]> {
    return this.prisma.review.findMany({
      where: { userId },
      orderBy: ORDER_BY[ReviewSort.NEWEST],
      ...page(first, after),
    });
  }

  /** Reviews with open reports, oldest first, each with its open reports. */
  findReported(first: number, after?: string | null) {
    return this.prisma.review.findMany({
      where: { reports: { some: { resolvedAt: null } } },
      include: { reports: { where: { resolvedAt: null }, orderBy: { createdAt: 'asc' } } },
      orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
      ...page(first, after),
    });
  }

  createReport(tx: Tx, data: Prisma.ReviewReportUncheckedCreateInput) {
    return tx.reviewReport.create({ data });
  }

  findReport(reviewId: string, reporterId: string) {
    return this.prisma.reviewReport.findUnique({ where: { reviewId_reporterId: { reviewId, reporterId } } });
  }

  /** Closes the review's open reports; returns how many. */
  async resolveReports(tx: Tx, reviewId: string, now: Date): Promise<number> {
    return (await tx.reviewReport.updateMany({ where: { reviewId, resolvedAt: null }, data: { resolvedAt: now } }))
      .count;
  }

  countPhotos(tx: Tx, reviewId: string): Promise<number> {
    return tx.reviewPhoto.count({ where: { reviewId } });
  }

  addPhoto(tx: Tx, data: { reviewId: string; publicId: string; url: string }): Promise<ReviewPhoto> {
    return tx.reviewPhoto.create({ data });
  }

  findPhoto(photoId: string) {
    return this.prisma.reviewPhoto.findUnique({ where: { id: photoId }, include: { review: true } });
  }

  deletePhoto(photoId: string): Promise<ReviewPhoto> {
    return this.prisma.reviewPhoto.delete({ where: { id: photoId } });
  }
}
