import { Args, ID, Mutation, Query, Resolver } from '@nestjs/graphql';
import { CouponsService } from './coupons.service';
import { Coupon } from './entities/coupon.entity';
import { CouponValidation } from './entities/coupon-validation.entity';
import { CreateCouponInput } from './dto/create-coupon.input';
import { UpdateCouponInput } from './dto/update-coupon.input';
import { ValidateCouponInput } from './dto/validate-coupon.input';
import { ActiveUser } from '../iam/authentication/decorators/active-user.decorator';
import { Auth } from '../iam/authentication/decorators/auth.decorator';
import { AuthType } from '../iam/authentication/enums/auth-type.enum';
import { RequirePermission, RequireStepUp } from '../iam/authorization/policy.decorators';

@Resolver(() => Coupon)
export class CouponsResolver {
  constructor(private readonly couponsService: CouponsService) {}

  @RequirePermission('promotion.manage')
  @RequireStepUp()
  @Mutation(() => Coupon, { description: 'Create a new coupon (admin only)' })
  createCoupon(@ActiveUser('id') actorId: string, @Args('input') input: CreateCouponInput) {
    return this.couponsService.createCoupon(input, actorId);
  }

  @RequirePermission('promotion.manage')
  @RequireStepUp()
  @Mutation(() => Coupon, { description: 'Update a coupon (admin only)' })
  updateCoupon(
    @ActiveUser('id') actorId: string,
    @Args('id', { type: () => ID }) id: string,
    @Args('input') input: UpdateCouponInput,
  ) {
    return this.couponsService.updateCoupon(id, input, actorId);
  }

  @RequirePermission('promotion.manage')
  @RequireStepUp()
  @Mutation(() => Coupon, { description: 'Delete a coupon (admin only)' })
  deleteCoupon(@ActiveUser('id') actorId: string, @Args('id', { type: () => ID }) id: string) {
    return this.couponsService.deleteCoupon(id, actorId);
  }

  @RequirePermission('promotion.manage')
  @Query(() => [Coupon], { description: 'Get all coupons (admin only)' })
  coupons() {
    return this.couponsService.findAll();
  }

  @RequirePermission('promotion.manage')
  @Query(() => Coupon, { description: 'Get a coupon by ID (admin only)' })
  coupon(@Args('id', { type: () => ID }) id: string) {
    return this.couponsService.findOne(id);
  }

  @Auth(AuthType.Bearer)
  @Mutation(() => CouponValidation, { description: 'Validate a coupon code before applying to order' })
  async validateCoupon(
    @ActiveUser('id') userId: string,
    @Args('input') input: ValidateCouponInput,
  ): Promise<CouponValidation> {
    const { discountAmount } = await this.couponsService.validateCoupon(input.code, userId, input.orderTotal);
    return {
      valid: true,
      discountAmount,
      message: `Coupon applied. You save ${discountAmount.toFixed(2)}.`,
    };
  }
}
