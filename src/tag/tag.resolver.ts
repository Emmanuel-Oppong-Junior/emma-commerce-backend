import { Args, Mutation, Query, Resolver } from '@nestjs/graphql';
import { TagService } from './tag.service';
import { Roles } from '../iam/authentication/decorators/roles.decorator';
import { Role } from '../users/enums/role.enum';
import { Tag } from './entities/tag.entity';
import { AddProductsToTagDto } from './dto/add-products-to-tag.dto';
import { RemoveProductsFromTagDto } from './dto/remove-products-from-tag.dto';

@Roles(Role.ADMIN, Role.SUPER_ADMIN)
@Resolver(() => Tag)
export class TagResolver {
  constructor(private readonly tagService: TagService) {}

  @Roles(Role.ADMIN, Role.SUPER_ADMIN, Role.USER)
  @Query(() => Tag, {
    name: 'tag',
    description: 'Retrieves a specific tag by ID',
  })
  async getTag(@Args('tagId', { type: () => String }) tagId: string): Promise<Tag> {
    return this.tagService.getTag(tagId);
  }

  @Roles(Role.ADMIN, Role.SUPER_ADMIN, Role.USER)
  @Query(() => [Tag], { name: 'tags', description: 'Retrieves all tags' })
  async getAllTags(): Promise<Tag[]> {
    return this.tagService.getAllTags();
  }

  @Mutation(() => Tag, { name: 'createTag', description: 'Creates a new tag' })
  async createTag(@Args('name', { type: () => String }) name: string): Promise<Tag> {
    return this.tagService.createTag(name);
  }

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

  @Mutation(() => Tag, { name: 'deleteTag', description: 'Deletes a tag' })
  async deleteTag(@Args('tagId', { type: () => String }) tagId: string): Promise<Tag> {
    return this.tagService.deleteTag(tagId);
  }

  @Mutation(() => Tag, { name: 'addProductsToTag', description: 'Add products to a tag' })
  async addProductsToTag(
    @Args('tagId', { type: () => String }) tagId: string,
    @Args('updateDiscountInput') addProductsToTagDto: AddProductsToTagDto,
  ) {
    return this.tagService.addProductsToTag(tagId, addProductsToTagDto);
  }
  @Mutation(() => Tag, { name: 'removeProductsFromTag', description: 'Add products to a tag' })
  async removeProductsFromTag(
    @Args('tagId', { type: () => String }) tagId: string,
    @Args('updateDiscountInput') removeProductFromTagDto: RemoveProductsFromTagDto,
  ) {
    return this.tagService.removeProductsFromTag(tagId, removeProductFromTagDto);
  }
}
