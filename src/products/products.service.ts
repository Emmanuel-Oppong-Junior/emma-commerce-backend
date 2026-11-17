import { BadRequestException, ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { CreateProductInput } from './dto/create-product.input';
import { UpdateProductInput } from './dto/update-product.input';
import { ProductFilterArgs } from './dto/product-filter.args';
import { ProductSortArgs } from './dto/product-sort.args';
import { ProductSortField } from './enums/product-sort-field.enum';
import { SortOrder } from '../commons/enums/sort-order.enum';
import { Prisma, Product } from '@prisma/client';
import { PaginationArgs } from '../commons/dto/paginate.args';
import { ProductConnection } from './entities/product-connection.entity';
import { ProductsRepository } from './products.repository';
import { TaxService } from '../tax/tax.service';
import { AuditService, fieldChanges, fieldValues } from '../commons/audit.service';

export const PUBLIC_PRODUCT_WHERE = { isActive: true, status: 'PUBLISHED' } satisfies Prisma.ProductWhereInput;
export const MAX_NESTED_PRODUCTS = 100;
const AUDITED_PRODUCT_FIELDS = [
  'name',
  'sku',
  'basePrice',
  'price',
  'currentPrice',
  'isTaxable',
  'status',
  'isActive',
  'categoryId',
  'subcategoryId',
  'brandId',
] as const satisfies readonly (keyof Product)[];

@Injectable()
export class ProductsService {
  constructor(
    private readonly productsRepository: ProductsRepository,
    private readonly taxService: TaxService,
    private readonly auditService: AuditService,
  ) {}

  /**
   * Creates a new product.
   * If isTaxable is true, price is computed as basePrice × (1 + total active tax rate).
   * Otherwise price equals basePrice.
   */
  async create(createProductInput: CreateProductInput, actorId: string): Promise<Product> {
    await this.validateProductInput(createProductInput);
    const { basePrice, isTaxable, ...rest } = createProductInput;
    const price = await this.computePrice(Number(basePrice), isTaxable);
    return this.auditService.record(
      (tx) =>
        this.productsRepository.create(
          { ...rest, basePrice, price: price.toFixed(2), isTaxable: isTaxable ?? false },
          { category: true, subcategory: true },
          tx,
        ),
      (product) => ({
        entity: 'Product',
        entityId: product.id,
        action: 'CREATE',
        userId: actorId,
        details: { after: fieldValues(product, AUDITED_PRODUCT_FIELDS) },
      }),
    );
  }

  /**
   * Updates an existing product.
   * Recomputes price whenever basePrice or isTaxable changes.
   */
  async update(id: string, updateProductInput: UpdateProductInput, actorId: string): Promise<Product> {
    const existing = await this.productsRepository.findById(id);
    if (!existing) throw new NotFoundException('Product not found');
    await this.validateProductInput({ ...updateProductInput, id });
    const updateData = await this.buildUpdateData(existing, updateProductInput);
    return this.auditService.record(
      (tx) => this.productsRepository.update(id, updateData, { category: true, subcategory: true }, tx),
      (updated) => ({
        entity: 'Product',
        entityId: id,
        action: 'UPDATE',
        userId: actorId,
        details: { changes: fieldChanges(existing, updated, Object.keys(updateData) as (keyof Product)[]) },
      }),
    );
  }

  /**
   * Removes a product from the database by its ID.
   */
  async remove(id: string, actorId: string): Promise<Product> {
    await this.ensureProductExist(id);
    await this.checkProductDependencies(id);
    return this.auditService.record(
      (tx) => this.productsRepository.delete(id, tx),
      (deleted) => ({
        entity: 'Product',
        entityId: id,
        action: 'DELETE',
        userId: actorId,
        details: { before: fieldValues(deleted, AUDITED_PRODUCT_FIELDS) },
      }),
    );
  }

  async addTagToProduct(productId: string, tagId: string, actorId: string): Promise<Product> {
    return this.updateProductTag(productId, tagId, 'connect', actorId);
  }

  async removeTagFromProduct(productId: string, tagId: string, actorId: string): Promise<Product> {
    return this.updateProductTag(productId, tagId, 'disconnect', actorId);
  }

  async findAll(
    paginate: PaginationArgs,
    filter: ProductFilterArgs = {},
    sort: ProductSortArgs = {},
    requestedData?: Prisma.ProductSelect,
  ): Promise<ProductConnection> {
    return this.findPage(paginate, this.buildWhereClause(filter), sort, requestedData);
  }

  async findAllPublished(
    paginate: PaginationArgs,
    filter: ProductFilterArgs = {},
    sort: ProductSortArgs = {},
    requestedData?: Prisma.ProductSelect,
  ): Promise<ProductConnection> {
    return this.findPage(paginate, { ...this.buildWhereClause(filter), ...PUBLIC_PRODUCT_WHERE }, sort, requestedData);
  }

  async findPublishedById(id: string, requestedFields: Prisma.ProductSelect = {}): Promise<Product | null> {
    return this.productsRepository.findFirst({ id, ...PUBLIC_PRODUCT_WHERE }, requestedFields);
  }

  async findPublishedIn(
    parent: Pick<Prisma.ProductWhereInput, 'categoryId' | 'subcategoryId' | 'brandId'>,
    first: number,
  ): Promise<Product[]> {
    if (!Number.isInteger(first) || first < 1 || first > MAX_NESTED_PRODUCTS) {
      throw new BadRequestException(`first must be an integer from 1 to ${MAX_NESTED_PRODUCTS}, got ${first}`);
    }
    return this.productsRepository.findMany(
      { take: first },
      { ...parent, ...PUBLIC_PRODUCT_WHERE },
      { createdAt: 'desc' },
    );
  }

  private async findPage(
    paginate: PaginationArgs,
    whereClause: Prisma.ProductWhereInput,
    sort: ProductSortArgs,
    requestedData?: Prisma.ProductSelect,
  ): Promise<ProductConnection> {
    const paginationOptions = this.buildPaginationOptions(paginate);
    const orderBy = this.buildOrderByClause(sort);

    const [products, totalCount] = await Promise.all([
      this.productsRepository.findMany(
        { ...paginationOptions, take: (paginationOptions.take ?? 10) + 1 },
        whereClause,
        orderBy,
        requestedData,
      ),
      this.productsRepository.count(whereClause),
    ]);
    return this.formatPaginatedResponse(products, paginationOptions, totalCount);
  }

  async findOne(id: string, requestedFields: Prisma.ProductSelect = {}): Promise<Product | null> {
    return this.productsRepository.findById(id, requestedFields);
  }

  async archiveProduct(id: string, actorId: string): Promise<Product> {
    return this.setActive(id, false, actorId);
  }

  async restoreProduct(id: string, actorId: string): Promise<Product> {
    return this.setActive(id, true, actorId);
  }

  private async setActive(id: string, isActive: boolean, actorId: string): Promise<Product> {
    const existing = await this.productsRepository.findById(id);
    if (!existing) throw new NotFoundException('Product not found');
    return this.auditService.record(
      (tx) => this.productsRepository.update(id, { isActive }, undefined, tx),
      (updated) => ({
        entity: 'Product',
        entityId: id,
        action: isActive ? 'RESTORE' : 'ARCHIVE',
        userId: actorId,
        details: { changes: fieldChanges(existing, updated, ['isActive']) },
      }),
    );
  }

  private async computePrice(basePrice: number, isTaxable: boolean): Promise<number> {
    if (!isTaxable) return basePrice;
    const totalRate = await this.taxService.getTotalActiveRate();
    return basePrice * (1 + totalRate);
  }

  private async buildUpdateData(existing: Product, input: UpdateProductInput): Promise<Prisma.ProductUpdateInput> {
    const { basePrice, isTaxable, ...rest } = input;
    const updateData: Prisma.ProductUpdateInput = { ...rest };

    if (basePrice !== undefined || isTaxable !== undefined) {
      const effectiveBase = basePrice !== undefined ? Number(basePrice) : Number(existing.basePrice);
      const effectiveTaxable = isTaxable !== undefined ? isTaxable : existing.isTaxable;
      const price = await this.computePrice(effectiveBase, effectiveTaxable);
      updateData.price = price.toFixed(2);
      if (basePrice !== undefined) updateData.basePrice = basePrice;
      if (isTaxable !== undefined) updateData.isTaxable = isTaxable;
    }

    return updateData;
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
    await this.validateCategoryAndSubcategory(input.categoryId ?? '', input.subcategoryId);
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
      status,
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
      ...(status && { status }),
      ...(search && {
        OR: [
          { name: { search: search.trim().split(/\s+/).join(' & ') } },
          { description: { search: search.trim().split(/\s+/).join(' & ') } },
          { tags: { some: { name: { contains: search, mode: 'insensitive' } } } },
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

  private buildOrderByClause({
    sortBy = ProductSortField.CREATED_AT,
    sortOrder = SortOrder.DESC,
  }: ProductSortArgs): Prisma.ProductOrderByWithRelationInput {
    return { [sortBy]: sortOrder };
  }

  private formatPaginatedResponse(
    products: Product[],
    { skip, take }: { take?: number; skip?: number },
    totalCount: number,
  ): ProductConnection {
    const pageSize = take ?? 10;
    const hasNextPage = products.length > pageSize;
    const items = hasNextPage ? products.slice(0, pageSize) : products;
    return {
      edges: items.map((product) => ({
        cursor: product.id,
        node: product,
      })) as ProductConnection['edges'],
      pageInfo: {
        pageSize,
        hasPreviousPage: (skip ?? 0) > 0,
        hasNextPage,
        totalCount,
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
    actorId: string,
  ): Promise<Product> {
    await this.ensureProductExist(productId);
    await this.ensureTagExists(tagId);
    return this.auditService.record(
      (tx) => this.productsRepository.updateTags(productId, operation, tagId, tx),
      () => ({
        entity: 'Product',
        entityId: productId,
        action: 'UPDATE',
        userId: actorId,
        details: { tags: { [operation]: tagId } },
      }),
    );
  }
}
