import { ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { CreateProductInput } from './dto/create-product.input';
import { UpdateProductInput } from './dto/update-product.input';
import { ProductFilterArgs } from './dto/product-filter.args';
import { Prisma, Product } from '@prisma/client';
import { PaginationArgs } from '../commons/dto/paginate.args';
import { ProductConnection } from './entities/product-connection.entity';
import { ProductsRepository } from './products.repository';

@Injectable()
export class ProductsService {
  constructor(private readonly productsRepository: ProductsRepository) {}

  /**
   * Creates a new product in the database.
   * Validates the category, subcategory, and SKU for uniqueness before creation.
   *
   * @param createProductInput - The input data for creating a new product.
   * @returns The created product with its associated category and subcategory.
   * @throws NotFoundException if the category or subcategory does not exist.
   * @throws ConflictException if the SKU is already in use.
   */
  async create(createProductInput: CreateProductInput): Promise<Product> {
    await this.validateProductInput(createProductInput);
    return this.productsRepository.create(createProductInput, { category: true, subcategory: true });
  }

  /**
   * Updates an existing product in the database.
   * Validates the product's existence and the update input before proceeding.
   *
   * @param id - The unique identifier of the product to update.
   * @param updateProductInput - The input data for updating the product.
   * @returns The updated product with its associated category and subcategory.
   * @throws NotFoundException if the product does not exist.
   * @throws ConflictException if the SKU is already in use by another product.
   */
  async update(id: string, updateProductInput: UpdateProductInput): Promise<Product> {
    await this.ensureProductExist(id);
    await this.validateProductInput({ ...updateProductInput, id });
    return this.productsRepository.update(id, updateProductInput, { category: true, subcategory: true });
  }

  /**
   * Removes a product from the database by its ID.
   * Validates the product's existence and checks for dependencies before deletion.
   *
   * @param id - The unique identifier of the product to remove.
   * @returns The deleted product with its associated category and subcategory.
   * @throws NotFoundException if the product does not exist.
   * @throws ConflictException if the product is referenced in active carts or orders.
   */
  async remove(id: string): Promise<Product> {
    await this.ensureProductExist(id);
    await this.checkProductDependencies(id);
    return this.productsRepository.delete(id);
  }

  async addTagToProduct(productId: string, tagId: string): Promise<Product> {
    return this.updateProductTag(productId, tagId, 'connect');
  }

  async removeTagFromProduct(productId: string, tagId: string): Promise<Product> {
    return this.updateProductTag(productId, tagId, 'disconnect');
  }

  /**
   * Retrieves a paginated list of products with filtering.
   * @param paginate
   * @param filter - Pagination and filter arguments (first, after, categoryId, etc.).
   * @param requestedData
   * @returns A paginated response with edges and pageInfo.
   */
  async findAll(
    paginate: PaginationArgs,
    filter: ProductFilterArgs = {},
    requestedData?: Prisma.ProductSelect,
  ): Promise<ProductConnection> {
    const paginationOptions = this.buildPaginationOptions(paginate);
    const whereClause = this.buildWhereClause(filter);

    const products = await this.productsRepository.findMany(paginationOptions, whereClause, requestedData);
    const totalCount = await this.productsRepository.count(whereClause);
    return this.formatPaginatedResponse(products, totalCount, paginationOptions);
  }

  /**
   * Retrieves a single product by its ID.
   *
   * @param id - The unique identifier of the product to retrieve.
   * @param requestedFields
   * @returns The product with its associated category and subcategory, or null if not found.
   */
  async findOne(id: string, requestedFields: Prisma.ProductSelect = {}): Promise<Product | null> {
    return this.productsRepository.findById(id, requestedFields);
  }

  /**
   * Archives a product by setting its isActive status to false.
   * @param id - The unique identifier of the product to archive.
   * @returns The updated product.
   * @throws NotFoundException if the product does not exist.
   */
  async archiveProduct(id: string): Promise<Product> {
    await this.ensureProductExist(id);
    return this.productsRepository.update(id, { isActive: false });
  }

  /**
   * Restores a previously archived product by setting its isActive status to true.
   * @param id - The unique identifier of the product to restore.
   * @returns The updated product.
   * @throws NotFoundException if the product does not exist.
   */
  async restoreProduct(id: string): Promise<Product> {
    await this.ensureProductExist(id);
    return this.productsRepository.update(id, { isActive: true });
  }

  private buildPaginationOptions({ first, after }: PaginationArgs) {
    if (!first && !after) return {};
    const pageSize = Math.min(first, 100);
    const hasCursor = !!after;
    return {
      take: pageSize,
      skip: hasCursor ? 1 : 0,
      cursor: hasCursor ? { id: after } : undefined,
    };
  }

  private async validateProductInput(input: CreateProductInput | (UpdateProductInput & { id: string })) {
    await this.validateCategoryAndSubcategory(input.categoryId, input.subcategoryId);
    await this.validateSkuUniqueness(input);
  }

  private async validateCategoryAndSubcategory(categoryId: string, subcategoryId?: string): Promise<void> {
    if (categoryId) {
      const category = await this.productsRepository.findCategoryById(categoryId);
      if (!category) throw new NotFoundException(`Category ID "${categoryId}" not found`);
    }

    if (subcategoryId) {
      const subcategory = await this.productsRepository.findSubCategoryById(subcategoryId);
      if (!subcategory) throw new NotFoundException(`Subcategory ID "${subcategoryId}" not found`);
      if (subcategory.categoryId !== categoryId) {
        throw new ConflictException(`Subcategory ID "${subcategoryId}" does not belong to category ID "${categoryId}"`);
      }
    }
  }

  private async validateSkuUniqueness(input: CreateProductInput | UpdateProductInput): Promise<void> {
    const { sku } = input;
    if (sku) {
      const existing = await this.productsRepository.findFirst({
        sku: { equals: sku, mode: 'insensitive' },
      });
      if ('id' in input && existing && existing.id != input.id) {
        throw new ConflictException(`SKU "${sku}" is already in use by another product`);
      }

      if (!('id' in input) && existing) {
        throw new ConflictException(`SKU "${sku}" is already in use`);
      }
    }
  }

  private async ensureProductExist(id: string): Promise<void> {
    const product = await this.findOne(id);
    if (!product) throw new NotFoundException('Product not found');
  }

  private async checkProductDependencies(id: string): Promise<void> {
    const cartItemCount = await this.productsRepository.countCartItems(id);
    const orderItemCount = await this.productsRepository.countOrderItems(id);
    if (cartItemCount > 0 || orderItemCount > 0) {
      throw new ConflictException('Cannot delete product referenced in active carts or orders');
    }
  }

  private buildWhereClause(filter: ProductFilterArgs): Prisma.ProductWhereInput {
    const {
      categoryId,
      subcategoryId,
      isActive,
      search,
      createdAfter,
      priceMin,
      priceMax,
      brand,
      categoryName,
      subCategoryName,
      inStock,
      tagId,
      tagName,
    } = filter;
    return {
      ...(categoryName && { category: { name: { equals: categoryName, mode: 'insensitive' } } }),
      ...(subCategoryName && { subcategory: { name: { equals: categoryName, mode: 'insensitive' } } }),
      ...(categoryId && { categoryId }),
      ...(subcategoryId && { subcategoryId }),
      ...(isActive !== undefined && { isActive }),
      ...(search && {
        OR: [
          { name: { contains: search, mode: 'insensitive' } },
          { description: { contains: search, mode: 'insensitive' } },
          {
            tags: { some: { name: { contains: search, mode: 'insensitive' } } },
          },
        ],
      }),
      ...(createdAfter && { createdAt: { gte: new Date(createdAfter) } }),
      ...(priceMin !== undefined && { price: { gte: priceMin } }),
      ...(priceMax !== undefined && { price: { lte: priceMax } }),
      ...(brand && { brand: { name: { equals: brand, mode: 'insensitive' } } }),
      ...(inStock && { quantity: { gte: 0 } }),
      ...(tagId && { tags: { some: { id: { equals: tagId } } } }),
      ...(tagName && { tags: { some: { name: { equals: tagName, mode: 'insensitive' } } } }),
    };
  }

  private formatPaginatedResponse(
    products: Product[],
    totalCount: number,
    { skip, take }: { take?: number; skip?: number },
  ): ProductConnection {
    const lastProduct = products[products.length - 1];
    const itemsFetched = skip + products.length;
    return {
      edges: products.map((product) => ({
        cursor: product.id,
        node: product,
      })),
      pageInfo: {
        pageSize: take,
        hasPreviousPage: skip > 0,
        hasNextPage: !!lastProduct && totalCount > itemsFetched,
      },
    };
  }

  private async ensureTagExists(tagId: string): Promise<void> {
    const tag = await this.productsRepository.findTagById(tagId);
    if (!tag) throw new NotFoundException(`Tag "${tagId}" not found`);
  }

  private async updateProductTag(
    productId: string,
    tagId: string,
    operation: 'connect' | 'disconnect',
  ): Promise<Product> {
    await this.ensureProductExist(productId);
    await this.ensureTagExists(tagId);
    return this.productsRepository.updateTags(productId, operation, tagId);
  }
}
