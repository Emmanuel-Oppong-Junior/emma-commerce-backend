import { Args, Float, Info, Mutation, Parent, Query, ResolveField, Resolver } from '@nestjs/graphql';
import { ProductsService } from './products.service';
import { Product } from './entities/product.entity';
import { CreateProductInput } from './dto/create-product.input';
import { UpdateProductInput } from './dto/update-product.input';
import { ProductFilterArgs } from './dto/product-filter.args';
import { ProductSortArgs } from './dto/product-sort.args';
import { ProductConnection } from './entities/product-connection.entity';
import { Role } from '@prisma/client';
import { Roles } from '../iam/authentication/decorators/roles.decorator';
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

// Field resolvers and nested product lists must never be loaded through the Prisma select.
const RESOLVED_FIELDS = ['discountedPrice', 'appliedDiscount', 'variants', 'reviews', 'products'];

const connectionSelect = (info?: GraphQLResolveInfo) =>
  extractRequestedFieldsFromQuery(info!, { excludedFields: ['edges', 'cursor', 'node', ...RESOLVED_FIELDS], level: 3 });

const productSelect = (info?: GraphQLResolveInfo) =>
  extractRequestedFieldsFromQuery(info!, { excludedFields: [...RESOLVED_FIELDS] });

@Resolver(() => Product)
export class ProductsResolver {
  constructor(
    private readonly productsService: ProductsService,
    private readonly discountService: DiscountService,
    private readonly discountLoader: DiscountLoader,
    private readonly variantsLoader: VariantsLoader,
    private readonly reviewsLoader: ReviewsLoader,
  ) {}

  @Roles(Role.SUPER_ADMIN, Role.ADMIN)
  @Mutation(() => Product)
  createProduct(
    @Args('createProductInput', { type: () => CreateProductInput })
    createProductInput: CreateProductInput,
  ) {
    return this.productsService.create(createProductInput);
  }

  @Roles(Role.SUPER_ADMIN, Role.ADMIN)
  @Mutation(() => Product)
  updateProduct(
    @Args('productId', { type: () => String }) productId: string,
    @Args('updateProductInput', { type: () => UpdateProductInput })
    updateProductInput: UpdateProductInput,
  ) {
    return this.productsService.update(productId, updateProductInput);
  }

  @Roles(Role.SUPER_ADMIN, Role.ADMIN)
  @Mutation(() => Product)
  permanentlyDeleteProduct(@Args('productId', { type: () => String }) productId: string) {
    return this.productsService.remove(productId);
  }

  @Roles(Role.SUPER_ADMIN, Role.ADMIN)
  @Mutation(() => Product)
  archiveProduct(@Args('productId', { type: () => String }) productId: string) {
    return this.productsService.archiveProduct(productId);
  }

  @Roles(Role.SUPER_ADMIN, Role.ADMIN)
  @Mutation(() => Product)
  restoreProduct(@Args('productId', { type: () => String }) productId: string) {
    return this.productsService.restoreProduct(productId);
  }

  @Roles(Role.SUPER_ADMIN, Role.ADMIN)
  @Mutation(() => Product, { name: 'addTagToProduct' })
  async addTagToProduct(
    @Args('productId', { type: () => String }) productId: string,
    @Args('tagId', { type: () => String }) tagId: string,
  ) {
    return this.productsService.addTagToProduct(productId, tagId);
  }

  @Roles(Role.SUPER_ADMIN, Role.ADMIN)
  @Mutation(() => Product, { name: 'removeTagFromProduct' })
  async removeTagFromProduct(
    @Args('productId', { type: () => String }) productId: string,
    @Args('tagId', { type: () => String }) tagId: string,
  ) {
    return this.productsService.removeTagFromProduct(productId, tagId);
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

  @Roles(Role.SUPER_ADMIN, Role.ADMIN)
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

  @Roles(Role.SUPER_ADMIN, Role.ADMIN)
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

  @ResolveField(() => Float, { nullable: true })
  async discountedPrice(@Parent() product: Product) {
    const { discountedPrice } = await this.discountLoader.loader.load(product.id);
    const originalPrice = Number(product.price);
    return discountedPrice !== originalPrice ? discountedPrice : null;
  }

  @ResolveField(() => Discount, { nullable: true })
  async appliedDiscount(@Parent() product: Product) {
    const { discountId } = await this.discountLoader.loader.load(product.id);
    return discountId ? this.discountService.findOneDiscount(discountId) : null;
  }
}
