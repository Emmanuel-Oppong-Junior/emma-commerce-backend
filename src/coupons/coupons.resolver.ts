import { Args, ID, Mutation, Query, Resolver } from '@nestjs/graphql';
import { CouponsService } from './coupons.service';
import { Coupon } from './entities/coupon.entity';
import { CouponValidation } from './entities/coupon-validation.entity';
import { CreateCouponInput } from './dto/create-coupon.input';
import { UpdateCouponInput } from './dto/update-coupon.input';
import { ValidateCouponInput } from './dto/validate-coupon.input';
import { Roles } from '../iam/authentication/decorators/roles.decorator';
import { Role } from '../users/enums/role.enum';
import { ActiveUser } from '../iam/authentication/decorators/active-user.decorator';

@Resolver(() => Coupon)
export class CouponsResolver {
  constructor(private readonly couponsService: CouponsService) {}

  @Roles(Role.ADMIN, Role.SUPER_ADMIN)
  @Mutation(() => Coupon, { description: 'Create a new coupon (admin only)' })
  createCoupon(@ActiveUser('id') actorId: string, @Args('input') input: CreateCouponInput) {
    return this.couponsService.createCoupon(input, actorId);
  }

  @Roles(Role.ADMIN, Role.SUPER_ADMIN)
  @Mutation(() => Coupon, { description: 'Update a coupon (admin only)' })
  updateCoupon(
    @ActiveUser('id') actorId: string,
    @Args('id', { type: () => ID }) id: string,
    @Args('input') input: UpdateCouponInput,
  ) {
    return this.couponsService.updateCoupon(id, input, actorId);
  }

  @Roles(Role.ADMIN, Role.SUPER_ADMIN)
  @Mutation(() => Coupon, { description: 'Delete a coupon (admin only)' })
  deleteCoupon(@ActiveUser('id') actorId: string, @Args('id', { type: () => ID }) id: string) {
    return this.couponsService.deleteCoupon(id, actorId);
  }

  @Roles(Role.ADMIN, Role.SUPER_ADMIN)
  @Query(() => [Coupon], { description: 'Get all coupons (admin only)' })
  coupons() {
    return this.couponsService.findAll();
  }

  @Roles(Role.ADMIN, Role.SUPER_ADMIN)
  @Query(() => Coupon, { description: 'Get a coupon by ID (admin only)' })
  coupon(@Args('id', { type: () => ID }) id: string) {
    return this.couponsService.findOne(id);
  }

  @Roles(Role.USER, Role.ADMIN, Role.SUPER_ADMIN)
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
