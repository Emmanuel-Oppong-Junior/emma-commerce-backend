import { Args, ID, Mutation, Query, Resolver } from '@nestjs/graphql';
import { ActiveUser } from '../iam/authentication/decorators/active-user.decorator';
import { Auth } from '../iam/authentication/decorators/auth.decorator';
import { AuthType } from '../iam/authentication/enums/auth-type.enum';
import { RequirePermission, RequireStepUp } from '../iam/authorization/policy.decorators';
import { PromotionsService } from './promotions.service';
import { CouponCode, CouponCodeValidation, Promotion, RedemptionPage } from './entities/promotion.entity';
import { CreatePromotionInput, UpdatePromotionInput } from './dto/promotion.input';
import { CreateCouponCodeInput, UpdateCouponCodeInput } from './dto/coupon-code.input';
import { PromotionsArgs, RedemptionsArgs } from './dto/promotions.args';

@Resolver(() => Promotion)
export class PromotionsResolver {
  constructor(private readonly promotionsService: PromotionsService) {}

  @RequirePermission('promotion.manage')
  @Query(() => [Promotion], { description: 'Admin: promotions, newest first, optionally filtered' })
  promotions(@Args() filter: PromotionsArgs) {
    return this.promotionsService.findAll(filter);
  }

  @RequirePermission('promotion.manage')
  @Query(() => Promotion, { description: 'Admin: one promotion with its targets and coupon codes' })
  promotion(@Args('id', { type: () => ID }) id: string) {
    return this.promotionsService.findOne(id);
  }

  @RequirePermission('promotion.manage')
  @RequireStepUp()
  @Mutation(() => Promotion, { description: 'Admin: create a promotion' })
  createPromotion(@ActiveUser('id') actorId: string, @Args('input') input: CreatePromotionInput) {
    return this.promotionsService.create(input, actorId);
  }

  @RequirePermission('promotion.manage')
  @RequireStepUp()
  @Mutation(() => Promotion, { description: 'Admin: change a promotion' })
  updatePromotion(
    @ActiveUser('id') actorId: string,
    @Args('id', { type: () => ID }) id: string,
    @Args('input') input: UpdatePromotionInput,
  ) {
    return this.promotionsService.update(id, input, actorId);
  }

  @RequirePermission('promotion.manage')
  @RequireStepUp()
  @Mutation(() => Promotion, {
    description: 'Admin: delete a promotion no order has used, with its coupon codes (deactivate a used one)',
  })
  deletePromotion(@ActiveUser('id') actorId: string, @Args('id', { type: () => ID }) id: string) {
    return this.promotionsService.delete(id, actorId);
  }

  @RequirePermission('promotion.manage')
  @RequireStepUp()
  @Mutation(() => CouponCode, { description: 'Admin: add a coupon code that unlocks a promotion' })
  createCouponCode(@ActiveUser('id') actorId: string, @Args('input') input: CreateCouponCodeInput) {
    return this.promotionsService.createCouponCode(input, actorId);
  }

  @RequirePermission('promotion.manage')
  @RequireStepUp()
  @Mutation(() => CouponCode, { description: 'Admin: change a coupon code' })
  updateCouponCode(
    @ActiveUser('id') actorId: string,
    @Args('id', { type: () => ID }) id: string,
    @Args('input') input: UpdateCouponCodeInput,
  ) {
    return this.promotionsService.updateCouponCode(id, input, actorId);
  }

  @RequirePermission('promotion.manage')
  @RequireStepUp()
  @Mutation(() => CouponCode, { description: 'Admin: delete a coupon code no order has used (deactivate a used one)' })
  deleteCouponCode(@ActiveUser('id') actorId: string, @Args('id', { type: () => ID }) id: string) {
    return this.promotionsService.deleteCouponCode(id, actorId);
  }

  @RequirePermission('promotion.manage')
  @Query(() => RedemptionPage, { description: 'Admin: promotion uses by orders, newest first' })
  redemptions(@Args() { promotionId, customerId, orderId, status, first, after }: RedemptionsArgs) {
    return this.promotionsService.getRedemptions({ promotionId, customerId, orderId, status }, first, after);
  }

  @Auth(AuthType.Bearer)
  @Query(() => CouponCodeValidation, {
    description:
      'What a coupon code unlocks, if the signed-in customer may use it now; checkoutQuote with couponCode gives its ' +
      'exact effect on the cart. Fails with NOT_FOUND for an unknown code and BAD_REQUEST with the reason otherwise.',
  })
  validateCouponCode(@ActiveUser('id') customerId: string, @Args('code') code: string) {
    return this.promotionsService.validateCouponCode(code, customerId);
  }
}
