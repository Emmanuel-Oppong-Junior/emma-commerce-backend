import { Injectable, Scope } from '@nestjs/common';
import * as DataLoader from 'dataloader';
import { Review } from '../../generated/prisma/client';
import { PrismaService } from '../../prisma/prisma.service';

export interface LatestReviewsKey {
  productId: string;
  first: number;
}

@Injectable({ scope: Scope.REQUEST })
export class ReviewsLoader {
  constructor(private readonly prisma: PrismaService) {}

  /**
   * The latest `first` PUBLISHED reviews of each product, newest first, in two queries per batch (N+1 free); the full
   * list is paginated through `productReviews`.
   */
  readonly loader = new DataLoader<LatestReviewsKey, Review[], string>(
    async (keys) => {
      const productIds = [...new Set(keys.map((key) => key.productId))];
      const limit = Math.max(...keys.map((key) => key.first));
      const ranked = await this.prisma.$queryRaw<{ id: string }[]>`
        SELECT "id" FROM (
          SELECT "id", ROW_NUMBER() OVER (PARTITION BY "productId" ORDER BY "createdAt" DESC, "id" DESC) AS rn
          FROM "Review" WHERE "productId" = ANY(${productIds}) AND "status" = 'PUBLISHED'
        ) latest WHERE rn <= ${limit}`;
      const reviews = await this.prisma.review.findMany({
        where: { id: { in: ranked.map((row) => row.id) } },
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      });
      return keys.map((key) => reviews.filter((review) => review.productId === key.productId).slice(0, key.first));
    },
    { cache: false, cacheKeyFn: (key) => `${key.productId}:${key.first}` },
  );
}
