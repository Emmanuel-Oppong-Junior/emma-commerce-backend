import { Args, ID, Mutation, Query, Resolver } from '@nestjs/graphql';
import { VariantService } from './variant.service';
import { Variant } from './entities/variant.entity';
import { VariantConnection } from './entities/variant-connection.entity';
import { ActiveUser } from '../iam/authentication/decorators/active-user.decorator';
import { CreateVariantInput } from './dto/create-variant.input';
import { UpdateVariantInput } from './dto/update-variant.input';
import { RequirePermission, RequireStepUp, StepUpCondition } from '../iam/authorization/policy.decorators';
import { PaginationArgs } from '../commons/dto/paginate.args';

const CHANGES_PRICE: StepUpCondition = {
  label: 'input.basePrice is set',
  applies: (args) => (args.input as { basePrice?: unknown } | undefined)?.basePrice != null,
};

// Customers see variants only through a published product (Product.variants, active ones); these reads list every
// variant of every product, archived ones included, so they are admin reads (VAR-03).
@Resolver(() => Variant)
export class VariantResolver {
  constructor(private readonly variantService: VariantService) {}

  @RequirePermission('catalog.product.read')
  @Query(() => Variant, { name: 'variant', description: 'Admin: a variant by ID, archived or not' })
  async getVariant(@Args('variantId', { type: () => String }) variantId: string) {
    return this.variantService.getVariant(variantId);
  }

  @RequirePermission('catalog.product.read')
  @Query(() => VariantConnection, {
    name: 'variants',
    description: 'Admin: variants of every product, or of one, archived included, by ID (max 100 per page)',
  })
  async getVariants(
    @Args('paginationArgs', { type: () => PaginationArgs, nullable: true })
    paginationArgs: PaginationArgs = { first: 12 },
    @Args('productId', { type: () => ID, nullable: true }) productId?: string,
  ): Promise<VariantConnection> {
    const page = await this.variantService.getVariants(paginationArgs, productId);
    return {
      edges: page.nodes.map((node) => ({ cursor: node.id, node: node as unknown as Variant })),
      pageInfo: {
        pageSize: page.nodes.length,
        hasNextPage: page.hasNextPage,
        hasPreviousPage: !!paginationArgs.after,
        totalCount: page.totalCount,
      },
    };
  }

  @RequirePermission('catalog.product.write')
  @Mutation(() => Variant, { name: 'createVariant', description: 'Creates a variant (SKU) for a product' })
  async createVariant(@ActiveUser('id') actorId: string, @Args('input') input: CreateVariantInput) {
    return this.variantService.createVariant(input, actorId);
  }

  @RequirePermission('catalog.product.write')
  @RequireStepUp(CHANGES_PRICE)
  @Mutation(() => Variant, { name: 'updateVariant', description: 'Updates a variant; isActive: false archives it' })
  async updateVariant(@ActiveUser('id') actorId: string, @Args('input') input: UpdateVariantInput) {
    return this.variantService.updateVariant(input.id, input, actorId);
  }

  @RequirePermission('catalog.product.write')
  @Mutation(() => Variant, {
    name: 'deleteVariant',
    description: 'Deletes a variant no cart, order or stock movement refers to (CONFLICT otherwise: archive it)',
  })
  async deleteVariant(@ActiveUser('id') actorId: string, @Args('variantId', { type: () => String }) variantId: string) {
    return this.variantService.deleteVariant(variantId, actorId);
  }
}
