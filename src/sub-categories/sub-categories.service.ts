import { ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { CreateSubCategoryInput } from './dto/create-sub-category.input';
import { UpdateSubCategoryInput } from './dto/update-sub-category.input';
import { SubCategory } from '@prisma/client';
import { SubCategoriesRepository } from './sub-categories.repository';

@Injectable()
export class SubCategoriesService {
  constructor(private readonly subCategoriesRepository: SubCategoriesRepository) {}

  /**
   * Creates a new SubCategory using the provided input data.
   * @param createSubCategoryInput - The input data for creating a new SubCategory.
   * @returns A promise resolving to the created SubCategory.
   * @throws {ConflictException} If a SubCategory with the same name (case-insensitive) already exists within the same category.
   */
  async create(createSubCategoryInput: CreateSubCategoryInput): Promise<SubCategory> {
    const { name, categoryId } = createSubCategoryInput;

    const existing = await this.findSubCategoryByNameAndCategory(name, categoryId);
    if (existing) {
      throw new ConflictException(
        `A SubCategory with the name "${name}" already exists in category ID "${categoryId}"`,
      );
    }

    return this.subCategoriesRepository.create(createSubCategoryInput);
  }

  /**
   * Retrieves all subcategories from the database, sorted alphabetically by name.
   * @returns A promise resolving to an array of subcategories.
   */
  async findAll(): Promise<SubCategory[]> {
    return this.subCategoriesRepository.findAll() as unknown as Promise<SubCategory[]>;
  }

  /**
   * Retrieves a SubCategory by its unique identifier.
   * @param id - The unique identifier of the SubCategory.
   * @returns A promise resolving to the SubCategory or null if not found.
   */
  async findOne(id: string): Promise<SubCategory | null> {
    return this.subCategoriesRepository.findById(id);
  }

  /**
   * Updates an existing SubCategory with the provided input data.
   * @param id - The unique identifier of the SubCategory to update.
   * @param updateSubCategoryInput - The input data for updating the SubCategory.
   * @returns A promise resolving to the updated SubCategory.
   * @throws {NotFoundException} If the SubCategory does not exist.
   * @throws {ConflictException} If the new name conflicts with an existing SubCategory in the same category.
   */
  async update(id: string, updateSubCategoryInput: UpdateSubCategoryInput): Promise<SubCategory> {
    await this.checkSubCategory(id);

    if (updateSubCategoryInput.name) {
      const current = await this.findOne(id);
      const categoryId = updateSubCategoryInput.categoryId || current!.categoryId;
      const existing = await this.findSubCategoryByNameAndCategory(updateSubCategoryInput.name, categoryId);
      if (existing && existing.id !== id) {
        throw new ConflictException(
          `A SubCategory with the name "${updateSubCategoryInput.name}" already exists in category ID "${categoryId}"`,
        );
      }
    }

    return this.subCategoriesRepository.update(id, updateSubCategoryInput);
  }

  /**
   * Removes a SubCategory by its unique identifier.
   * @param id - The unique identifier of the SubCategory to remove.
   * @returns A promise resolving to the deleted SubCategory.
   * @throws {NotFoundException} If the SubCategory does not exist.
   * @throws {ConflictException} If the SubCategory has associated products.
   */
  async remove(id: string): Promise<SubCategory> {
    await this.checkSubCategory(id);

    const productCount = await this.subCategoriesRepository.countProducts(id);
    if (productCount > 0) {
      throw new ConflictException('Cannot delete SubCategory with associated products');
    }

    return this.subCategoriesRepository.delete(id);
  }

  /**
   * Finds a SubCategory by its name and category ID (case-insensitive).
   * @param name - The name of the SubCategory to find.
   * @param categoryId - The ID of the category to scope the search.
   * @returns A promise resolving to the SubCategory or null if not found.
   */
  async findSubCategoryByNameAndCategory(name: string, categoryId: string): Promise<SubCategory | null> {
    return this.subCategoriesRepository.findFirst({
      name: { mode: 'insensitive', equals: name },
      categoryId,
    });
  }

  /**
   * Checks if a SubCategory exists by its ID.
   * @param id - The unique identifier of the SubCategory.
   * @throws {NotFoundException} If the SubCategory does not exist.
   */
  private async checkSubCategory(id: string): Promise<void> {
    const subCategory = await this.findOne(id);
    if (!subCategory) throw new NotFoundException('SubCategory not found');
  }
}
