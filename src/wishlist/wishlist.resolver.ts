import { Args, Mutation, Query, Resolver } from '@nestjs/graphql';
import { WishlistService } from './wishlist.service';
import { Wishlist } from './entities/wishlist.entity';
import { ActiveUser } from '../iam/authentication/decorators/active-user.decorator';
import { Auth } from '../iam/authentication/decorators/auth.decorator';
import { AuthType } from '../iam/authentication/enums/auth-type.enum';
import { RequireFeature } from '../store-features/require-feature';

@Auth(AuthType.Bearer)
@Resolver(() => Wishlist)
export class WishlistResolver {
  constructor(private readonly wishlistService: WishlistService) {}

  @Query(() => Wishlist, {
    name: 'wishlist',
    description: 'Retrieves the user’s wishlist',
  })
  async getWishlist(@ActiveUser('id') userId: string) {
    return this.wishlistService.getOrCreateWishlist(userId);
  }

  @RequireFeature('WISHLIST')
  @Mutation(() => Wishlist, {
    name: 'addToWishlist',
    description: 'Adds a product to the user’s wishlist',
  })
  async addToWishlist(@ActiveUser('id') userId: string, @Args('productId', { type: () => String }) productId: string) {
    return this.wishlistService.addToWishlist(userId, productId);
  }

  @RequireFeature('WISHLIST')
  @Mutation(() => Wishlist, {
    name: 'removeFromWishlist',
    description: 'Removes a product from the user’s wishlist',
  })
  async removeFromWishlist(
    @ActiveUser('id') userId: string,
    @Args('productId', { type: () => String }) productId: string,
  ) {
    return this.wishlistService.removeFromWishlist(userId, productId);
  }

  @RequireFeature('WISHLIST')
  @Mutation(() => Wishlist, {
    name: 'clearWishlist',
    description: 'Clears the user’s wishlist',
  })
  async clearWishlist(@ActiveUser('id') userId: string) {
    return this.wishlistService.clearWishlist(userId);
  }
}
