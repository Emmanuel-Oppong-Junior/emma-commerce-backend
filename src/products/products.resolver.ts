import { Args, Info, Mutation, Parent, Query, ResolveField, Resolver } from '@nestjs/graphql';
import { ProductsService } from './products.service';
import { Product } from './entities/product.entity';
import { CreateProductInput } from './dto/create-product.input';
import { UpdateProductInput } from './dto/update-product.input';
import { ProductFilterArgs } from './dto/product-filter.args';
import { ProductSortArgs } from './dto/product-sort.args';
import { ProductConnection } from './entities/product-connection.entity';
import { ActiveUser } from '../iam/authentication/decorators/active-user.decorator';
import { DiscountService } from '../discount/discount.service';
import { Discount } from '../discount/entities/discount.entity';
import { PaginationArgs } from '../commons/dto/paginate.args';
import { GraphQLResolveInfo } from 'graphql/type';
import { extractRequestedFieldsFromQuery } from '../commons/useful-functions';
import { Auth } from '../iam/authentication/decorators/auth.decorator';
import { AuthType } from '../iam/authentication/enums/auth-type.enum';
import { DiscountLoader } from './loaders/discount.loader';
import { VariantsLoader } from './loaders/variants.loader';
import { ReviewsLoader } from './loaders/reviews.loader';
import { Variant } from '../variant/entities/variant.entity';
import { Review } from '../review/entities/review.entity';
import { MoneyObject } from '../commons/money/money.object';
import { RequirePermission, RequireStepUp, StepUpCondition } from '../iam/authorization/policy.decorators';

const CHANGES_BASE_PRICE: StepUpCondition = {
  label: 'updateProductInput.basePrice is set',
  applies: (args) => (args.updateProductInput as { basePrice?: unknown } | undefined)?.basePrice != null,
};

// Field resolvers and nested product lists must never be loaded through the Prisma select.
const RESOLVED_FIELDS = ['discountedPrice', 'appliedDiscount', 'variants', 'reviews', 'products'];
// Decimal columns served as Money: the GraphQL sub-selection { amount currency } is not part of the Prisma select.
const MONEY_COLUMNS = ['price', 'basePrice', 'currentPrice'];

const connectionSelect = (info?: GraphQLResolveInfo) =>
  extractRequestedFieldsFromQuery(info!, {
    excludedFields: ['edges', 'cursor', 'node', ...RESOLVED_FIELDS],
    scalarFields: MONEY_COLUMNS,
    level: 3,
  });

const productSelect = (info?: GraphQLResolveInfo) =>
  extractRequestedFieldsFromQuery(info!, { excludedFields: [...RESOLVED_FIELDS], scalarFields: MONEY_COLUMNS });

@Resolver(() => Product)
export class ProductsResolver {
  constructor(
    private readonly productsService: ProductsService,
    private readonly discountService: DiscountService,
    private readonly discountLoader: DiscountLoader,
    private readonly variantsLoader: VariantsLoader,
    private readonly reviewsLoader: ReviewsLoader,
  ) {}

  @RequirePermission('catalog.product.write')
  @Mutation(() => Product)
  createProduct(
    @ActiveUser('id') actorId: string,
    @Args('createProductInput', { type: () => CreateProductInput })
    createProductInput: CreateProductInput,
  ) {
    return this.productsService.create(createProductInput, actorId);
  }

  @RequirePermission('catalog.product.write')
  @RequireStepUp(CHANGES_BASE_PRICE)
  @Mutation(() => Product)
  updateProduct(
    @ActiveUser('id') actorId: string,
    @Args('productId', { type: () => String }) productId: string,
    @Args('updateProductInput', { type: () => UpdateProductInput })
    updateProductInput: UpdateProductInput,
  ) {
    return this.productsService.update(productId, updateProductInput, actorId);
  }

  @RequirePermission('catalog.product.write')
  @Mutation(() => Product)
  permanentlyDeleteProduct(
    @ActiveUser('id') actorId: string,
    @Args('productId', { type: () => String }) productId: string,
  ) {
    return this.productsService.remove(productId, actorId);
  }

  @RequirePermission('catalog.product.write')
  @Mutation(() => Product)
  archiveProduct(@ActiveUser('id') actorId: string, @Args('productId', { type: () => String }) productId: string) {
    return this.productsService.archiveProduct(productId, actorId);
  }

