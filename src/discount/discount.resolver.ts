import { Args, ID, Mutation, Query, Resolver } from '@nestjs/graphql';
import { DiscountService } from './discount.service';
import { Discount } from './entities/discount.entity';
import { CreateDiscountInput } from './dto/create-discount.input';
import { UpdateDiscountInput } from './dto/update-discount.input';
import { ModifyDiscountItemsInput } from './dto/modify-discount-items.input';
import { ActiveUser } from '../iam/authentication/decorators/active-user.decorator';
import { RequirePermission } from '../iam/authorization/policy.decorators';

@Resolver(() => Discount)
export class DiscountResolver {
  constructor(private readonly discountService: DiscountService) {}

  @RequirePermission('promotion.manage')
  @Mutation(() => Discount)
  createDiscount(
    @ActiveUser('id') actorId: string,
    @Args('createDiscountInput') createDiscountInput: CreateDiscountInput,
  ) {
    return this.discountService.createDiscount(createDiscountInput, actorId);
  }

  @RequirePermission('promotion.manage')
  @Query(() => [Discount], { name: 'discounts' })
  findAll() {
    return this.discountService.findAllDiscounts();
  }

  @RequirePermission('promotion.manage')
  @Query(() => Discount, { name: 'discount' })
  findOne(@Args('id', { type: () => ID }) id: string) {
    return this.discountService.findOneDiscount(id);
  }

  @RequirePermission('promotion.manage')
  @Mutation(() => Discount)
  updateDiscount(
    @ActiveUser('id') actorId: string,
    @Args('updateDiscountInput') updateDiscountInput: UpdateDiscountInput,
  ) {
    return this.discountService.updateDiscount(updateDiscountInput.id, updateDiscountInput, actorId);
  }

  @RequirePermission('promotion.manage')
  @Mutation(() => Discount)
  addToDiscount(@ActiveUser('id') actorId: string, @Args('modifyDiscountItemsInput') input: ModifyDiscountItemsInput) {
    return this.discountService.addToDiscount(input, actorId);
  }

  @RequirePermission('promotion.manage')
  @Mutation(() => Discount)
  removeFromDiscount(
    @ActiveUser('id') actorId: string,
    @Args('modifyDiscountItemsInput') input: ModifyDiscountItemsInput,
  ) {
    return this.discountService.removeFromDiscount(input, actorId);
  }

  @RequirePermission('promotion.manage')
  @Mutation(() => Discount)
  removeDiscount(@ActiveUser('id') actorId: string, @Args('id', { type: () => ID }) id: string) {
    return this.discountService.deleteDiscount(id, actorId);
  }
}
