import { Args, ID, Mutation, Query, Resolver } from '@nestjs/graphql';
import { DiscountService } from './discount.service';
import { Discount } from './entities/discount.entity';
import { CreateDiscountInput } from './dto/create-discount.input';
import { UpdateDiscountInput } from './dto/update-discount.input';
import { ModifyDiscountItemsInput } from './dto/modify-discount-items.input';
import { Roles } from 'src/iam/authentication/decorators/roles.decorator';
import { Role } from '@prisma/client';

@Resolver(() => Discount)
export class DiscountResolver {
  constructor(private readonly discountService: DiscountService) {}

  @Roles(Role.ADMIN, Role.SUPER_ADMIN)
  @Mutation(() => Discount)
  createDiscount(@Args('createDiscountInput') createDiscountInput: CreateDiscountInput) {
    return this.discountService.createDiscount(createDiscountInput);
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
  updateDiscount(@Args('updateDiscountInput') updateDiscountInput: UpdateDiscountInput) {
    return this.discountService.updateDiscount(updateDiscountInput.id, updateDiscountInput);
  }

  @Roles(Role.ADMIN, Role.SUPER_ADMIN)
  @Mutation(() => Discount)
  addToDiscount(@Args('modifyDiscountItemsInput') input: ModifyDiscountItemsInput) {
    return this.discountService.addToDiscount(input);
  }

  @Roles(Role.ADMIN, Role.SUPER_ADMIN)
  @Mutation(() => Discount)
  removeFromDiscount(@Args('modifyDiscountItemsInput') input: ModifyDiscountItemsInput) {
    return this.discountService.removeFromDiscount(input);
  }

  @Roles(Role.ADMIN, Role.SUPER_ADMIN)
  @Mutation(() => Discount)
  removeDiscount(@Args('id', { type: () => ID }) id: string) {
    return this.discountService.deleteDiscount(id);
  }
}
