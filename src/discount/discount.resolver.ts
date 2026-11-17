import { Args, ID, Mutation, Query, Resolver } from '@nestjs/graphql';
import { DiscountService } from './discount.service';
import { Discount } from './entities/discount.entity';
import { CreateDiscountInput } from './dto/create-discount.input';
import { UpdateDiscountInput } from './dto/update-discount.input';
import { ModifyDiscountItemsInput } from './dto/modify-discount-items.input';
import { ActiveUser } from '../iam/authentication/decorators/active-user.decorator';
import { Roles } from '../iam/authentication/decorators/roles.decorator';
import { Role } from '@prisma/client';

@Resolver(() => Discount)
export class DiscountResolver {
  constructor(private readonly discountService: DiscountService) {}

  @Roles(Role.ADMIN, Role.SUPER_ADMIN)
  @Mutation(() => Discount)
  createDiscount(
    @ActiveUser('id') actorId: string,
    @Args('createDiscountInput') createDiscountInput: CreateDiscountInput,
  ) {
    return this.discountService.createDiscount(createDiscountInput, actorId);
  }

  @Roles(Role.ADMIN, Role.SUPER_ADMIN)
  @Query(() => [Discount], { name: 'discounts' })
  findAll() {
    return this.discountService.findAllDiscounts();
  }

  @Roles(Role.ADMIN, Role.SUPER_ADMIN)
  @Query(() => Discount, { name: 'discount' })
  findOne(@Args('id', { type: () => ID }) id: string) {
    return this.discountService.findOneDiscount(id);
  }

  @Roles(Role.ADMIN, Role.SUPER_ADMIN)
  @Mutation(() => Discount)
  updateDiscount(
    @ActiveUser('id') actorId: string,
    @Args('updateDiscountInput') updateDiscountInput: UpdateDiscountInput,
  ) {
    return this.discountService.updateDiscount(updateDiscountInput.id, updateDiscountInput, actorId);
  }

  @Roles(Role.ADMIN, Role.SUPER_ADMIN)
  @Mutation(() => Discount)
  addToDiscount(@ActiveUser('id') actorId: string, @Args('modifyDiscountItemsInput') input: ModifyDiscountItemsInput) {
    return this.discountService.addToDiscount(input, actorId);
  }

  @Roles(Role.ADMIN, Role.SUPER_ADMIN)
  @Mutation(() => Discount)
  removeFromDiscount(
    @ActiveUser('id') actorId: string,
    @Args('modifyDiscountItemsInput') input: ModifyDiscountItemsInput,
  ) {
    return this.discountService.removeFromDiscount(input, actorId);
  }

  @Roles(Role.ADMIN, Role.SUPER_ADMIN)
  @Mutation(() => Discount)
  removeDiscount(@ActiveUser('id') actorId: string, @Args('id', { type: () => ID }) id: string) {
    return this.discountService.deleteDiscount(id, actorId);
  }
}
