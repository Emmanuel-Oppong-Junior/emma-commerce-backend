import { BadRequestException, ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { CreateProductInput } from './dto/create-product.input';
import { UpdateProductInput } from './dto/update-product.input';
import { ProductFilterArgs } from './dto/product-filter.args';
import { ProductSortArgs } from './dto/product-sort.args';
import { PriceChangeSource, Prisma, Product } from '../generated/prisma/client';
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
import { LotsService } from '../inventory/lots/lots.service';
import { SerialUnitsService } from '../inventory/serials/serial-units.service';
import { assertNoSerialisedOpeningStock } from '../inventory/serials/serial-rules';
import { ProductFacets, ProductSearch, SearchVisibility } from './search/product-search.port';
import { searchFiltersProblem, toSearchFilters, toSearchRequest } from './search/product-search-request';

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
  'serialFormat',
  'warrantyMonths',
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
    private readonly lots: LotsService,
    private readonly serialUnits: SerialUnitsService,
    private readonly productSearch: ProductSearch,
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
    assertNoSerialisedOpeningStock(rest.trackSerials ?? false, variants);
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

  /**
   * Updates a product. Turning tax on or off reprices its variants (from their basePrice) in the same transaction.
   * Lot tracking (trackLots) switches only while the product holds no stock (P4-C.1). Serial tracking turns on only
   * while the product has no untracked stock, and off only while none of its serial units is in stock, assigned or in
   * transit (trackSerialsChangeProblem).
   */
  async update(id: string, updateProductInput: UpdateProductInput, actorId: string): Promise<Product> {
    const existing = await this.productsRepository.findById(id);
    if (!existing) throw new NotFoundException('Product not found');
    await this.validateProductInput({ ...updateProductInput, id });
    // eslint-disable-next-line @typescript-eslint/no-unused-vars -- type and attributes are validated by retype
    const { productTypeId, attributes, priceChangeReason, ...rest } = updateProductInput;
    const updateData: Prisma.ProductUpdateInput = { ...rest };
    const retyped = await this.retype(existing, updateProductInput, updateData);
    const reprice = rest.isTaxable !== undefined && rest.isTaxable !== existing.isTaxable;
    const retrack = rest.trackSerials !== undefined && rest.trackSerials !== existing.trackSerials;
    const rate = reprice ? await this.taxService.getTotalActiveRate() : undefined;
    const trackLots = rest.trackLots;
    const switchesLots = typeof trackLots === 'boolean' && trackLots !== existing.trackLots;
    return this.auditService.record(
      async (tx) => {
        if (switchesLots) await this.lots.assertTrackingChange(tx, id, trackLots);
        if (retrack) await this.serialUnits.assertTrackingChange(tx, id, rest.trackSerials!);
        for (const variant of retyped) await this.productsRepository.updateVariantOptions(variant, tx);
        if (rate !== undefined)
          await this.productsRepository.repriceVariants(
            id,
            rest.isTaxable ? rate : new Prisma.Decimal(0),
            { source: PriceChangeSource.ADMIN_EDIT, actorId, reason: priceChangeReason ?? null },
            tx,
          );
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
    return this.searchPage('ADMIN', paginate, filter, sort, requestedData);
  }

  /** Public list: only active, PUBLISHED products, whatever isActive/status the filter carries. */
  async findAllPublished(
    paginate: PaginationArgs,
    filter: ProductFilterArgs = {},
    sort: ProductSortArgs = {},
    requestedData?: Prisma.ProductSelect,
  ): Promise<ProductConnection> {
    return this.searchPage('PUBLIC', paginate, filter, sort, requestedData);
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

  /** Facet counts for the public list with these filters. */
  async findPublishedFacets(filter: ProductFilterArgs = {}): Promise<ProductFacets> {
    const filters = toSearchFilters(filter, 'PUBLIC');
    const problem = searchFiltersProblem(filters);
    if (problem) throw new BadRequestException(problem);
    return this.productSearch.facets(filters);
  }

  /** The search port picks and orders the page; the products are then loaded with the requested fields. */
  private async searchPage(
    visibility: SearchVisibility,
    paginate: PaginationArgs,
    filter: ProductFilterArgs,
    sort: ProductSortArgs,
    requestedData?: Prisma.ProductSelect,
  ): Promise<ProductConnection> {
    const request = toSearchRequest(visibility, paginate, filter, sort);
    const problem = searchFiltersProblem(request.filters);
    if (problem) throw new BadRequestException(problem);
    const page = await this.productSearch.search(request);
    const products = await this.productsRepository.findManyByIds(
      page.items.map((item) => item.id),
      requestedData,
    );
    const byId = new Map(products.map((product) => [product.id, product]));
    // A product deleted between the two reads drops out of the page.
    const edges = page.items.flatMap((item) => {
      const node = byId.get(item.id);
      return node ? [{ cursor: item.cursor, node }] : [];
    });
    return {
      edges: edges as ProductConnection['edges'],
      pageInfo: {
        pageSize: request.first,
        hasPreviousPage: request.after !== undefined,
        hasNextPage: page.hasNextPage,
        totalCount: page.totalCount,
      },
    };
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
