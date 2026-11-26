import { Args, ID, Info, Mutation, Parent, Query, ResolveField, Resolver } from '@nestjs/graphql';
import { GraphQLResolveInfo } from 'graphql';
import { Prisma, Collection as CollectionRow } from '../../generated/prisma/client';
import { Auth } from '../../iam/authentication/decorators/auth.decorator';
import { AuthType } from '../../iam/authentication/enums/auth-type.enum';
import { ActiveUser } from '../../iam/authentication/decorators/active-user.decorator';
import { RequirePermission } from '../../iam/authorization/policy.decorators';
import { staffWith } from '../../iam/authorization/staff-permission.field-middleware';
import { PaginationArgs } from '../../commons/dto/paginate.args';
import { ProductSortArgs } from '../../products/dto/product-sort.args';
import { ProductConnection } from '../../products/entities/product-connection.entity';
import { connectionSelect } from '../../products/products.resolver';
import { CollectionsService } from './collections.service';
import { Collection, CollectionRules } from './entities/collection.entity';
import { CreateCollectionInput, UpdateCollectionInput } from './dto/collection.input';
import { CollectionRules as StoredRules } from './collection-rules';

@Resolver(() => Collection)
export class CollectionsResolver {
  constructor(private readonly collectionsService: CollectionsService) {}

  @Auth(AuthType.Optional)
  @Query(() => Collection, {
    nullable: true,
    description: 'The live collection with this current slug, else null (an old slug: resolveSlug)',
  })
  collection(@Args('slug', { type: () => String }) slug: string) {
    return this.collectionsService.findLiveBySlug(slug);
  }

  @Auth(AuthType.Optional)
  @Query(() => [Collection], { description: 'The live collections by name (at most 100)' })
  collections() {
    return this.collectionsService.findLive();
  }

  @RequirePermission('content.view')
  @Query(() => [Collection], { description: 'Admin: every collection, live or not, by name' })
  adminCollections() {
    return this.collectionsService.findAll();
  }

  @RequirePermission('content.view')
  @Query(() => Collection, { nullable: true, description: 'Admin: a collection, live or not' })
  adminCollection(@Args('id', { type: () => ID }) id: string) {
    return this.collectionsService.findById(id);
  }

  @RequirePermission('content.manage')
  @Mutation(() => Collection, { description: 'Admin: create a collection (audited)' })
  createCollection(@ActiveUser('id') actorId: string, @Args('input') input: CreateCollectionInput) {
    return this.collectionsService.create(input, actorId);
  }

  @RequirePermission('content.manage')
  @Mutation(() => Collection, {
    description: 'Admin: change a collection (audited); a new slug keeps the old one as a redirect',
  })
  updateCollection(
    @ActiveUser('id') actorId: string,
    @Args('id', { type: () => ID }) id: string,
    @Args('input') input: UpdateCollectionInput,
  ) {
    return this.collectionsService.update(id, input, actorId);
  }

  @RequirePermission('content.manage')
  @Mutation(() => Collection, {
    description: 'Admin: replace the products of a manual collection, in this order (at most 500; audited)',
  })
  setCollectionProducts(
    @ActiveUser('id') actorId: string,
    @Args('id', { type: () => ID }) id: string,
    @Args('productIds', { type: () => [ID] }) productIds: string[],
  ) {
    return this.collectionsService.setProducts(id, productIds, actorId);
  }

  @RequirePermission('content.manage')
  @Mutation(() => Collection, {
    description:
      'Admin: delete a collection (audited); banners linking to it lose their link, homepage sections showing it ' +
      'stop showing',
  })
  deleteCollection(@ActiveUser('id') actorId: string, @Args('id', { type: () => ID }) id: string) {
    return this.collectionsService.remove(id, actorId);
  }

  @ResolveField(() => CollectionRules, { nullable: true, description: 'RULE: the product filters; MANUAL: null' })
  rules(@Parent() collection: CollectionRow): CollectionRules | null {
    if (!collection.rules) return null;
    const { priceMin, priceMax, ...rest } = collection.rules as StoredRules;
    return {
      ...rest,
      priceMin: priceMin === undefined ? undefined : new Prisma.Decimal(priceMin),
      priceMax: priceMax === undefined ? undefined : new Prisma.Decimal(priceMax),
    };
  }

  @ResolveField(() => ProductConnection, {
    description:
      'What customers see: the published products, paginated. MANUAL: in the staff order unless sortArgs is given; ' +
      'RULE: matching the rules, newest first unless sortArgs is given',
  })
  products(
    @Parent() collection: CollectionRow,
    @Args('paginationArgs', { type: () => PaginationArgs, nullable: true })
    paginationArgs: PaginationArgs = { first: 12 },
    @Args('sortArgs', { type: () => ProductSortArgs, nullable: true })
    sortArgs: ProductSortArgs = {},
    @Info() info?: GraphQLResolveInfo,
  ) {
    return this.collectionsService.productsPage(collection, paginationArgs, sortArgs, connectionSelect(info));
  }

  @ResolveField(() => [ID], {
    description: 'Staff (content.view): the products of a manual collection in order, in any status; empty for RULE',
    middleware: [staffWith('content.view')],
  })
  productIds(@Parent() collection: CollectionRow) {
    return this.collectionsService.productIds(collection.id);
  }
}
