import {
  Args,
  Field,
  GraphQLISODateTime,
  ID,
  Int,
  Mutation,
  ObjectType,
  Parent,
  Query,
  ResolveField,
  Resolver,
} from '@nestjs/graphql';
import { Auth } from '../iam/authentication/decorators/auth.decorator';
import { AuthType } from '../iam/authentication/enums/auth-type.enum';
import { ActiveUser } from '../iam/authentication/decorators/active-user.decorator';
import { Variant } from '../variant/entities/variant.entity';
import { notSellableReason } from '../variant/sellable';
import { Cart } from './entities/cart.entity';
import { SavedItemsService, SavedItemWithVariant } from './saved-items.service';

@ObjectType({ description: 'A variant saved for later, out of the cart' })
export class SavedCartItem {
  @Field(() => ID)
  id: string;

  @Field(() => ID)
  variantId: string;

  @Field(() => Variant)
  variant: Variant;

  @Field(() => Int)
  quantity: number;

  @Field(() => GraphQLISODateTime)
  createdAt: Date;
}

@Auth(AuthType.Bearer)
@Resolver(() => SavedCartItem)
export class SavedItemsResolver {
  constructor(private readonly saved: SavedItemsService) {}

  @Query(() => [SavedCartItem], { description: 'Your items saved for later, newest first (at most 100)' })
  savedItems(@ActiveUser('id') userId: string) {
    return this.saved.list(userId);
  }

  @Mutation(() => Cart, {
    description:
      'Move a cart line to "saved for later" (its quantity adds to the variant if already saved); returns the cart. ' +
      'CONFLICT with reason SAVED_ITEMS_LIMIT_REACHED at 100 saved variants',
  })
  saveCartItemForLater(@ActiveUser('id') userId: string, @Args('cartItemId', { type: () => ID }) cartItemId: string) {
    return this.saved.saveForLater(userId, cartItemId);
  }

  @Mutation(() => Cart, {
    description:
      'Move a saved item back to the cart with its quantity; returns the cart. BAD_REQUEST with reason ' +
      'SAVED_ITEM_UNAVAILABLE when it is no longer on sale (it stays saved), or the cart stock refusal',
  })
  moveSavedItemToCart(@ActiveUser('id') userId: string, @Args('savedItemId', { type: () => ID }) savedItemId: string) {
    return this.saved.moveToCart(userId, savedItemId);
  }

  @Mutation(() => Boolean, { description: 'Delete a saved item' })
  removeSavedItem(@ActiveUser('id') userId: string, @Args('savedItemId', { type: () => ID }) savedItemId: string) {
    return this.saved.remove(userId, savedItemId);
  }

  @ResolveField(() => Boolean, { description: 'Whether it can go back in the cart (on sale; stock is checked then)' })
  available(@Parent() item: SavedItemWithVariant): boolean {
    return notSellableReason(item.variant) === null;
  }

  @ResolveField(() => String, { nullable: true, description: 'Why it cannot go back in the cart' })
  unavailableReason(@Parent() item: SavedItemWithVariant): string | null {
    return notSellableReason(item.variant);
  }
}
