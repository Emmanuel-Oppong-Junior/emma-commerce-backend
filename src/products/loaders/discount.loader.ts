import { Injectable, Scope } from '@nestjs/common';
import * as DataLoader from 'dataloader';
import { PrismaService } from '../../prisma/prisma.service';
import { Prisma } from '../../generated/prisma/client';
import { DiscountCalculation } from '../../discount/types';
import { bestUnitPrice, toDiscountCalculation } from '../../discount/pricing';
import { DiscountService } from '../../discount/discount.service';

const NO_DISCOUNT: DiscountCalculation = {
  discountedPrice: new Prisma.Decimal(0),
  discountAmount: new Prisma.Decimal(0),
};

@Injectable({ scope: Scope.REQUEST })
export class DiscountLoader {
  constructor(
    private readonly prisma: PrismaService,
    private readonly discountService: DiscountService,
  ) {}

  /**
   * The best active discount on one unit of each variant (its own, its product's or its category's), batched per
   * request: one variant query and one discount query however many variants are resolved.
   */
  readonly loader = new DataLoader<string, DiscountCalculation>(
    async (variantIds: readonly string[]) => {
      const variants = await this.prisma.variant.findMany({
        where: { id: { in: [...variantIds] } },
        select: { id: true, price: true, productId: true, discountId: true, product: { select: { categoryId: true } } },
      });
      const discounts = await this.discountService.findActiveDiscountsByVariant(
        variants.map((variant) => ({
          id: variant.id,
          productId: variant.productId,
          categoryId: variant.product.categoryId,
          discountId: variant.discountId,
        })),
      );
      const byId = new Map(variants.map((variant) => [variant.id, variant]));
      return variantIds.map((id) => {
        const variant = byId.get(id);
        if (!variant || variant.price === null) return NO_DISCOUNT;
        return toDiscountCalculation(bestUnitPrice(variant.price, discounts.get(id) ?? []));
      });
    },
    { cache: false }, // Per-request cache disabled — data can change between resolves
  );
}
