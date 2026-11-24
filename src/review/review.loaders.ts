import { Injectable, Scope } from '@nestjs/common';
import * as DataLoader from 'dataloader';
import { ReviewPhoto } from '../generated/prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { ProductRating } from './entities/product-rating.entity';

@Injectable({ scope: Scope.REQUEST })
export class ReviewPhotosLoader {
  constructor(private readonly prisma: PrismaService) {}

  readonly loader = new DataLoader<string, ReviewPhoto[]>(
    async (reviewIds) => {
      const photos = await this.prisma.reviewPhoto.findMany({
        where: { reviewId: { in: [...reviewIds] } },
        orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
      });
      return reviewIds.map((id) => photos.filter((photo) => photo.reviewId === id));
    },
    { cache: false },
  );
}

@Injectable({ scope: Scope.REQUEST })
export class ProductRatingLoader {
  constructor(private readonly prisma: PrismaService) {}

  readonly loader = new DataLoader<string, ProductRating>(
    async (productIds) => {
      const rows = await this.prisma.product.findMany({
        where: { id: { in: [...productIds] } },
        select: {
          id: true,
          ratingCount: true,
          ratingAverage: true,
          rating1Count: true,
          rating2Count: true,
          rating3Count: true,
          rating4Count: true,
          rating5Count: true,
        },
      });
      const byId = new Map(rows.map((row) => [row.id, row]));
      return productIds.map((id) => {
        const row = byId.get(id);
        if (!row) return new Error(`Product "${id}" not found`);
        const counts = [row.rating5Count, row.rating4Count, row.rating3Count, row.rating2Count, row.rating1Count];
        return {
          average: row.ratingAverage === null ? null : row.ratingAverage.toNumber(),
          count: row.ratingCount,
          distribution: counts.map((count, index) => ({ stars: 5 - index, count })),
        };
      });
    },
    { cache: false },
  );
}
