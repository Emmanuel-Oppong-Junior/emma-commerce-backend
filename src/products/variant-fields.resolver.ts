import { Parent, ResolveField, Resolver } from '@nestjs/graphql';
import { Variant } from '../variant/entities/variant.entity';
import { MoneyObject } from '../commons/money/money.object';
import { PublicPromotion } from '../promotions/entities/promotion.entity';
import { VariantPriceTier } from '../price-lists/entities/price-list.entity';
import { ActiveUser } from '../iam/authentication/decorators/active-user.decorator';
import { ListPrice } from '../pricing/price';
import { PromotionLoader } from './loaders/promotion.loader';

const toTier = (tier: ListPrice): VariantPriceTier => ({
  minQuantity: tier.minQuantity,
  unitPrice: tier.unitPrice,
  promotionsApply: tier.allowPromotions,
});

// Viewer-dependent price fields of a variant: they need the product module's loader, keyed by the signed-in user.
@Resolver(() => Variant)
export class VariantFieldsResolver {
  constructor(private readonly promotionLoader: PromotionLoader) {}

  @ResolveField(() => MoneyObject, {
    nullable: true,
    description:
      'Price of one unit after the best automatic promotion on it (its own, its product, category or brand); ' +
      'null without one. For a signed-in customer it starts from their price-list price when that applies to a single ' +
      'unit (none when the list does not allow promotions) and includes their customer-group and first-order ' +
      'promotions. Checkout may differ: coupons, cart minimums and cart promotions apply there.',
  })
  async discountedPrice(@Parent() variant: Variant, @ActiveUser('id') userId: string | undefined) {
    const { discountedPrice, discountAmount } = await this.promotionLoader.loader.load({
      userId: userId ?? null,
      variantId: variant.id,
    });
    return discountAmount.isZero() ? null : discountedPrice;
  }

  @ResolveField(() => PublicPromotion, { nullable: true, description: 'The promotion behind discountedPrice' })
  async appliedPromotion(
    @Parent() variant: Variant,
    @ActiveUser('id') userId: string | undefined,
  ): Promise<PublicPromotion | null> {
    const { promotion } = await this.promotionLoader.loader.load({ userId: userId ?? null, variantId: variant.id });
    return promotion
      ? { id: promotion.id, name: promotion.name, description: promotion.description, endsAt: promotion.endsAt }
      : null;
  }

  @ResolveField(() => VariantPriceTier, {
    nullable: true,
    description:
      "The signed-in customer's B2B price at its minimum quantity (the first of priceTiers); null for a visitor or " +
      'when none of their price lists prices this variant below its normal price',
  })
  async customerPrice(
    @Parent() variant: Variant,
    @ActiveUser('id') userId: string | undefined,
  ): Promise<VariantPriceTier | null> {
    if (!userId) return null;
    const { priceTiers } = await this.promotionLoader.loader.load({ userId, variantId: variant.id });
    return priceTiers?.length ? toTier(priceTiers[0]) : null;
  }

  @ResolveField(() => [VariantPriceTier], {
    nullable: true,
    description:
      "The signed-in customer's B2B unit prices by quantity, ascending (each from the quantity at which it applies, " +
      'counting units of this variant only); null for a visitor, empty when no price list applies',
  })
  async priceTiers(
    @Parent() variant: Variant,
    @ActiveUser('id') userId: string | undefined,
  ): Promise<VariantPriceTier[] | null> {
    if (!userId) return null;
    const { priceTiers } = await this.promotionLoader.loader.load({ userId, variantId: variant.id });
    return (priceTiers ?? []).map(toTier);
  }
}
