import { Parent, ResolveField, Resolver } from '@nestjs/graphql';
import { Variant } from '../variant/entities/variant.entity';
import { MoneyObject } from '../commons/money/money.object';
import { PublicPromotion } from '../promotions/entities/promotion.entity';
import { PromotionLoader } from './loaders/promotion.loader';

// Promotion fields of a variant: they need the product module's promotion loader.
@Resolver(() => Variant)
export class VariantFieldsResolver {
  constructor(private readonly promotionLoader: PromotionLoader) {}

  @ResolveField(() => MoneyObject, {
    nullable: true,
    description:
      'Price of one unit after the best automatic promotion on it (its own, its product, category or brand); ' +
      'null without one. Checkout may differ: coupons, cart minimums and cart promotions apply there.',
  })
  async discountedPrice(@Parent() variant: Variant) {
    const { discountedPrice, discountAmount } = await this.promotionLoader.loader.load(variant.id);
    return discountAmount.isZero() ? null : discountedPrice;
  }

  @ResolveField(() => PublicPromotion, { nullable: true, description: 'The promotion behind discountedPrice' })
  async appliedPromotion(@Parent() variant: Variant): Promise<PublicPromotion | null> {
    const { promotion } = await this.promotionLoader.loader.load(variant.id);
    return promotion
      ? { id: promotion.id, name: promotion.name, description: promotion.description, endsAt: promotion.endsAt }
      : null;
  }
}
