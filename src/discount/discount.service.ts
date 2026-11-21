import { BadRequestException, Inject, Injectable, NotFoundException } from '@nestjs/common';
import { CACHE_MANAGER } from '@nestjs/cache-manager';
import { Cache } from 'cache-manager';
import { CreateDiscountInput } from './dto/create-discount.input';
import { UpdateDiscountInput } from './dto/update-discount.input';
import { ModifyDiscountItemsInput } from './dto/modify-discount-items.input';
import { Discount, Prisma } from '../generated/prisma/client';
import {
  CreateOrUpdateDiscountInput,
  DiscountConnectInput,
  DiscountConnectionOperation,
  DiscountConnectOrSetInput,
  DiscountSetInput,
} from './types';
import { DiscountRepository } from './discount.repository';
import { AuditEntry, AuditService, fieldChanges, fieldValues } from '../commons/audit.service';
import { PricingDiscount } from '../pricing/price';

const DISCOUNT_ALL_KEY = 'discount:all';
const discountKey = (id: string) => `discount:${id}`;
const AUDITED_DISCOUNT_FIELDS = [
  'name',
  'type',
  'value',
  'startDate',
  'endDate',
  'isActive',
  'minimumPurchase',
] as const satisfies readonly (keyof Discount)[];

function discountTargets(input: { products?: string[]; variants?: string[]; categories?: string[] }) {
  return {
    ...(input.products && { products: input.products }),
    ...(input.variants && { variants: input.variants }),
    ...(input.categories && { categories: input.categories }),
  };
}

function discountItemsChange(
  input: ModifyDiscountItemsInput,
  operation: 'add' | 'remove',
  actorId: string,
): AuditEntry {
  return {
    entity: 'Discount',
    entityId: input.discountId,
    action: 'UPDATE',
    userId: actorId,
    details: { [operation]: discountTargets(input) },
  };
}

/** A variant with what decides which discounts apply to it. */
export interface DiscountableVariant {
  id: string;
  productId: string;
  categoryId: string | null;
  discountId: string | null;
}

@Injectable()
export class DiscountService {
  constructor(
    private readonly discountRepository: DiscountRepository,
    @Inject(CACHE_MANAGER) private readonly cacheManager: Cache,
    private readonly auditService: AuditService,
  ) {}

  /**
   * Creates a new discount with the provided input.
   * Enforces business rules and establishes relationships with products, variants, or categories.
   * @param input - The input data for creating a discount.
   * @returns The created discount.
   * @throws BadRequestException if business rules are violated.
   */
  async createDiscount(input: CreateDiscountInput, actorId: string): Promise<Discount> {
    await this.validateDiscountInput(input);
    const connectData = this.prepareDiscountConnectionData(input, 'connect') as DiscountConnectInput;
    const discount = await this.auditService.record(
      (tx) =>
        this.discountRepository.create(
          {
            name: input.name,
            description: input.description,
            type: input.type,
            value: input.value,
            startDate: input.startDate,
            endDate: input.endDate,
            isActive: input.isActive ?? false,
            minimumPurchase: input.minimumPurchase,
            products: connectData.products,
            variants: connectData.variants,
            categories: connectData.categories,
          },
          tx,
        ),
      (created) => ({
        entity: 'Discount',
        entityId: created.id,
        action: 'CREATE',
        userId: actorId,
        details: { after: fieldValues(created, AUDITED_DISCOUNT_FIELDS), ...discountTargets(input) },
      }),
    );
    await this.cacheManager.del(DISCOUNT_ALL_KEY);
    return discount;
  }

  /**
   * Updates an existing discount with the provided input.
   * Supports partial updates and enforces business rules.
   * @param id
   * @param input - The input data for updating a discount, including the discount ID.
   * @returns The updated discount.
   * @throws NotFoundException if the discount is not found.
   * @throws BadRequestException if business rules are violated.
   */
  async updateDiscount(id: string, input: UpdateDiscountInput, actorId: string): Promise<Discount> {
    const existing = await this.findDiscountOrThrow(id);
    await this.validateDiscountInput(input, true);
    const connectData = this.prepareDiscountConnectionData(input, 'set') as DiscountSetInput;
    const updated = await this.auditService.record(
      (tx) =>
        this.discountRepository.update(
          id,
          {
            name: input.name,
            description: input.description,
            type: input.type,
            value: input.value,
            startDate: input.startDate,
            endDate: input.endDate,
            isActive: input.isActive,
            minimumPurchase: input.minimumPurchase,
            products: connectData.products,
            variants: connectData.variants,
            categories: connectData.categories,
          },
          tx,
        ),
      (after) => ({
        entity: 'Discount',
        entityId: id,
        action: 'UPDATE',
        userId: actorId,
        details: { changes: fieldChanges(existing, after, AUDITED_DISCOUNT_FIELDS), ...discountTargets(input) },
      }),
    );
    await Promise.all([this.cacheManager.del(DISCOUNT_ALL_KEY), this.cacheManager.del(discountKey(id))]);
    return updated;
  }

