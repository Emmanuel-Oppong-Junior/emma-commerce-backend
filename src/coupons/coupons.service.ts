import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { Coupon, Prisma } from '@prisma/client';
import { CouponsRepository } from './coupons.repository';
import { CreateCouponInput } from './dto/create-coupon.input';
import { UpdateCouponInput } from './dto/update-coupon.input';

@Injectable()
export class CouponsService {
  constructor(private readonly couponsRepository: CouponsRepository) {}

  /**
   * Creates a new coupon with the provided settings.
   * @param input - Coupon creation data including code, type, value, and usage limits.
   * @returns The created coupon.
   */
  async createCoupon(input: CreateCouponInput): Promise<Coupon> {
    return this.couponsRepository.create({
      code: input.code.toUpperCase(),
      discountType: input.discountType,
      value: input.value,
      usageLimit: input.usageLimit,
      expiresAt: input.expiresAt,
      isActive: input.isActive ?? true,
      minimumOrderAmount: input.minimumOrderAmount,
    });
  }

  /**
   * Updates an existing coupon by ID with the provided data.
   * @param id - The ID of the coupon to update.
   * @param input - Partial coupon data to apply.
   * @returns The updated coupon.
   * @throws NotFoundException if the coupon does not exist.
   */
  async updateCoupon(id: string, input: UpdateCouponInput): Promise<Coupon> {
    await this.findCouponOrThrow(id);
    return this.couponsRepository.update(id, {
      ...(input.code && { code: input.code.toUpperCase() }),
      discountType: input.discountType,
      value: input.value,
      usageLimit: input.usageLimit,
      expiresAt: input.expiresAt,
      isActive: input.isActive,
      minimumOrderAmount: input.minimumOrderAmount,
    });
  }

  /**
   * Deletes a coupon by ID.
   * @param id - The ID of the coupon to delete.
   * @returns The deleted coupon.
   */
  async deleteCoupon(id: string): Promise<Coupon> {
    return this.couponsRepository.delete(id);
  }

  /**
   * Retrieves all coupons in the system.
   * @returns List of all coupons.
   */
  async findAll(): Promise<Coupon[]> {
    return this.couponsRepository.findAll();
  }

  /**
   * Retrieves a single coupon by ID.
   * @param id - The ID of the coupon.
   * @returns The coupon.
   * @throws NotFoundException if the coupon does not exist.
   */
  async findOne(id: string): Promise<Coupon> {
    return this.findCouponOrThrow(id);
  }

  /**
   * Validates a coupon code for a given user and order total, enforcing all business rules.
   * @param code - The coupon code to validate.
   * @param userId - The ID of the user applying the coupon.
   * @param orderTotal - The current order subtotal before the discount.
   * @returns The calculated discount amount and the coupon record.
   * @throws NotFoundException if the coupon code does not exist.
   * @throws BadRequestException if the coupon is inactive, expired, over its usage limit, or the order total is too low.
   */
  async validateCoupon(
    code: string,
    userId: string,
    orderTotal: number,
  ): Promise<{ discountAmount: number; coupon: Coupon }> {
    const coupon = await this.couponsRepository.findByCode(code.toUpperCase());
    if (!coupon) throw new NotFoundException(`Coupon code "${code}" not found`);
    if (!coupon.isActive) throw new BadRequestException('This coupon is no longer active');
    if (coupon.expiresAt && coupon.expiresAt < new Date()) throw new BadRequestException('This coupon has expired');
    if (coupon.usageLimit !== null && coupon.usageLimit !== undefined && coupon.usedCount >= coupon.usageLimit) {
      throw new BadRequestException('This coupon has reached its usage limit');
    }
    if (coupon.minimumOrderAmount && orderTotal < Number(coupon.minimumOrderAmount)) {
      throw new BadRequestException(`Order total must be at least ${coupon.minimumOrderAmount} to use this coupon`);
    }
    const alreadyUsed = await this.couponsRepository.hasUserUsedCoupon(coupon.id, userId);
    if (alreadyUsed) throw new BadRequestException('You have already used this coupon');

    const discountAmount =
      coupon.discountType === 'PERCENTAGE'
        ? (orderTotal * Number(coupon.value)) / 100
        : Math.min(Number(coupon.value), orderTotal);

    return { discountAmount, coupon };
  }

  /**
   * Records a coupon usage event within an existing database transaction.
   * @param tx - The active Prisma transaction client.
   * @param couponId - The ID of the coupon being used.
   * @param userId - The ID of the user using the coupon.
   * @param orderId - The ID of the order the coupon is applied to.
   */
  async recordUsage(tx: Prisma.TransactionClient, couponId: string, userId: string, orderId: string): Promise<void> {
    await this.couponsRepository.recordUsage(tx, couponId, userId, orderId);
  }

  private async findCouponOrThrow(id: string): Promise<Coupon> {
    const coupon = await this.couponsRepository.findById(id);
    if (!coupon) throw new NotFoundException(`Coupon "${id}" not found`);
    return coupon;
  }
}
