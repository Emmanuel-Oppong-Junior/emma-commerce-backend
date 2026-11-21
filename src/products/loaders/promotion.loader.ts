import { Injectable, Scope } from '@nestjs/common';
import * as DataLoader from 'dataloader';
import { Decimal } from '@prisma/client/runtime/client';
import { PrismaService } from '../../prisma/prisma.service';
import { displayPriceTiers, displayUnitPromotions, ListPrice, PricingPromotion } from '../../pricing/price';
import { PromotionsService } from '../../promotions/promotions.service';
import { PriceListsService } from '../../price-lists/price-lists.service';
import { StoreService } from '../../store/store.service';

/**
 * What a product page shows the viewer on one unit of a variant: the price after its promotions and the one saving
 * the most, and for a signed-in customer their price-list tiers (null for a visitor).
 */
export interface DisplayedPromotion {
  discountedPrice: Decimal;
  discountAmount: Decimal;
  promotion?: PricingPromotion;
  priceTiers: ListPrice[] | null;
}

/** Who is looking at which variant: the signed-in user's id, or null for a visitor. */
export interface DisplayKey {
  userId: string | null;
  variantId: string;
}

const NO_PROMOTION = { discountedPrice: new Decimal(0), discountAmount: new Decimal(0) };

const unique = (values: (string | null)[]) => [...new Set(values.filter((value): value is string => value !== null))];

@Injectable({ scope: Scope.REQUEST })
export class PromotionLoader {
  constructor(
    private readonly prisma: PrismaService,
    private readonly promotionsService: PromotionsService,
    private readonly priceListsService: PriceListsService,
    private readonly storeService: StoreService,
  ) {}

  /**
   * The promotion and price-list tiers shown on one unit of each variant, picked by the pricing engine's display rules
   * (displayUnitPromotions, displayPriceTiers), batched per request and viewer. Keys carry the viewer, so one
   * customer's prices are never served to another, even within a batch.
   */
  readonly loader = new DataLoader<DisplayKey, DisplayedPromotion, string>(
    async (keys: readonly DisplayKey[]) => {
      const viewers = [...new Set(keys.map((key) => key.userId))];
      const shown = new Map<string, DisplayedPromotion>();
      for (const userId of viewers) {
        const variantIds = keys.filter((key) => key.userId === userId).map((key) => key.variantId);
        const displayed = await this.display(variantIds, userId);
        for (const [variantId, value] of displayed) shown.set(keyOf({ userId, variantId }), value);
      }
      return keys.map((key) => shown.get(keyOf(key))!);
    },
    { cache: false, cacheKeyFn: keyOf }, // Per-request cache disabled — data can change between resolves
  );

  private async display(variantIds: string[], userId: string | null): Promise<Map<string, DisplayedPromotion>> {
    const variants = await this.prisma.variant.findMany({
      where: { id: { in: variantIds } },
      select: {
        id: true,
        price: true,
        productId: true,
        product: { select: { categoryId: true, brandId: true } },
      },
    });
    const now = new Date();
    const { promotions, customer } = await this.promotionsService.findForPricing(
      {
        variantIds: variants.map((variant) => variant.id),
        productIds: unique(variants.map((variant) => variant.productId)),
        categoryIds: unique(variants.map((variant) => variant.product.categoryId)),
        brandIds: unique(variants.map((variant) => variant.product.brandId)),
      },
      userId,
      undefined,
      now,
    );
    const priceLists = userId ? await this.priceListsService.findForPricing(variantIds, customer.groupIds, now) : [];
    const currency = priceLists.length > 0 ? await this.storeService.getCurrency() : undefined;
    const byId = new Map(variants.map((variant) => [variant.id, variant]));
    return new Map(
      variantIds.map((id): [string, DisplayedPromotion] => {
        const variant = byId.get(id);
        if (!variant || variant.price === null) return [id, { ...NO_PROMOTION, priceTiers: userId ? [] : null }];
        const priceTiers = userId
          ? currency
            ? displayPriceTiers(id, variant.price, { currency, now, customer, priceLists })
            : []
          : null;
        // discountedPrice is for one unit: from the member's list when it prices a single unit, else the normal price.
        const single = priceTiers?.[0]?.minQuantity === 1 ? priceTiers[0] : undefined;
        const unitPrice = single?.unitPrice ?? variant.price;
        if (single && !single.allowPromotions) return [id, { ...NO_PROMOTION, discountedPrice: unitPrice, priceTiers }];
        const { unitDiscount, applied } = displayUnitPromotions(
          {
            variantId: variant.id,
            productId: variant.productId,
            categoryId: variant.product.categoryId,
            brandId: variant.product.brandId,
            unitListPrice: unitPrice,
          },
          promotions,
          now,
          userId ? customer : null,
        );
        const main = applied.reduce<(typeof applied)[number] | undefined>(
          (largest, each) => (largest && !each.unitSaving.gt(largest.unitSaving) ? largest : each),
          undefined,
        );
        return [
          id,
          {
            discountedPrice: unitPrice.sub(unitDiscount),
            discountAmount: unitDiscount,
            promotion: main?.promotion,
            priceTiers,
          },
        ];
      }),
    );
  }
}

function keyOf(key: DisplayKey): string {
  return `${key.userId ?? ''}:${key.variantId}`;
}
