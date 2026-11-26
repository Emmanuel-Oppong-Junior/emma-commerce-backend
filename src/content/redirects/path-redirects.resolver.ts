import { Args, ID, Mutation, Query, Resolver } from '@nestjs/graphql';
import { Auth } from '../../iam/authentication/decorators/auth.decorator';
import { AuthType } from '../../iam/authentication/enums/auth-type.enum';
import { ActiveUser } from '../../iam/authentication/decorators/active-user.decorator';
import { RequirePermission } from '../../iam/authorization/policy.decorators';
import { PathRedirectsService } from './path-redirects.service';
import { CreatePathRedirectInput, PathRedirect, PathResolution } from './path-redirect.entities';

@Resolver(() => PathRedirect)
export class PathRedirectsResolver {
  constructor(private readonly pathRedirectsService: PathRedirectsService) {}

  @Auth(AuthType.Optional)
  @Query(() => PathResolution, {
    nullable: true,
    description:
      'Where a storefront path redirects to (query and trailing "/" ignored), following up to 10 redirects; null ' +
      'when no redirect starts there',
  })
  resolvePath(@Args('path', { type: () => String }) path: string) {
    return this.pathRedirectsService.resolve(path);
  }

  @RequirePermission('content.view')
  @Query(() => [PathRedirect], { description: 'Admin: every path redirect, by fromPath' })
  pathRedirects() {
    return this.pathRedirectsService.findAll();
  }

  @RequirePermission('content.manage')
  @Mutation(() => PathRedirect, {
    description:
      'Admin: add a path redirect (audited). BAD_REQUEST for a path that is not internal; CONFLICT when fromPath ' +
      'already redirects, or with reason REDIRECT_LOOP when it would make a loop',
  })
  createPathRedirect(@ActiveUser('id') actorId: string, @Args('input') input: CreatePathRedirectInput) {
    return this.pathRedirectsService.create(input, actorId);
  }

  @RequirePermission('content.manage')
  @Mutation(() => PathRedirect, { description: 'Admin: remove a path redirect (audited)' })
  deletePathRedirect(@ActiveUser('id') actorId: string, @Args('id', { type: () => ID }) id: string) {
    return this.pathRedirectsService.remove(id, actorId);
  }
}