  /**
   * Retrieves all discounts.
   * @returns A list of all discounts.
   */
  async findAllDiscounts(): Promise<Discount[]> {
    const cached = await this.cacheManager.get<Discount[]>(DISCOUNT_ALL_KEY);
    if (cached) return cached;
    const discounts = await this.discountRepository.findAll();
    await this.cacheManager.set(DISCOUNT_ALL_KEY, discounts);
    return discounts;
  }

  /**
   * Retrieves a single discount by ID.
   * @param id - The ID of the discount to retrieve.
   * @returns The discount with the specified ID.
   * @throws NotFoundException if the discount is not found.
   */
  async findOneDiscount(id: string): Promise<Discount> {
    const cached = await this.cacheManager.get<Discount>(discountKey(id));
    if (cached) return cached;
    const discount = await this.findDiscountOrThrow(id);
    await this.cacheManager.set(discountKey(id), discount);
    return discount;
  }

  /**
   * Adds products, variants, or categories to an existing discount.
   * @param input - The discount ID and IDs to add.
   * @returns The updated discount.
   */
  async addToDiscount(input: ModifyDiscountItemsInput, actorId: string): Promise<Discount> {
    await this.findDiscountOrThrow(input.discountId);
    if (input.products?.length) await this.ensureProductsExist(input);
    if (input.variants?.length) await this.ensureVariantsExist(input);
    if (input.categories?.length) await this.ensureCategoriesExist(input);

    const updated = await this.auditService.record(
      (tx) =>
        this.discountRepository.addItemsToDiscount(
          input.discountId,
          {
            products: input.products?.length ? { connect: input.products.map((id) => ({ id })) } : undefined,
            variants: input.variants?.length ? { connect: input.variants.map((id) => ({ id })) } : undefined,
            categories: input.categories?.length ? { connect: input.categories.map((id) => ({ id })) } : undefined,
          },
          tx,
        ),
      () => discountItemsChange(input, 'add', actorId),
    );
    await Promise.all([this.cacheManager.del(DISCOUNT_ALL_KEY), this.cacheManager.del(discountKey(input.discountId))]);
    return updated;
  }

  /**
   * Removes products, variants, or categories from an existing discount.
   * @param input - The discount ID and IDs to remove.
   * @returns The updated discount.
   */
  async removeFromDiscount(input: ModifyDiscountItemsInput, actorId: string): Promise<Discount> {
    await this.findDiscountOrThrow(input.discountId);

    const updated = await this.auditService.record(
      (tx) =>
        this.discountRepository.removeItemsFromDiscount(
          input.discountId,
          {
            products: input.products?.length ? { disconnect: input.products.map((id) => ({ id })) } : undefined,
            variants: input.variants?.length ? { disconnect: input.variants.map((id) => ({ id })) } : undefined,
            categories: input.categories?.length ? { disconnect: input.categories.map((id) => ({ id })) } : undefined,
          },
          tx,
        ),
      () => discountItemsChange(input, 'remove', actorId),
    );
    await Promise.all([this.cacheManager.del(DISCOUNT_ALL_KEY), this.cacheManager.del(discountKey(input.discountId))]);
    return updated;
  }

  /**
   * Deletes a discount by ID.
   * @param id - The ID of the discount to delete.
   * @returns The deleted discount.
   * @throws NotFoundException if the discount is not found.
   */
  async deleteDiscount(id: string, actorId: string): Promise<Discount> {
    await this.findDiscountOrThrow(id);
    const deleted = await this.auditService.record(
      (tx) => this.discountRepository.delete(id, tx),
      (before) => ({
        entity: 'Discount',
        entityId: id,
        action: 'DELETE',
        userId: actorId,
        details: { before: fieldValues(before, AUDITED_DISCOUNT_FIELDS) },
      }),
    );
    await Promise.all([this.cacheManager.del(DISCOUNT_ALL_KEY), this.cacheManager.del(discountKey(id))]);
    return deleted;
  }

