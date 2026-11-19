import { Injectable, Scope } from '@nestjs/common';
import * as DataLoader from 'dataloader';
import { PrismaService } from '../../prisma/prisma.service';
import { Prisma } from '../../generated/prisma/client';
import { DiscountCalculation } from '../../discount/types';
import { bestUnitPrice, CandidateDiscount, toDiscountCalculation } from '../../discount/pricing';

type CategoryDiscount = CandidateDiscount & { categories: { id: string }[] };

@Injectable({ scope: Scope.REQUEST })
export class DiscountLoader {
  constructor(private readonly prisma: PrismaService) {}

  /**
   * Batches discount lookups for multiple products in a single request.
   * Prevents N+1 queries when resolving discountedPrice / appliedDiscount fields.
   */
  readonly loader = new DataLoader<string, DiscountCalculation>(
    async (productIds: readonly string[]) => {
      const ids = [...productIds];

      // Fetch products with their active discounts + category discounts in bulk
      const products = await this.prisma.product.findMany({
        where: { id: { in: ids } },
        select: {
          id: true,
          price: true,
          categoryId: true,
          discounts: {
            where: {
              isActive: true,
              startDate: { lte: new Date() },
              endDate: { gte: new Date() },
            },
          },
        },
      });

      // Collect all unique categoryIds to batch category-discount lookup
      const categoryIds = [
        ...new Set(products.map((p) => p.categoryId).filter((id): id is string => id !== null && id !== undefined)),
      ];

      const categoryDiscounts: CategoryDiscount[] =
        categoryIds.length > 0
          ? ((await this.prisma.discount.findMany({
              where: {
                isActive: true,
                startDate: { lte: new Date() },
                endDate: { gte: new Date() },
                categories: { some: { id: { in: categoryIds } } },
              },
              include: { categories: { select: { id: true } } },
            })) as unknown as CategoryDiscount[])
          : [];

      // Build a map: categoryId → discounts[]
      const categoryDiscountMap = new Map<string, CategoryDiscount[]>();
      for (const discount of categoryDiscounts) {
        for (const cat of discount.categories) {
          if (!categoryDiscountMap.has(cat.id)) categoryDiscountMap.set(cat.id, []);
          categoryDiscountMap.get(cat.id)!.push(discount);
        }
      }

      // Map results back in the same order as productIds
      return ids.map((productId) => {
        const product = products.find((p) => p.id === productId);
        if (!product) return { discountedPrice: new Prisma.Decimal(0), discountAmount: new Prisma.Decimal(0) };

        const allDiscounts: CandidateDiscount[] = [
          ...product.discounts,
          ...(product.categoryId ? (categoryDiscountMap.get(product.categoryId) ?? []) : []),
        ];

        return toDiscountCalculation(bestUnitPrice(product.price ?? 0, allDiscounts));
      });
    },
    { cache: false }, // Per-request cache disabled — data can change between resolves
  );
}
