import { Injectable, Scope } from '@nestjs/common';
import * as DataLoader from 'dataloader';
import { Decimal } from '@prisma/client/runtime/client';
import { PrismaService } from '../../prisma/prisma.service';
import { displayUnitPromotions, PricingPromotion } from '../../pricing/price';
import { PromotionsService } from '../../promotions/promotions.service';

/** What a product page shows on one unit of a variant: the price after its promotions and the one saving the most. */
export interface DisplayedPromotion {
  discountedPrice: Decimal;
  discountAmount: Decimal;
  promotion?: PricingPromotion;
}

const NO_PROMOTION: DisplayedPromotion = { discountedPrice: new Decimal(0), discountAmount: new Decimal(0) };

const unique = (values: (string | null)[]) => [...new Set(values.filter((value): value is string => value !== null))];

@Injectable({ scope: Scope.REQUEST })
export class PromotionLoader {
  constructor(
    private readonly prisma: PrismaService,
    private readonly promotionsService: PromotionsService,
  ) {}

  /**
   * The promotion shown on one unit of each variant, picked by the pricing engine's display rule (displayUnitPromotions),
   * batched per request: one variant query and one promotion query however many variants are resolved.
   */
  readonly loader = new DataLoader<string, DisplayedPromotion>(
    async (variantIds: readonly string[]) => {
      const variants = await this.prisma.variant.findMany({
        where: { id: { in: [...variantIds] } },
        select: {
          id: true,
          price: true,
          productId: true,
          product: { select: { categoryId: true, brandId: true } },
        },
      });
      const now = new Date();
      const { promotions } = await this.promotionsService.findForPricing(
        {
          variantIds: variants.map((variant) => variant.id),
          productIds: unique(variants.map((variant) => variant.productId)),
          categoryIds: unique(variants.map((variant) => variant.product.categoryId)),
          brandIds: unique(variants.map((variant) => variant.product.brandId)),
        },
        null,
        undefined,
        now,
      );
      const byId = new Map(variants.map((variant) => [variant.id, variant]));
      return variantIds.map((id) => {
        const variant = byId.get(id);
        if (!variant || variant.price === null) return NO_PROMOTION;
        const { unitDiscount, applied } = displayUnitPromotions(
          {
            variantId: variant.id,
            productId: variant.productId,
            categoryId: variant.product.categoryId,
            brandId: variant.product.brandId,
            unitListPrice: variant.price,
          },
          promotions,
          now,
        );
        const main = applied.reduce<(typeof applied)[number] | undefined>(
          (largest, each) => (largest && !each.unitSaving.gt(largest.unitSaving) ? largest : each),
          undefined,
        );
        return {
          discountedPrice: variant.price.sub(unitDiscount),
          discountAmount: unitDiscount,
          promotion: main?.promotion,
        };
      });
    },
    { cache: false }, // Per-request cache disabled — data can change between resolves
  );
}