  /**
   * The discounts that may apply to the variants at `now`, as the pricing engine takes them: active, in date, and
   * targeting one of the variants (its own discount), their products or their categories. Which applies to which
   * line is the engine's decision.
   */
  async findCandidateDiscounts(
    variants: DiscountableVariant[],
    now: Date,
    db?: Prisma.TransactionClient,
  ): Promise<PricingDiscount[]> {
    if (variants.length === 0) return [];
    const unique = <T>(values: (T | null)[]) => [...new Set(values.filter((value): value is T => value !== null))];
    const discounts = await this.discountRepository.findActiveDiscountsFor(
      unique(variants.map((variant) => variant.productId)),
      unique(variants.map((variant) => variant.categoryId)),
      unique(variants.map((variant) => variant.discountId)),
      now,
      db,
    );
    return discounts.map((discount) => ({
      id: discount.id,
      type: discount.type,
      value: discount.value,
      minimumPurchase: discount.minimumPurchase,
      isActive: discount.isActive,
      startDate: discount.startDate,
      endDate: discount.endDate,
      createdAt: discount.createdAt,
      variantIds: variants.filter((variant) => variant.discountId === discount.id).map((variant) => variant.id),
      productIds: discount.products.map(({ id }) => id),
      categoryIds: discount.categories.map(({ id }) => id),
    }));
  }

  private async validateDiscountInput(input: CreateOrUpdateDiscountInput, isUpdate = false): Promise<void> {
    this.ensureEndDateComeAfter(input);
    this.ensureDiscountInputIsValid(input);

    if (input.products?.length) await this.ensureProductsExist(input);
    if (input.variants?.length) await this.ensureVariantsExist(input);
    if (input.categories?.length) await this.ensureCategoriesExist(input);

    if (isUpdate) this.ensureUpdateInputNotEmpty(input as UpdateDiscountInput);
  }

  private prepareDiscountConnectionData(
    input: CreateOrUpdateDiscountInput,
    operation: DiscountConnectionOperation,
  ): DiscountConnectOrSetInput {
    return {
      products: input.products?.length ? { [operation]: input.products.map((id) => ({ id })) } : undefined,
      variants: input.variants?.length ? { [operation]: input.variants.map((id) => ({ id })) } : undefined,
      categories: input.categories?.length ? { [operation]: input.categories.map((id) => ({ id })) } : undefined,
    };
  }

  private async findDiscountOrThrow(id: string): Promise<Discount> {
    const discount = await this.discountRepository.findById(id);
    if (!discount) throw new NotFoundException(`Discount with ID ${id} not found`);
    return discount;
  }

  private ensureEndDateComeAfter(input: CreateOrUpdateDiscountInput) {
    if (input.startDate && input.endDate && input.endDate < input.startDate) {
      throw new BadRequestException('End date must be after start date');
    }
  }

  private ensureDiscountInputIsValid(input: CreateOrUpdateDiscountInput) {
    if (input.value !== undefined && input.type !== undefined) {
      if (input.type === 'PERCENTAGE' && input.value.gt(100)) {
        throw new BadRequestException('Percentage discount value cannot exceed 100');
      }
      if (input.value.isNegative()) {
        throw new BadRequestException('Discount value must be non-negative');
      }
    }
  }

  private async ensureProductsExist(input: { products?: string[] }) {
    const invalidIds = await this.discountRepository.getInvalidIds(input.products ?? [], 'product');
    if (invalidIds.length) throw new BadRequestException(`Invalid product IDs: ${invalidIds.join(', ')}`);
  }

  private async ensureVariantsExist(input: { variants?: string[] }) {
    const invalidIds = await this.discountRepository.getInvalidIds(input.variants ?? [], 'variant');
    if (invalidIds.length) throw new BadRequestException(`Invalid variant IDs: ${invalidIds.join(', ')}`);
  }

  private async ensureCategoriesExist(input: { categories?: string[] }) {
    const invalidIds = await this.discountRepository.getInvalidIds(input.categories ?? [], 'category');
    if (invalidIds.length) throw new BadRequestException(`Invalid category IDs: ${invalidIds.join(', ')}`);
  }

  private ensureUpdateInputNotEmpty(input: UpdateDiscountInput) {
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    const { id, ...updateFields } = input;
    const fields = updateFields as Record<string, unknown>;
    if (Object.keys(fields).every((key) => fields[key] === undefined)) {
      throw new BadRequestException('At least one field must be provided for update');
    }
  }
}
