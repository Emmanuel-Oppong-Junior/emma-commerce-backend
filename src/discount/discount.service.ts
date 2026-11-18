import { BadRequestException, ConflictException, Inject, Injectable, NotFoundException } from '@nestjs/common';
import { CACHE_MANAGER } from '@nestjs/cache-manager';
import { Cache } from 'cache-manager';
import { CreateDiscountInput } from './dto/create-discount.input';
import { UpdateDiscountInput } from './dto/update-discount.input';
import { ModifyDiscountItemsInput } from './dto/modify-discount-items.input';
import { CartItem, Discount, Order, OrderItem, OrderStatus, Product, Variant } from '@prisma/client';
import {
  CartItemWithProduct,
  CartWithDiscount,
  CreateOrUpdateDiscountInput,
  DiscountCalculation,
  DiscountConnectInput,
  DiscountConnectionOperation,
  DiscountConnectOrSetInput,
  DiscountSetInput,
  OrderItemWithProduct,
} from './types';
import { DiscountRepository } from './discount.repository';
import { AuditEntry, AuditService, fieldChanges, fieldValues } from '../commons/audit.service';

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
   * Calculates the discounted price for a product or variant.
   * @param productId - The ID of the product.
   * @param variantId - The ID of the variant, if applicable.
   * @returns The discounted price, discount amount, and discount ID (if applicable).
   */
  async getDiscountedPriceForProduct(productId: string, variantId?: string): Promise<DiscountCalculation> {
    const product = await this.getProductOrThrow(productId);
    let price = Number(product.price);

    if (variantId) {
      const variant = await this.getVariantOrThrow(variantId);
      price = variant.price ? Number(variant.price) : price;
    }

    const discounts = await this.getApplicableDiscounts(productId, variantId);
    const bestDiscount = this.selectBestDiscount(discounts);
    return this.getBestDiscountDetails(price, bestDiscount);
  }

  /**
   * Applies discounts to cart items and computes totals.
   * @param cartId - The ID of the cart.
   * @returns The updated cart with applied discounts.
   * @throws NotFoundException if the cart is not found.
   * @throws BadRequestException if minimum purchase requirements are not met.
   */
  async applyDiscountsToCart(cartId: string): Promise<CartWithDiscount> {
    const cart = await this.findCartOrThrow(cartId);
    const { total, discountTotal, updatedItems } = await this.getCartItemCalculations(cart.items);
    const discounts = await this.getApplicableDiscountsForCart(cart.items);
    this.validateMinimumPurchaseRequirements(discounts, total);
    return { ...cart, items: updatedItems, total, discountTotal, finalTotal: total - discountTotal };
  }

  /**
   * Records the applicable discounts on a PENDING order's items without changing what the customer is charged.
   * @throws NotFoundException if the order is not found.
   * @throws ConflictException if the order is deleted or no longer PENDING.
   */
  async finalizeDiscountsForOrder(orderId: string): Promise<Order & { items: OrderItem[] }> {
    const order = await this.findOrderOrThrow(orderId);
    if (order.deleted || order.status !== OrderStatus.PENDING) {
      throw new ConflictException(
        `Discounts can only be finalized on a PENDING order; order "${orderId}" is ${order.deleted ? 'deleted' : order.status}`,
      );
    }
    const { discountTotal } = await this.getOrderItemsCalculation(order.items);
    // Discounts are not charged at checkout yet, so the total keeps the shipping fee and coupon createOrder set.
    return this.discountRepository.updateOrderWithDiscount(orderId, Number(order.totalAmount), discountTotal);
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

  private async getApplicableDiscounts(productId: string, variantId?: string): Promise<Discount[]> {
    const product = await this.discountRepository.findProductWithDiscounts(productId);
    const discounts: Discount[] = product ? [...product.discounts] : [];
    const categoryDiscounts = product?.categoryId
      ? await this.discountRepository.findCategoryDiscounts(product.categoryId)
      : [];
    discounts.push(...categoryDiscounts);

    if (variantId) {
      const variantDiscounts = await this.discountRepository.findVariantDiscounts(variantId);
      discounts.push(...variantDiscounts);
    }

    return discounts;
  }

  private selectBestDiscount(discounts: Discount[]): Discount | null {
    if (!discounts?.length) return null;

    return discounts.reduce((best, current) => {
      const bestValue = Number(best.value);
      const currentValue = Number(current.value);
      if (currentValue > bestValue) return current;

      if (currentValue === bestValue && current.type === 'PERCENTAGE' && best.type === 'FLAT') {
        return current;
      }
      return best;
    }, discounts[0]);
  }

  private calculateDiscountAmount(price: number, discount: Discount): number {
    if (discount.type === 'PERCENTAGE') return (price * Number(discount.value)) / 100;
    return Number(discount.value);
  }

  private async getProductOrThrow(id: string) {
    const product = await this.discountRepository.findProductById(id, { price: true });
    if (!product) throw new NotFoundException(`Product with ID ${id} not found`);
    return product as { price: unknown };
  }

  private async getVariantOrThrow(id: string) {
    const variant = await this.discountRepository.findVariantById(id, { price: true });
    if (!variant) throw new NotFoundException(`Variant with ID ${id} not found`);
    return variant as { price: unknown };
  }

  private getBestDiscountDetails(originalPrice: number, bestDiscount: Discount | null): DiscountCalculation {
    if (!bestDiscount) return { discountedPrice: originalPrice, discountAmount: 0 };
    const discountAmount = this.calculateDiscountAmount(originalPrice, bestDiscount);
    const discountedPrice = Math.max(0, originalPrice - discountAmount);
    return { discountedPrice, discountAmount, discountId: bestDiscount.id };
  }

  private async findCartOrThrow(cartId: string) {
    const cart = await this.discountRepository.findCartById(cartId);
    if (!cart) throw new NotFoundException(`Cart with ID ${cartId} not found`);
    return cart;
  }

  private async getCartItemCalculations(cartItems: CartItemWithProduct[]) {
    let total = 0;
    let discountTotal = 0;
    const updatedItems: CartItem[] = [];

    for (const cartItem of cartItems) {
      const { discountedPrice, discountAmount, discountId } = await this.getDiscountedPriceForProduct(
        cartItem.productId,
        cartItem.variantId ?? undefined,
      );
      total += Number(cartItem.product.price) * cartItem.quantity;
      discountTotal += discountAmount * cartItem.quantity;

      const updatedItem = await this.discountRepository.updateCartItem(cartItem.id, {
        originalPrice: Number(cartItem.product.price),
        discountedPrice,
        discountId,
      });

      updatedItems.push(updatedItem);
    }
    return { total, discountTotal, updatedItems };
  }

  private async getApplicableDiscountsForCart(
    cartItem: (CartItem & {
      product: Product;
      variant?: Variant;
    })[],
  ): Promise<Discount[]> {
    const discountIds = new Set<string>();
    const discounts: Discount[] = [];

    for (const item of cartItem) {
      const itemDiscounts = await this.getApplicableDiscounts(item.productId, item.variantId ?? undefined);
      for (const discount of itemDiscounts) {
        if (!discountIds.has(discount.id)) {
          discountIds.add(discount.id);
          discounts.push(discount);
        }
      }
    }

    return discounts;
  }

  private validateMinimumPurchaseRequirements(discounts: Discount[], total: number) {
    for (const discount of discounts) {
      if (discount.minimumPurchase && total < Number(discount.minimumPurchase)) {
        throw new BadRequestException(
          `Cart total (${total}) does not meet minimum purchase requirement (${discount.minimumPurchase}) for discount ${discount.name}`,
        );
      }
    }
  }

  private async findOrderOrThrow(orderId: string) {
    const order = await this.discountRepository.findOrderById(orderId);
    if (!order) throw new NotFoundException(`Order with ID ${orderId} not found`);
    return order;
  }

  private async getOrderItemsCalculation(orderItems: OrderItemWithProduct[]) {
    let total = 0;
    let discountTotal = 0;
    const updatedItems: OrderItem[] = [];

    for (const orderItem of orderItems) {
      const { discountAmount, discountId } = await this.getDiscountedPriceForProduct(
        orderItem.productId,
        orderItem.variantId ?? undefined,
      );
      total += Number(orderItem.product.price) * orderItem.quantity;
      discountTotal += discountAmount * orderItem.quantity;

      const updatedItem = await this.discountRepository.updateOrderItem(orderItem.id, {
        originalPrice: Number(orderItem.product.price),
        discountAmount,
        discountId,
      });
      updatedItems.push(updatedItem);
    }
    return { total, discountTotal, updatedItems };
  }

  private ensureEndDateComeAfter(input: CreateOrUpdateDiscountInput) {
    if (input.startDate && input.endDate && input.endDate < input.startDate) {
      throw new BadRequestException('End date must be after start date');
    }
  }

  private ensureDiscountInputIsValid(input: CreateOrUpdateDiscountInput) {
    if (input.value !== undefined && input.type !== undefined) {
      if (input.type === 'PERCENTAGE' && input.value > 100) {
        throw new BadRequestException('Percentage discount value cannot exceed 100');
      }
      if (input.value < 0) {
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
