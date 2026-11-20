import { Args, Info, Mutation, Query, Resolver } from '@nestjs/graphql';
import { BrandService } from './brand.service';
import { CreateBrandInput } from './dto/create-brand.input';
import { UpdateBrandInput } from './dto/update-brand.input';
import { Brand } from './entities/brand.entity';
import { GraphQLResolveInfo } from 'graphql/type';
import { extractRequestedFieldsFromQuery } from '../commons/useful-functions';
import { AuthType } from '../iam/authentication/enums/auth-type.enum';
import { Auth } from '../iam/authentication/decorators/auth.decorator';
import { RequirePermission } from '../iam/authorization/policy.decorators';

@Resolver(() => Brand)
export class BrandResolver {
  constructor(private readonly brandService: BrandService) {}

  @RequirePermission('catalog.taxonomy.write')
  @Mutation(() => Brand)
  async createBrand(@Args('input') input: CreateBrandInput) {
    return this.brandService.createBrand(input);
  }

  @RequirePermission('catalog.taxonomy.write')
  @Mutation(() => Brand)
  async updateBrand(@Args('id') id: string, @Args('input') input: UpdateBrandInput) {
    return this.brandService.updateBrand(id, input);
  }

  @RequirePermission('catalog.taxonomy.write')
  @Mutation(() => Brand)
  async deleteBrand(@Args('id') id: string) {
    return this.brandService.deleteBrand(id);
  }

  @Auth(AuthType.None)
  @Query(() => Brand, { nullable: true })
  async brand(@Args('id') id: string) {
    return this.brandService.getBrandById(id);
  }

  @Auth(AuthType.None)
  @Query(() => [Brand], { nullable: 'itemsAndList' })
  async brands(@Info() requestInfo?: GraphQLResolveInfo) {
    const requestedFields = extractRequestedFieldsFromQuery(requestInfo!, {
      // products is resolved by BrandProductsResolver (published only, capped), never via this select.
      excludedFields: ['products'],
      level: 1,
    });
    return this.brandService.getAllBrands(requestedFields);
  }
}
