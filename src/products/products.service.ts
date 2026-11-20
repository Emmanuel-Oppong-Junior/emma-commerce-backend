import { BadRequestException, ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { CreateProductInput } from './dto/create-product.input';
import { UpdateProductInput } from './dto/update-product.input';
import { ProductFilterArgs } from './dto/product-filter.args';
import { ProductSortArgs } from './dto/product-sort.args';
import { ProductSortField } from './enums/product-sort-field.enum';
import { SortOrder } from '../commons/enums/sort-order.enum';
import { Prisma, Product } from '../generated/prisma/client';
import { PaginationArgs } from '../commons/dto/paginate.args';
import { ProductConnection } from './entities/product-connection.entity';
import { ProductsRepository } from './products.repository';
import { TaxService } from '../tax/tax.service';
import { AuditService, fieldChanges, fieldValues } from '../commons/audit.service';
import { ProductTypesRepository, ProductTypeWithAttributes } from '../product-types/product-types.repository';
import {
  checkOptionValues,
  checkProductAttributes,
  describeProblems,
} from '../product-types/domain/attribute-validation';
import { VariantOptions } from './products.repository';
import { VariantService } from '../variant/variant.service';

export const GENERAL_PRODUCT_TYPE_ID = 'product_type_general';

export const PUBLIC_PRODUCT_WHERE = { isActive: true, status: 'PUBLISHED' } satisfies Prisma.ProductWhereInput;
export const MAX_NESTED_PRODUCTS = 100;
const AUDITED_PRODUCT_FIELDS = [
  'name',
  'productTypeId',
  'attributes',
  'isTaxable',
  'status',
  'isActive',
  'categoryId',
  'subcategoryId',
  'brandId',
  'requiresPrescription',
  'isPerishable',
  'shelfLifeDays',
  'trackLots',
  'trackSerials',
  'fulfilmentKind',
  'unitOfMeasure',
] as const satisfies readonly (keyof Product)[];

@Injectable()
export class ProductsService {
  constructor(
    private readonly productsRepository: ProductsRepository,
    private readonly taxService: TaxService,
    private readonly auditService: AuditService,
    private readonly productTypesRepository: ProductTypesRepository,
    private readonly variantService: VariantService,
  ) {}

  /**
   * Creates a product with its variants (at least one; a product without options has one variant with none). Each
   * variant's price is its basePrice, plus tax when the product is taxable; its initial stock is logged.
   */
  async create(createProductInput: CreateProductInput, actorId: string): Promise<Product> {
    await this.validateProductInput(createProductInput);
    const { variants, isTaxable, productTypeId, attributes: rawAttributes, ...rest } = createProductInput;
    const productType = await this.findProductType(productTypeId ?? GENERAL_PRODUCT_TYPE_ID);
    const attributes = this.checkAttributes(productType, rawAttributes);
    const prepared = await this.variantService.prepare({ isTaxable: isTaxable ?? false, productType }, variants);
    return this.auditService.record(
      async (tx) => {
        const product = await this.productsRepository.create(
          { ...rest, productType: { connect: { id: productType.id } }, attributes, isTaxable: isTaxable ?? false },
          { category: true, subcategory: true },
          tx,
        );
        await this.variantService.insertPrepared(tx, product.id, prepared, actorId);
        return product;
      },
      (product) => ({
        entity: 'Product',
        entityId: product.id,
        action: 'CREATE',
        userId: actorId,
        details: { after: fieldValues(product, AUDITED_PRODUCT_FIELDS), variants: prepared.length },
      }),
    );
  }

  /** Updates a product. Turning tax on or off reprices its variants (from their basePrice) in the same transaction. */
  async update(id: string, updateProductInput: UpdateProductInput, actorId: string): Promise<Product> {
    const existing = await this.productsRepository.findById(id);
    if (!existing) throw new NotFoundException('Product not found');
    await this.validateProductInput({ ...updateProductInput, id });
    // eslint-disable-next-line @typescript-eslint/no-unused-vars -- type and attributes are validated by retype
    const { productTypeId, attributes, ...rest } = updateProductInput;
    const updateData: Prisma.ProductUpdateInput = { ...rest };
    const retyped = await this.retype(existing, updateProductInput, updateData);
    const reprice = rest.isTaxable !== undefined && rest.isTaxable !== existing.isTaxable;
    const rate = reprice ? await this.taxService.getTotalActiveRate() : undefined;
    return this.auditService.record(
      async (tx) => {
        for (const variant of retyped) await this.productsRepository.updateVariantOptions(variant, tx);
        if (rate !== undefined)
          await this.productsRepository.repriceVariants(id, rest.isTaxable ? rate : new Prisma.Decimal(0), tx);
        return this.productsRepository.update(id, updateData, { category: true, subcategory: true }, tx);
      },
      (updated) => ({
        entity: 'Product',
        entityId: id,
        action: 'UPDATE',
        userId: actorId,
        details: { changes: fieldChanges(existing, updated, Object.keys(updateData) as (keyof Product)[]) },
      }),
    );
  }

  /** Deletes a product no cart or order refers to, with its variants and their stock movements. */
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

  /**
   * Validates a new type and/or attribute map and adds them to `updateData`. A product changes type only if each of
   * its variants' option values is valid for the new type; returns the variants with their re-normalised options.
   */
  private async retype(
    existing: Product,
    input: UpdateProductInput,
    updateData: Prisma.ProductUpdateInput,
  ): Promise<VariantOptions[]> {
    if (input.productTypeId === undefined && input.attributes === undefined) return [];
    const changesType = input.productTypeId !== undefined && input.productTypeId !== existing.productTypeId;
    const productType = await this.findProductType(input.productTypeId ?? existing.productTypeId);
    updateData.attributes = this.checkAttributes(productType, input.attributes ?? existing.attributes);
    if (!changesType) return [];
    updateData.productType = { connect: { id: productType.id } };
    const variants = await this.productsRepository.findVariantOptions(existing.id);
    return variants.map((variant) => {
      const checked = checkOptionValues(productType.attributes, variant.optionValues);
      if (!checked.ok) {
        throw new BadRequestException(
          `Variant "${variant.id}" does not fit product type "${productType.key}": ${describeProblems(checked.problems)}`,
        );
      }
      return { id: variant.id, optionValues: checked.value.values, optionsKey: checked.value.optionsKey };
    });
  }

  private async findProductType(id: string): Promise<ProductTypeWithAttributes> {
    const productType = await this.productTypesRepository.findById(id);
    if (!productType) throw new NotFoundException(`Product type "${id}" not found`);
    return productType;
  }

  private checkAttributes(productType: ProductTypeWithAttributes, attributes: unknown): Prisma.InputJsonObject {
    const checked = checkProductAttributes(productType.attributes, attributes);
    if (!checked.ok) {
      throw new BadRequestException(
        `Invalid attributes for product type "${productType.key}": ${describeProblems(checked.problems)}`,
      );
    }
    return checked.value;
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
      brand,
      categoryName,
      subCategoryName,
      tagId,
      tagName,
    } = filter;
    return {
      ...(categoryName && { category: { name: { equals: categoryName, mode: 'insensitive' } } }),
      ...(subCategoryName && { subcategory: { name: { equals: subCategoryName, mode: 'insensitive' } } }),
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
      ...(this.variantFilter(filter) && { variants: { some: this.variantFilter(filter) } }),
      ...(brand && { brand: { name: { equals: brand, mode: 'insensitive' } } }),
      ...(tagId && { tags: { some: { id: { equals: tagId } } } }),
      ...(tagName && { tags: { some: { name: { equals: tagName, mode: 'insensitive' } } } }),
    };
  }

  /** One active variant must match every price/stock condition, so the filters run on variants in SQL. */
  private variantFilter({ priceMin, priceMax, inStock }: ProductFilterArgs): Prisma.VariantWhereInput | undefined {
    if (priceMin === undefined && priceMax === undefined && inStock !== true) return undefined;
    return {
      isActive: true,
      ...((priceMin !== undefined || priceMax !== undefined) && {
        price: { ...(priceMin !== undefined && { gte: priceMin }), ...(priceMax !== undefined && { lte: priceMax }) },
      }),
      ...(inStock === true && { quantity: { gt: 0 } }),
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
