import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { AddProductsToTagDto } from './dto/add-products-to-tag.dto';
import { RemoveProductsFromTagDto } from './dto/remove-products-from-tag.dto';
import { Tag } from '@prisma/client';
import { TagRepository } from './tag.repository';

@Injectable()
export class TagService {
  constructor(private readonly tagRepository: TagRepository) {}

  /**
   * Creates a new tag.
   * @param name - The name of the tag.
   * @returns The created tag.
   */
  async createTag(name: string): Promise<Tag> {
    await this.ensureTagNameUnique(name);
    return this.tagRepository.create(name);
  }

  /**
   * Retrieves a specific tag by ID.
   * @param tagId - The ID of the tag.
   * @returns The tag.
   */
  async getTag(tagId: string): Promise<Tag> {
    return this.retrieveTag(tagId);
  }

  /**
   * Retrieves all tags.
   * @returns List of all tags.
   */
  async getAllTags(): Promise<Tag[]> {
    return this.tagRepository.findAll();
  }

  /**
   * Updates an existing tag.
   * @param tagId - The ID of the tag.
   * @param name - The new name for the tag.
   * @returns The updated tag.
   */
  async updateTag(tagId: string, name: string): Promise<Tag> {
    await this.retrieveTag(tagId);
    await this.ensureTagNameUnique(name, tagId);
    return this.tagRepository.update(tagId, name);
  }

  /**
   * Deletes a tag.
   * @param tagId - The ID of the tag.
   * @returns The deleted tag.
   */
  async deleteTag(tagId: string): Promise<Tag> {
    await this.retrieveTag(tagId);
    return this.tagRepository.delete(tagId);
  }

  /**
   * Adds products to a tag by connecting the provided product IDs to the tag.
   *
   * @param {string} tagId - The ID of the tag to which products will be added.
   * @param addProductsToTagDto
   */
  async addProductsToTag(tagId: string, addProductsToTagDto: AddProductsToTagDto) {
    await this.retrieveTag(tagId);
    return this.tagRepository.connectProducts(tagId, addProductsToTagDto?.productIds ?? []);
  }

  /**
   * Removes products from a tag by disconnecting the provided product IDs to the tag.
   *
   * @param {string} tagId - The ID of the tag to which products will be removed.
   * @param removeProductsFromTagDto
   */
  async removeProductsFromTag(tagId: string, removeProductsFromTagDto: RemoveProductsFromTagDto) {
    await this.retrieveTag(tagId);
    return this.tagRepository.disconnectProducts(tagId, removeProductsFromTagDto?.productIds ?? []);
  }

  private async ensureTagNameUnique(name: string, excludeTagId?: string): Promise<void> {
    const existingTag = await this.tagRepository.findByName(name);
    if (existingTag && existingTag.id !== excludeTagId) {
      throw new BadRequestException(`Tag name "${name}" is already in use`);
    }
  }

  private async retrieveTag(tagId: string): Promise<Tag> {
    const tag = await this.tagRepository.findById(tagId);
    if (!tag) {
      throw new NotFoundException(`Tag "${tagId}" not found`);
    }
    return tag;
  }
}