  @RequirePermission('catalog.product.write')
  @Mutation(() => Product)
  restoreProduct(@ActiveUser('id') actorId: string, @Args('productId', { type: () => String }) productId: string) {
    return this.productsService.restoreProduct(productId, actorId);
  }

  @RequirePermission('catalog.product.write')
  @Mutation(() => Product, { name: 'addTagToProduct' })
  async addTagToProduct(
    @ActiveUser('id') actorId: string,
    @Args('productId', { type: () => String }) productId: string,
    @Args('tagId', { type: () => String }) tagId: string,
  ) {
    return this.productsService.addTagToProduct(productId, tagId, actorId);
  }

  @RequirePermission('catalog.product.write')
  @Mutation(() => Product, { name: 'removeTagFromProduct' })
  async removeTagFromProduct(
    @ActiveUser('id') actorId: string,
    @Args('productId', { type: () => String }) productId: string,
    @Args('tagId', { type: () => String }) tagId: string,
  ) {
    return this.productsService.removeTagFromProduct(productId, tagId, actorId);
  }

  @Auth(AuthType.None)
  @Query(() => ProductConnection, {
    name: 'products',
    description: 'Public catalogue: only active, PUBLISHED products, whatever filter is sent',
  })
  findAll(
    @Args('paginationArgs', { type: () => PaginationArgs, nullable: true })
    paginationArgs: PaginationArgs = { first: 10 },
    @Args('filterArgs', { type: () => ProductFilterArgs, nullable: true })
    filterArgs: ProductFilterArgs = {},
    @Args('sortArgs', { type: () => ProductSortArgs, nullable: true })
    sortArgs: ProductSortArgs = {},
    @Info() requestInfo?: GraphQLResolveInfo,
  ) {
    return this.productsService.findAllPublished(paginationArgs, filterArgs, sortArgs, connectionSelect(requestInfo));
  }

  @Auth(AuthType.None)
  @Query(() => Product, {
    name: 'product',
    nullable: true,
    description: 'Public catalogue: null unless the product is active and PUBLISHED',
  })
  findOne(@Args('productId', { type: () => String }) productId: string, @Info() requestInfo?: GraphQLResolveInfo) {
    return this.productsService.findPublishedById(productId, productSelect(requestInfo));
  }

  @RequirePermission('catalog.product.read')
  @Query(() => ProductConnection, {
    name: 'adminProducts',
    description: 'Admin: all products in any status, including DRAFT, ARCHIVED and inactive',
  })
  adminFindAll(
    @Args('paginationArgs', { type: () => PaginationArgs, nullable: true })
    paginationArgs: PaginationArgs = { first: 10 },
    @Args('filterArgs', { type: () => ProductFilterArgs, nullable: true })
    filterArgs: ProductFilterArgs = {},
    @Args('sortArgs', { type: () => ProductSortArgs, nullable: true })
    sortArgs: ProductSortArgs = {},
    @Info() requestInfo?: GraphQLResolveInfo,
  ) {
    return this.productsService.findAll(paginationArgs, filterArgs, sortArgs, connectionSelect(requestInfo));
  }

  @RequirePermission('catalog.product.read')
  @Query(() => Product, {
    name: 'adminProduct',
    nullable: true,
    description: 'Admin: a product in any status',
  })
  adminFindOne(@Args('productId', { type: () => String }) productId: string, @Info() requestInfo?: GraphQLResolveInfo) {
    return this.productsService.findOne(productId, productSelect(requestInfo));
  }

  @ResolveField(() => [Variant], { nullable: true })
  async variants(@Parent() product: Product) {
    return this.variantsLoader.loader.load(product.id);
  }

  @ResolveField(() => [Review], { nullable: true })
  async reviews(@Parent() product: Product) {
    return this.reviewsLoader.loader.load(product.id);
  }

  @ResolveField(() => MoneyObject, { nullable: true })
  async discountedPrice(@Parent() product: Product) {
    const { discountedPrice, discountAmount } = await this.discountLoader.loader.load(product.id);
    return discountAmount.isZero() ? null : discountedPrice;
  }

  @ResolveField(() => Discount, { nullable: true })
  async appliedDiscount(@Parent() product: Product) {
    const { discountId } = await this.discountLoader.loader.load(product.id);
    return discountId ? this.discountService.findOneDiscount(discountId) : null;
  }
}
