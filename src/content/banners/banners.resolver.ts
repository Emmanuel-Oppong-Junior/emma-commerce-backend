import { Args, ID, Mutation, Query, Resolver } from '@nestjs/graphql';
import { Auth } from '../../iam/authentication/decorators/auth.decorator';
import { AuthType } from '../../iam/authentication/enums/auth-type.enum';
import { ActiveUser } from '../../iam/authentication/decorators/active-user.decorator';
import { RequirePermission } from '../../iam/authorization/policy.decorators';
import { BannersService } from './banners.service';
import { Banner, CreateBannerInput, UpdateBannerInput } from './banner.entities';

@Resolver(() => Banner)
export class BannersResolver {
  constructor(private readonly bannersService: BannersService) {}

  @Auth(AuthType.Optional)
  @Query(() => [Banner], {
    description: 'The live banners of a storefront placement (e.g. HOME_HERO) by position, at most 20',
  })
  banners(@Args('placement', { type: () => String }) placement: string) {
    return this.bannersService.findLive(placement);
  }

  @RequirePermission('content.view')
  @Query(() => [Banner], { description: 'Admin: every banner, live or not, optionally of one placement' })
  adminBanners(@Args('placement', { type: () => String, nullable: true }) placement?: string) {
    return this.bannersService.findAll(placement ?? undefined);
  }

  @RequirePermission('content.manage')
  @Mutation(() => Banner, { description: 'Admin: create a banner (audited)' })
  createBanner(@ActiveUser('id') actorId: string, @Args('input') input: CreateBannerInput) {
    return this.bannersService.create(input, actorId);
  }

  @RequirePermission('content.manage')
  @Mutation(() => Banner, { description: 'Admin: change a banner (audited); link: null removes its link' })
  updateBanner(
    @ActiveUser('id') actorId: string,
    @Args('id', { type: () => ID }) id: string,
    @Args('input') input: UpdateBannerInput,
  ) {
    return this.bannersService.update(id, input, actorId);
  }

  @RequirePermission('content.manage')
  @Mutation(() => Banner, { description: 'Admin: delete a banner (audited)' })
  deleteBanner(@ActiveUser('id') actorId: string, @Args('id', { type: () => ID }) id: string) {
    return this.bannersService.remove(id, actorId);
  }
}
