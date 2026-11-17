import { ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { CACHE_MANAGER } from '@nestjs/cache-manager';
import { Cache } from 'cache-manager';
import { Inject } from '@nestjs/common';
import { CreateCategoryInput } from './dto/create-category.input';
import { UpdateCategoryInput } from './dto/update-category.input';
import { Category, Prisma } from '@prisma/client';
import { CategoriesRepository } from './categories.repository';

const CATEGORY_TREE_KEY = 'category:tree';
const CATEGORY_TTL = 300000; // 5 minutes

@Injectable()
export class CategoriesService {
  constructor(
    private readonly categoriesRepository: CategoriesRepository,
    @Inject(CACHE_MANAGER) private readonly cacheManager: Cache,
  ) {}

  /**
   * Creates a new category using the provided input data.
   * @param createCategoryInput - The input data for creating a new category.
   * @returns A promise resolving to the created category.
   * @throws {ConflictException} If a category with the same name (case-insensitive) already exists.
   */
  async create(createCategoryInput: CreateCategoryInput): Promise<Category> {
    const { name } = createCategoryInput;
    const existing = await this.findCategoryByName(name);
    if (existing) throw new ConflictException(`A category with the name "${name}" already exists`);
    const created = await this.categoriesRepository.create(createCategoryInput);
    await this.cacheManager.del(CATEGORY_TREE_KEY);
    return created;
  }

  /**
   * Retrieves all categories from the database, sorted alphabetically by name.
   * @returns A promise resolving to an array of categories.
   */
  async findAll(requestedFields: Prisma.CategorySelect): Promise<Category[]> {
    const hasSelectFilter = Object.keys(requestedFields).length > 0;
    if (!hasSelectFilter) {
      const cached = await this.cacheManager.get<Category[]>(CATEGORY_TREE_KEY);
      if (cached) return cached;
    }

    const queryOption: Prisma.CategoryFindManyArgs = { orderBy: { name: 'asc' } };
    if (hasSelectFilter) queryOption.select = { ...requestedFields, id: true };
    const categories = await this.categoriesRepository.findAll(queryOption);

    if (!hasSelectFilter) {
      await this.cacheManager.set(CATEGORY_TREE_KEY, categories, CATEGORY_TTL);
    }
    return categories;
  }

  /**
   * Retrieves a category by its unique identifier.
   * @param id - The unique identifier of the category.
   * @returns A promise resolving to the category or null if not found.
   */
  async findOne(id: string): Promise<Category | null> {
    return this.categoriesRepository.findById(id);
  }

  /**
   * Updates an existing category with the provided input data.
   * @param id - The unique identifier of the category to update.
   * @param updateCategoryInput - The input data for updating the category.
   * @returns A promise resolving to the updated category.
   * @throws {NotFoundException} If the category does not exist.
   * @throws {ConflictException} If the new name conflicts with an existing category.
   */
  async update(id: string, updateCategoryInput: UpdateCategoryInput): Promise<Category> {
    const { name } = updateCategoryInput;
    await this.checkCategory(id);
    if (name) {
      const existing = await this.findCategoryByName(name);
      if (existing && existing.id !== id) {
        throw new ConflictException(`A category with the name "${name}" already exists`);
      }
    }
    const updated = await this.categoriesRepository.update(id, updateCategoryInput);
    await this.cacheManager.del(CATEGORY_TREE_KEY);
    return updated;
  }

  /**
   * Removes a category by its unique identifier.
   * @param id - The unique identifier of the category to remove.
   * @returns A promise resolving to the removed category.
   * @throws {NotFoundException} If the category does not exist.
   * @throws {ConflictException} If the category has associated products.
   */
  async remove(id: string): Promise<Category> {
    await this.checkCategory(id);
    const productCount = await this.categoriesRepository.countProducts(id);
    if (productCount > 0) throw new ConflictException('Cannot delete category with associated products');
    const deleted = await this.categoriesRepository.delete(id);
    await this.cacheManager.del(CATEGORY_TREE_KEY);
    return deleted;
  }

  /**
   * Finds a category by its name (case-insensitive).
   * @param name - The name of the category to find.
   * @returns A promise resolving to the category or null if not found.
   */
  async findCategoryByName(name: string): Promise<Category | null> {
    return this.categoriesRepository.findFirst({ name: { mode: 'insensitive', equals: name } });
  }

  /**
   * Checks if a category exists by its ID.
   * @param id - The unique identifier of the category.
   * @throws {NotFoundException} If the category does not exist.
   */
  private async checkCategory(id: string): Promise<void> {
    const category = await this.findOne(id);
    if (!category) throw new NotFoundException('Category not found');
  }
}
