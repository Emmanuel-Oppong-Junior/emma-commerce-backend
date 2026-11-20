import { Args, Mutation, Query, Resolver } from '@nestjs/graphql';
import { TagService } from './tag.service';
import { Tag } from './entities/tag.entity';
import { AddProductsToTagDto } from './dto/add-products-to-tag.dto';
import { RemoveProductsFromTagDto } from './dto/remove-products-from-tag.dto';
import { Auth } from '../iam/authentication/decorators/auth.decorator';
import { AuthType } from '../iam/authentication/enums/auth-type.enum';
import { RequirePermission } from '../iam/authorization/policy.decorators';

@Resolver(() => Tag)
export class TagResolver {
  constructor(private readonly tagService: TagService) {}

  @Auth(AuthType.Bearer)
  @Query(() => Tag, {
    name: 'tag',
    description: 'Retrieves a specific tag by ID',
  })
  async getTag(@Args('tagId', { type: () => String }) tagId: string): Promise<Tag> {
    return this.tagService.getTag(tagId);
  }

  @Auth(AuthType.Bearer)
  @Query(() => [Tag], { name: 'tags', description: 'Retrieves all tags' })
  async getAllTags(): Promise<Tag[]> {
    return this.tagService.getAllTags();
  }

  @RequirePermission('catalog.taxonomy.write')
  @Mutation(() => Tag, { name: 'createTag', description: 'Creates a new tag' })
  async createTag(@Args('name', { type: () => String }) name: string): Promise<Tag> {
    return this.tagService.createTag(name);
  }

  @RequirePermission('catalog.taxonomy.write')
  @Mutation(() => Tag, {
    name: 'updateTag',
    description: 'Updates an existing tag',
  })
  async updateTag(
    @Args('tagId', { type: () => String }) tagId: string,
    @Args('name', { type: () => String }) name: string,
  ): Promise<Tag> {
    return this.tagService.updateTag(tagId, name);
  }

  @RequirePermission('catalog.taxonomy.write')
  @Mutation(() => Tag, { name: 'deleteTag', description: 'Deletes a tag' })
  async deleteTag(@Args('tagId', { type: () => String }) tagId: string): Promise<Tag> {
    return this.tagService.deleteTag(tagId);
  }

  @RequirePermission('catalog.taxonomy.write')
  @Mutation(() => Tag, { name: 'addProductsToTag', description: 'Add products to a tag' })
  async addProductsToTag(
    @Args('tagId', { type: () => String }) tagId: string,
    @Args('updateDiscountInput') addProductsToTagDto: AddProductsToTagDto,
  ) {
    return this.tagService.addProductsToTag(tagId, addProductsToTagDto);
  }
  @RequirePermission('catalog.taxonomy.write')
  @Mutation(() => Tag, { name: 'removeProductsFromTag', description: 'Add products to a tag' })
  async removeProductsFromTag(
    @Args('tagId', { type: () => String }) tagId: string,
    @Args('updateDiscountInput') removeProductFromTagDto: RemoveProductsFromTagDto,
  ) {
    return this.tagService.removeProductsFromTag(tagId, removeProductFromTagDto);
  }
}
