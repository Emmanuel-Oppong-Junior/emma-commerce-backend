import { Injectable, Scope } from '@nestjs/common';
import * as DataLoader from 'dataloader';
import { Review } from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.service';

@Injectable({ scope: Scope.REQUEST })
export class ReviewsLoader {
  constructor(private readonly prisma: PrismaService) {}

  /**
   * Batches review lookups for multiple products in a single request.
   * Prevents N+1 queries when resolving the `reviews` field on Product.
   */
  readonly loader = new DataLoader<string, Review[]>(
    async (productIds: readonly string[]) => {
      const ids = [...productIds];

      const reviews = await this.prisma.review.findMany({
        where: { productId: { in: ids } },
        orderBy: { id: 'asc' },
      });

      const reviewsByProductId = new Map<string, Review[]>();
      for (const id of ids) reviewsByProductId.set(id, []);
      for (const review of reviews) {
        reviewsByProductId.get(review.productId)?.push(review);
      }

      return ids.map((id) => reviewsByProductId.get(id) ?? []);
    },
    { cache: false },
  );
}
