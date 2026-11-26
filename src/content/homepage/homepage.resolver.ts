import { Args, ID, Mutation, Query, Resolver } from '@nestjs/graphql';
import { Auth } from '../../iam/authentication/decorators/auth.decorator';
import { AuthType } from '../../iam/authentication/enums/auth-type.enum';
import { ActiveUser } from '../../iam/authentication/decorators/active-user.decorator';
import { RequirePermission } from '../../iam/authorization/policy.decorators';
import { HomepageService } from './homepage.service';
import {
  CreateHomepageSectionInput,
  HomepageBlock,
  HomepageSection,
  UpdateHomepageSectionInput,
} from './homepage.entities';

@Resolver(() => HomepageSection)
export class HomepageResolver {
  constructor(private readonly homepageService: HomepageService) {}

  @Auth(AuthType.Optional)
  @Query(() => [HomepageBlock], {
    description:
      'The storefront homepage: live sections by position (at most 20) with their items resolved; sections with ' +
      'nothing visible to show are left out',
  })
  homepage() {
    return this.homepageService.homepage();
  }

  @RequirePermission('content.view')
  @Query(() => [HomepageSection], { description: 'Admin: every homepage section, live or not, by position' })
  homepageSections() {
    return this.homepageService.findAll();
  }

  @RequirePermission('content.manage')
  @Mutation(() => HomepageSection, {
    description: 'Admin: add a homepage section (audited); BAD_REQUEST when the config does not fit the type',
  })
  createHomepageSection(@ActiveUser('id') actorId: string, @Args('input') input: CreateHomepageSectionInput) {
    return this.homepageService.create(input, actorId);
  }

  @RequirePermission('content.manage')
  @Mutation(() => HomepageSection, {
    description: 'Admin: change a homepage section (audited); a config given replaces the whole config',
  })
  updateHomepageSection(
    @ActiveUser('id') actorId: string,
    @Args('id', { type: () => ID }) id: string,
    @Args('input') input: UpdateHomepageSectionInput,
  ) {
    return this.homepageService.update(id, input, actorId);
  }

  @RequirePermission('content.manage')
  @Mutation(() => HomepageSection, { description: 'Admin: delete a homepage section (audited)' })
  deleteHomepageSection(@ActiveUser('id') actorId: string, @Args('id', { type: () => ID }) id: string) {
    return this.homepageService.remove(id, actorId);
  }
}
