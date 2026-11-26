import { Args, Query, Resolver } from '@nestjs/graphql';
import { SlugEntityType } from '../generated/prisma/client';
import { Auth } from '../iam/authentication/decorators/auth.decorator';
import { AuthType } from '../iam/authentication/enums/auth-type.enum';
import { SlugResolution } from './entities/slug-resolution.entity';
import { SlugResolutionService } from './slug-resolution.service';

@Resolver(() => SlugResolution)
export class SlugResolutionResolver {
  constructor(private readonly slugResolution: SlugResolutionService) {}

  @Auth(AuthType.Optional)
  @Query(() => SlugResolution, {
    nullable: true,
    description:
      'Where a product, category, sub-category, brand or collection slug leads: the current slug, or the entity an old ' +
      'slug belonged to (redirected: true, answer with a 301 to its slug); null when unknown or not visible to customers',
  })
  resolveSlug(
    @Args('type', { type: () => SlugEntityType }) type: SlugEntityType,
    @Args('slug', { type: () => String }) slug: string,
  ) {
    return this.slugResolution.resolve(type, slug);
  }
}
