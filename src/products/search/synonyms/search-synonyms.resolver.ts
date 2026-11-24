import { Args, ID, Mutation, Query, Resolver } from '@nestjs/graphql';
import { RequirePermission } from '../../../iam/authorization/policy.decorators';
import { ActiveUser } from '../../../iam/authentication/decorators/active-user.decorator';
import { SearchSynonym, SearchSynonymInput } from './search-synonym.entity';
import { SearchSynonymsService } from './search-synonyms.service';

// Synonyms are catalogue vocabulary like tags, so they share the taxonomy permission.
@Resolver(() => SearchSynonym)
export class SearchSynonymsResolver {
  constructor(private readonly synonyms: SearchSynonymsService) {}

  @RequirePermission('catalog.product.read')
  @Query(() => [SearchSynonym], { description: 'Every search synonym group, oldest first (P6-S.4)' })
  searchSynonyms() {
    return this.synonyms.findAll();
  }

  @RequirePermission('catalog.taxonomy.write')
  @Mutation(() => SearchSynonym, { description: 'Adds a search synonym group (at most 500); audited' })
  createSearchSynonym(
    @ActiveUser('id') actorId: string,
    @Args('input', { type: () => SearchSynonymInput }) input: SearchSynonymInput,
  ) {
    return this.synonyms.create(input, actorId);
  }

  @RequirePermission('catalog.taxonomy.write')
  @Mutation(() => SearchSynonym, { description: 'Replaces a search synonym group; audited' })
  updateSearchSynonym(
    @ActiveUser('id') actorId: string,
    @Args('id', { type: () => ID }) id: string,
    @Args('input', { type: () => SearchSynonymInput }) input: SearchSynonymInput,
  ) {
    return this.synonyms.update(id, input, actorId);
  }

  @RequirePermission('catalog.taxonomy.write')
  @Mutation(() => SearchSynonym, { description: 'Removes a search synonym group; audited' })
  deleteSearchSynonym(@ActiveUser('id') actorId: string, @Args('id', { type: () => ID }) id: string) {
    return this.synonyms.remove(id, actorId);
  }
}
