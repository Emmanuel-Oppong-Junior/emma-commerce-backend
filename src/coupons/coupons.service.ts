import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { Coupon, Prisma } from '@prisma/client';
import { CouponsRepository } from './coupons.repository';
import { CreateCouponInput } from './dto/create-coupon.input';
import { UpdateCouponInput } from './dto/update-coupon.input';

@Injectable()
export class CouponsService {
  constructor(private readonly couponsRepository: CouponsRepository) {}

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

  async deleteCoupon(id: string): Promise<Coupon> {
    return this.couponsRepository.delete(id);
  }

  async findAll(): Promise<Coupon[]> {
    return this.couponsRepository.findAll();
  }

  async findOne(id: string): Promise<Coupon> {
    return this.findCouponOrThrow(id);
  }

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

  async recordUsage(tx: Prisma.TransactionClient, couponId: string, userId: string, orderId: string): Promise<void> {
    await this.couponsRepository.recordUsage(tx, couponId, userId, orderId);
  }

  private async findCouponOrThrow(id: string): Promise<Coupon> {
    const coupon = await this.couponsRepository.findById(id);
    if (!coupon) throw new NotFoundException(`Coupon "${id}" not found`);
    return coupon;
  }
}
