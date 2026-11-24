import { Args, ID, Mutation, Query, Resolver } from '@nestjs/graphql';
import { ProductType } from './entities/product-type.entity';
import { ProductTypesService } from './product-types.service';
import { CreateProductTypeInput, ProductTypeReturnPolicyInput, UpdateProductTypeInput } from './dto/product-type.input';
import { AttributeDefinitionInput, UpdateAttributeDefinitionInput } from './dto/attribute-definition.input';
import { ActiveUser } from '../iam/authentication/decorators/active-user.decorator';
import { Auth } from '../iam/authentication/decorators/auth.decorator';
import { AuthType } from '../iam/authentication/enums/auth-type.enum';
import { RequirePermission } from '../iam/authorization/policy.decorators';

@Resolver(() => ProductType)
export class ProductTypesResolver {
  constructor(private readonly productTypesService: ProductTypesService) {}

  @Auth(AuthType.None)
  @Query(() => [ProductType], { description: 'Product types and their attribute definitions, by name' })
  productTypes() {
    return this.productTypesService.findAll();
  }

  @Auth(AuthType.None)
  @Query(() => ProductType, { description: 'A product type and its attribute definitions' })
  productType(@Args('id', { type: () => ID }) id: string) {
    return this.productTypesService.findOne(id);
  }

  @RequirePermission('catalog.taxonomy.write')
  @Mutation(() => ProductType, { description: 'Creates a product type, optionally with its attributes (admin only)' })
  createProductType(@ActiveUser('id') actorId: string, @Args('input') input: CreateProductTypeInput) {
    return this.productTypesService.create(input, actorId);
  }

  @RequirePermission('catalog.taxonomy.write')
  @Mutation(() => ProductType, { description: 'Renames or redescribes a product type; system types are read-only' })
  updateProductType(
    @ActiveUser('id') actorId: string,
    @Args('id', { type: () => ID }) id: string,
    @Args('input') input: UpdateProductTypeInput,
  ) {
    return this.productTypesService.update(id, input, actorId);
  }

  @RequirePermission('catalog.taxonomy.write')
  @Mutation(() => ProductType, {
    description: "Sets whether a product type's products can be returned and its return window (system types too)",
  })
  setProductTypeReturnPolicy(
    @ActiveUser('id') actorId: string,
    @Args('id', { type: () => ID }) id: string,
    @Args('input') input: ProductTypeReturnPolicyInput,
  ) {
    return this.productTypesService.setReturnPolicy(id, input, actorId);
  }

  @RequirePermission('catalog.taxonomy.write')
  @Mutation(() => ProductType, { description: 'Deletes a product type no product uses; system types are read-only' })
  deleteProductType(@ActiveUser('id') actorId: string, @Args('id', { type: () => ID }) id: string) {
    return this.productTypesService.delete(id, actorId);
  }

  @RequirePermission('catalog.taxonomy.write')
  @Mutation(() => ProductType, {
    description: 'Adds an attribute definition; a type that products use only takes optional ones',
  })
  addAttributeDefinition(
    @ActiveUser('id') actorId: string,
    @Args('productTypeId', { type: () => ID }) productTypeId: string,
    @Args('input') input: AttributeDefinitionInput,
  ) {
    return this.productTypesService.addAttribute(productTypeId, input, actorId);
  }

  @RequirePermission('catalog.taxonomy.write')
  @Mutation(() => ProductType, {
    description:
      'Changes an attribute definition; making it required, changing its unit or narrowing its allowed values needs a type no product uses',
  })
  updateAttributeDefinition(
    @ActiveUser('id') actorId: string,
    @Args('attributeId', { type: () => ID }) attributeId: string,
    @Args('input') input: UpdateAttributeDefinitionInput,
  ) {
    return this.productTypesService.updateAttribute(attributeId, input, actorId);
  }

  @RequirePermission('catalog.taxonomy.write')
  @Mutation(() => ProductType, { description: 'Removes an attribute definition from a type no product uses' })
  removeAttributeDefinition(
    @ActiveUser('id') actorId: string,
    @Args('attributeId', { type: () => ID }) attributeId: string,
  ) {
    return this.productTypesService.removeAttribute(attributeId, actorId);
  }
}
