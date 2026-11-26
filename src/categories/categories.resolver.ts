import { Args, Info, Mutation, Query, Resolver } from '@nestjs/graphql';
import { CategoriesService } from './categories.service';
import { Category } from './entities/category.entity';
import { CreateCategoryInput } from './dto/create-category.input';
import { UpdateCategoryInput } from './dto/update-category.input';
import { AuthType } from '../iam/authentication/enums/auth-type.enum';
import { Auth } from '../iam/authentication/decorators/auth.decorator';
import { extractRequestedFieldsFromQuery } from '../commons/useful-functions';
import { GraphQLResolveInfo } from 'graphql/type';
import { RequirePermission } from '../iam/authorization/policy.decorators';

@Resolver(() => Category)
export class CategoriesResolver {
  constructor(private readonly categoriesService: CategoriesService) {}

  @RequirePermission('catalog.taxonomy.write')
  @Mutation(() => Category, {
    description: 'Creates a new category (admin only)',
  })
  createCategory(
    @Args('input', { type: () => CreateCategoryInput })
    input: CreateCategoryInput,
  ) {
    return this.categoriesService.create(input);
  }

  @Auth(AuthType.Optional)
  @Query(() => [Category], {
    name: 'categories',
    description: 'Retrieves a list of all categories, sorted alphabetically by name',
  })
  findAll(@Info() requestInfo?: GraphQLResolveInfo) {
    const requestedFields = extractRequestedFieldsFromQuery(requestInfo!, {
      // products is resolved by CategoryProductsResolver (published only, capped), never via this select.
      excludedFields: ['products'],
      level: 1,
    });
    return this.categoriesService.findAll(requestedFields);
  }

  @Auth(AuthType.Bearer)
  @Query(() => Category, {
    name: 'category',
    nullable: true,
    description: 'Retrieves a category by its unique ID, or null if not found',
  })
  findOne(
    @Args('id', { type: () => String, description: 'The ID of the category' })
    id: string,
  ) {
    return this.categoriesService.findOne(id);
  }

  @Auth(AuthType.Optional)
  @Query(() => Category, {
    name: 'categoryBySlug',
    nullable: true,
    description: 'The category with this current slug, else null (an old slug: resolveSlug)',
  })
  findOneBySlug(@Args('slug', { type: () => String }) slug: string) {
    return this.categoriesService.findBySlug(slug);
  }

  @RequirePermission('catalog.taxonomy.write')
  @Mutation(() => Category, {
    description: 'Updates an existing category (admin only)',
  })
  updateCategory(
    @Args('id', {
      type: () => String,
      description: 'The ID of the category to update',
    })
    id: string,
    @Args('input', { type: () => UpdateCategoryInput })
    input: UpdateCategoryInput,
  ) {
    return this.categoriesService.update(id, input);
  }

  @RequirePermission('catalog.taxonomy.write')
  @Mutation(() => Category, {
    description: 'Deletes a category by ID (admin only)',
  })
  removeCategory(
    @Args('id', {
      type: () => String,
      description: 'The ID of the category to delete',
    })
    id: string,
  ) {
    return this.categoriesService.remove(id);
  }
}
