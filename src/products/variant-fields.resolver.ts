import { Parent, ResolveField, Resolver } from '@nestjs/graphql';
import { Variant } from '../variant/entities/variant.entity';
import { MoneyObject } from '../commons/money/money.object';
import { Discount } from '../discount/entities/discount.entity';
import { DiscountService } from '../discount/discount.service';
import { DiscountLoader } from './loaders/discount.loader';

// Discount fields of a variant: they need the product's discount loaders, which live in this module.
@Resolver(() => Variant)
export class VariantFieldsResolver {
  constructor(
    private readonly discountService: DiscountService,
    private readonly discountLoader: DiscountLoader,
  ) {}

  @ResolveField(() => MoneyObject, {
    nullable: true,
    description:
      "Price of one unit after the best active discount (its own, its product's or its category's); null without one",
  })
  async discountedPrice(@Parent() variant: Variant) {
    const { discountedPrice, discountAmount } = await this.discountLoader.loader.load(variant.id);
    return discountAmount.isZero() ? null : discountedPrice;
  }

  @ResolveField(() => Discount, { nullable: true, description: 'The discount behind discountedPrice' })
  async appliedDiscount(@Parent() variant: Variant) {
    const { discountId } = await this.discountLoader.loader.load(variant.id);
    return discountId ? this.discountService.findOneDiscount(discountId) : null;
  }
}
