import { Args, Mutation, Query, Resolver } from '@nestjs/graphql';
import { SubCategoriesService } from './sub-categories.service';
import { CreateSubCategoryInput } from './dto/create-sub-category.input';
import { UpdateSubCategoryInput } from './dto/update-sub-category.input';

import { SubCategory } from './entities/sub-category.entity';
import { Auth } from '../iam/authentication/decorators/auth.decorator';
import { AuthType } from '../iam/authentication/enums/auth-type.enum';
import { RequirePermission } from '../iam/authorization/policy.decorators';

@Resolver(() => SubCategory)
export class SubCategoriesResolver {
  constructor(private readonly subCategoriesService: SubCategoriesService) {}

  @RequirePermission('catalog.taxonomy.write')
  @Mutation(() => SubCategory, {
    description: 'Creates a new subcategory (admin only)',
  })
  createSubCategory(
    @Args('input', {
      type: () => CreateSubCategoryInput,
      description: 'Input data for the new subcategory',
    })
    input: CreateSubCategoryInput,
  ) {
    return this.subCategoriesService.create(input);
  }

  @Auth(AuthType.Bearer)
  @Query(() => [SubCategory], {
    name: 'subCategories',
    description: 'Retrieves a list of all subcategories, sorted alphabetically by name',
  })
  findAll() {
    return this.subCategoriesService.findAll();
  }

  @Auth(AuthType.Bearer)
  @Query(() => SubCategory, {
    name: 'subCategory',
    nullable: true,
    description: 'Retrieves a subcategory by its unique ID, or null if not found',
  })
  findOne(
    @Args('id', {
      type: () => String,
      description: 'The ID of the subcategory',
    })
    id: string,
  ) {
    return this.subCategoriesService.findOne(id);
  }

  @Auth(AuthType.Optional)
  @Query(() => SubCategory, {
    name: 'subCategoryBySlug',
    nullable: true,
    description: 'The subcategory with this current slug, else null (an old slug: resolveSlug)',
  })
  findOneBySlug(@Args('slug', { type: () => String }) slug: string) {
    return this.subCategoriesService.findBySlug(slug);
  }

  @Mutation(() => SubCategory, {
    description: 'Updates an existing subcategory (admin only)',
  })
  @RequirePermission('catalog.taxonomy.write')
  updateSubCategory(
    @Args('id', {
      type: () => String,
      description: 'The ID of the subcategory to update',
    })
    id: string,
    @Args('input', {
      type: () => UpdateSubCategoryInput,
      description: 'Updated data for the subcategory',
    })
    input: UpdateSubCategoryInput,
  ) {
    return this.subCategoriesService.update(id, input);
  }

  @Mutation(() => SubCategory, {
    description: 'Deletes a subcategory by ID (admin only)',
  })
  @RequirePermission('catalog.taxonomy.write')
  removeSubCategory(
    @Args('id', {
      type: () => String,
      description: 'The ID of the subcategory to delete',
    })
    id: string,
  ) {
    return this.subCategoriesService.remove(id);
  }
}
