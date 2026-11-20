import { Args, Info, Int, Mutation, Parent, Query, ResolveField, Resolver } from '@nestjs/graphql';
import { ProductsService } from './products.service';
import { Product } from './entities/product.entity';
import { CreateProductInput } from './dto/create-product.input';
import { UpdateProductInput } from './dto/update-product.input';
import { ProductFilterArgs } from './dto/product-filter.args';
import { ProductSortArgs } from './dto/product-sort.args';
import { ProductConnection } from './entities/product-connection.entity';
import { ActiveUser } from '../iam/authentication/decorators/active-user.decorator';
import { PaginationArgs } from '../commons/dto/paginate.args';
import { GraphQLResolveInfo } from 'graphql/type';
import { extractRequestedFieldsFromQuery } from '../commons/useful-functions';
import { Auth } from '../iam/authentication/decorators/auth.decorator';
import { AuthType } from '../iam/authentication/enums/auth-type.enum';
import { VariantSummaryLoader } from './loaders/variant-summary.loader';
import { PriceRange } from './entities/price-range.entity';
import { VariantsLoader } from './loaders/variants.loader';
import { ReviewsLoader } from './loaders/reviews.loader';
import { Variant } from '../variant/entities/variant.entity';
import { Review } from '../review/entities/review.entity';
import { RequirePermission, RequireStepUp, StepUpCondition } from '../iam/authorization/policy.decorators';
import { ProductType } from '../product-types/entities/product-type.entity';
import { ProductTypesLoader } from '../product-types/product-types.loader';

// Turning tax on or off reprices every variant of the product.
const CHANGES_PRICES: StepUpCondition = {
  label: 'updateProductInput.isTaxable is set',
  applies: (args) => (args.updateProductInput as { isTaxable?: unknown } | undefined)?.isTaxable != null,
};

// Field resolvers and nested product lists must never be loaded through the Prisma select.
const RESOLVED_FIELDS = ['priceRange', 'totalStock', 'inStock', 'variants', 'reviews', 'products', 'productType'];

const connectionSelect = (info?: GraphQLResolveInfo) =>
  extractRequestedFieldsFromQuery(info!, {
    excludedFields: ['edges', 'cursor', 'node', ...RESOLVED_FIELDS],
    level: 3,
  });

const productSelect = (info?: GraphQLResolveInfo) =>
  extractRequestedFieldsFromQuery(info!, { excludedFields: [...RESOLVED_FIELDS] });

@Resolver(() => Product)
export class ProductsResolver {
  constructor(
    private readonly productsService: ProductsService,
    private readonly variantsLoader: VariantsLoader,
    private readonly variantSummaryLoader: VariantSummaryLoader,
    private readonly reviewsLoader: ReviewsLoader,
    private readonly productTypesLoader: ProductTypesLoader,
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
  @RequireStepUp(CHANGES_PRICES)
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

  @ResolveField(() => PriceRange, {
    nullable: true,
    description: 'Lowest and highest price of the active variants; null when none is priced',
  })
  async priceRange(@Parent() product: Product): Promise<PriceRange | null> {
    const { minPrice, maxPrice } = await this.variantSummaryLoader.loader.load(product.id);
    return minPrice && maxPrice ? { min: minPrice, max: maxPrice } : null;
  }

  @ResolveField(() => Int, { description: 'Units in stock across the active variants' })
  async totalStock(@Parent() product: Product): Promise<number> {
    return (await this.variantSummaryLoader.loader.load(product.id)).totalStock;
  }

  @ResolveField(() => Boolean, { description: 'Whether an active variant has stock' })
  async inStock(@Parent() product: Product): Promise<boolean> {
    return (await this.variantSummaryLoader.loader.load(product.id)).totalStock > 0;
  }

  @ResolveField(() => [Variant], { description: 'The active variants (SKUs): what a customer chooses and buys' })
  async variants(@Parent() product: Product) {
    return this.variantsLoader.loader.load(product.id);
  }

  @ResolveField(() => ProductType)
  async productType(@Parent() product: Product) {
    return this.productTypesLoader.loader.load(product.productTypeId);
  }

  @ResolveField(() => [Review], { nullable: true })
  async reviews(@Parent() product: Product) {
    return this.reviewsLoader.loader.load(product.id);
  }
}
