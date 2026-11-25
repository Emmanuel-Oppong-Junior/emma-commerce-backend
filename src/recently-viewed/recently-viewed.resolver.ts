import { BadRequestException } from '@nestjs/common';
import { Args, ID, Int, Mutation, Query, Resolver } from '@nestjs/graphql';
import { Throttle } from '@nestjs/throttler';
import { ActiveUser } from '../iam/authentication/decorators/active-user.decorator';
import { Auth } from '../iam/authentication/decorators/auth.decorator';
import { AuthType } from '../iam/authentication/enums/auth-type.enum';
import { Product } from '../products/entities/product.entity';
import { RECENTLY_VIEWED_LIMIT, RecentlyViewedService } from './recently-viewed.service';
import { RequireFeature } from '../store-features/require-feature';

/** Recently viewed products of signed-in users (P6-G.3); guests keep theirs on the device. */
@Auth(AuthType.Bearer)
@Resolver()
export class RecentlyViewedResolver {
  constructor(private readonly service: RecentlyViewedService) {}

  @Throttle({ productView: { limit: 60, ttl: 60000 } })
  @RequireFeature('RECENTLY_VIEWED')
  @Mutation(() => Boolean, {
    name: 'recordProductView',
    description: `Records that the caller viewed a public product; the latest ${RECENTLY_VIEWED_LIMIT} distinct products are kept`,
  })
  recordProductView(@ActiveUser('id') userId: string, @Args('productId', { type: () => ID }) productId: string) {
    return this.service.record(userId, productId);
  }

  @Query(() => [Product], {
    name: 'recentlyViewed',
    description: "The caller's recently viewed products that are still on sale, latest first",
  })
  recentlyViewed(
    @ActiveUser('id') userId: string,
    @Args('limit', { type: () => Int, defaultValue: RECENTLY_VIEWED_LIMIT, description: `1-${RECENTLY_VIEWED_LIMIT}` })
    limit: number,
  ) {
    if (!Number.isInteger(limit) || limit < 1 || limit > RECENTLY_VIEWED_LIMIT) {
      throw new BadRequestException(`recentlyViewed(limit: ${limit}) must be between 1 and ${RECENTLY_VIEWED_LIMIT}`);
    }
    return this.service.list(userId, limit);
  }
}
