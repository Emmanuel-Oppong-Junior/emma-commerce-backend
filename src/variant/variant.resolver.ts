import { Args, Mutation, Query, Resolver } from '@nestjs/graphql';
import { VariantService } from './variant.service';
import { Variant } from './entities/variant.entity';
import { ActiveUser } from '../iam/authentication/decorators/active-user.decorator';
import { CreateVariantInput } from './dto/create-variant.input';
import { UpdateVariantInput } from './dto/update-variant.input';
import { Auth } from '../iam/authentication/decorators/auth.decorator';
import { AuthType } from '../iam/authentication/enums/auth-type.enum';
import { RequirePermission } from '../iam/authorization/policy.decorators';

@Resolver(() => Variant)
export class VariantResolver {
  constructor(private readonly variantService: VariantService) {}

  @Auth(AuthType.Bearer)
  @Query(() => Variant, {
    name: 'variant',
    description: 'Retrieves a specific variant by ID',
  })
  async getVariant(@Args('variantId', { type: () => String }) variantId: string) {
    return this.variantService.getVariant(variantId);
  }

  @Auth(AuthType.Bearer)
  @Query(() => [Variant], {
    name: 'productVariants',
    description: 'Retrieves all variants for a product',
  })
  async getProductVariants(@Args('productId', { type: () => String }) productId: string) {
    return this.variantService.getProductVariants(productId);
  }

  @Auth(AuthType.Bearer)
  @Query(() => [Variant], {
    name: 'variants',
    description: 'Retrieves all variants (admin only)',
  })
  async getAllVariants() {
    return this.variantService.getAllVariants();
  }

  @RequirePermission('catalog.product.write')
  @Mutation(() => Variant, {
    name: 'createVariant',
    description: 'Creates a new variant for a product',
  })
  async createVariant(@ActiveUser('id') actorId: string, @Args('input') input: CreateVariantInput) {
    return this.variantService.createVariant(input, actorId);
  }

  @RequirePermission('catalog.product.write')
  @Mutation(() => Variant, {
    name: 'updateVariant',
    description: 'Updates an existing variant',
  })
  async updateVariant(@ActiveUser('id') actorId: string, @Args('input') input: UpdateVariantInput) {
    return this.variantService.updateVariant(input.id, input, actorId);
  }

  @RequirePermission('catalog.product.write')
  @Mutation(() => Variant, {
    name: 'deleteVariant',
    description: 'Deletes a variant',
  })
  async deleteVariant(@ActiveUser('id') actorId: string, @Args('variantId', { type: () => String }) variantId: string) {
    return this.variantService.deleteVariant(variantId, actorId);
  }
}
