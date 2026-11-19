import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { Coupon, Prisma } from '../generated/prisma/client';
import { CouponsRepository } from './coupons.repository';
import { CreateCouponInput } from './dto/create-coupon.input';
import { UpdateCouponInput } from './dto/update-coupon.input';
import { AuditService, fieldChanges, fieldValues } from '../commons/audit.service';
import { roundHalfUp } from '../commons/money/money';

const AUDITED_COUPON_FIELDS = [
  'code',
  'discountType',
  'value',
  'usageLimit',
  'expiresAt',
  'isActive',
  'minimumOrderAmount',
] as const satisfies readonly (keyof Coupon)[];

@Injectable()
export class CouponsService {
  constructor(
    private readonly couponsRepository: CouponsRepository,
    private readonly auditService: AuditService,
  ) {}

  /**
   * Creates a new coupon with the provided settings.
   * @param input - Coupon creation data including code, type, value, and usage limits.
   * @returns The created coupon.
   */
  async createCoupon(input: CreateCouponInput, actorId: string): Promise<Coupon> {
    return this.auditService.record(
      (tx) =>
        this.couponsRepository.create(
          {
            code: input.code.toUpperCase(),
            discountType: input.discountType,
            value: input.value,
            usageLimit: input.usageLimit,
            expiresAt: input.expiresAt,
            isActive: input.isActive ?? true,
            minimumOrderAmount: input.minimumOrderAmount,
          },
          tx,
        ),
      (coupon) => ({
        entity: 'Coupon',
        entityId: coupon.id,
        action: 'CREATE',
        userId: actorId,
        details: { after: fieldValues(coupon, AUDITED_COUPON_FIELDS) },
      }),
    );
  }

  /**
   * Updates an existing coupon by ID with the provided data.
   * @param id - The ID of the coupon to update.
   * @param input - Partial coupon data to apply.
   * @returns The updated coupon.
   * @throws NotFoundException if the coupon does not exist.
   */
  async updateCoupon(id: string, input: UpdateCouponInput, actorId: string): Promise<Coupon> {
    const existing = await this.findCouponOrThrow(id);
    return this.auditService.record(
      (tx) =>
        this.couponsRepository.update(
          id,
          {
            ...(input.code && { code: input.code.toUpperCase() }),
            discountType: input.discountType,
            value: input.value,
            usageLimit: input.usageLimit,
            expiresAt: input.expiresAt,
            isActive: input.isActive,
            minimumOrderAmount: input.minimumOrderAmount,
          },
          tx,
        ),
      (updated) => ({
        entity: 'Coupon',
        entityId: id,
        action: 'UPDATE',
        userId: actorId,
        details: { changes: fieldChanges(existing, updated, AUDITED_COUPON_FIELDS) },
      }),
    );
  }

  /**
   * Deletes a coupon by ID.
   * @param id - The ID of the coupon to delete.
   * @returns The deleted coupon.
   */
  async deleteCoupon(id: string, actorId: string): Promise<Coupon> {
    return this.auditService.record(
      (tx) => this.couponsRepository.delete(id, tx),
      (deleted) => ({
        entity: 'Coupon',
        entityId: id,
        action: 'DELETE',
        userId: actorId,
        details: { before: fieldValues(deleted, AUDITED_COUPON_FIELDS) },
      }),
    );
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
   * @returns The discount amount, rounded half-up to 2 dp, and the coupon record.
   * @throws NotFoundException if the coupon code does not exist.
   * @throws BadRequestException if the coupon is inactive, expired, over its usage limit, or the order total is too low.
   */
  async validateCoupon(
    code: string,
    userId: string,
    orderTotal: Prisma.Decimal,
  ): Promise<{ discountAmount: Prisma.Decimal; coupon: Coupon }> {
    const coupon = await this.couponsRepository.findByCode(code.toUpperCase());
    if (!coupon) throw new NotFoundException(`Coupon code "${code}" not found`);
    if (!coupon.isActive) throw new BadRequestException('This coupon is no longer active');
    if (coupon.expiresAt && coupon.expiresAt < new Date()) throw new BadRequestException('This coupon has expired');
    if (coupon.usageLimit !== null && coupon.usageLimit !== undefined && coupon.usedCount >= coupon.usageLimit) {
      throw new BadRequestException('This coupon has reached its usage limit');
    }
    if (coupon.minimumOrderAmount && orderTotal.lt(coupon.minimumOrderAmount)) {
      throw new BadRequestException(`Order total must be at least ${coupon.minimumOrderAmount} to use this coupon`);
    }
    const alreadyUsed = await this.couponsRepository.hasUserUsedCoupon(coupon.id, userId);
    if (alreadyUsed) throw new BadRequestException('You have already used this coupon');

    const discountAmount = roundHalfUp(
      coupon.discountType === 'PERCENTAGE'
        ? orderTotal.mul(coupon.value).div(100)
        : Prisma.Decimal.min(coupon.value, orderTotal),
    );

    return { discountAmount, coupon };
  }

  /**
   * Records a coupon usage event within an existing database transaction, re-checking the coupon there.
   * @param tx - The active Prisma transaction client.
   * @param couponId - The ID of the coupon being used.
   * @param userId - The ID of the user using the coupon.
   * @param orderId - The ID of the order the coupon is applied to.
   * @throws BadRequestException if the coupon became inactive, expired or used up since it was validated.
   */
  async recordUsage(tx: Prisma.TransactionClient, couponId: string, userId: string, orderId: string): Promise<void> {
    // The increment locks the coupon row, so the count read back includes every committed use and concurrent
    // checkouts queue here instead of all passing the earlier validateCoupon check. Throwing rolls the order back.
    const coupon = await this.couponsRepository.recordUsage(tx, couponId, userId, orderId);
    if (!coupon.isActive) throw new BadRequestException('This coupon is no longer active');
    if (coupon.expiresAt && coupon.expiresAt < new Date()) throw new BadRequestException('This coupon has expired');
    if (coupon.usageLimit !== null && coupon.usedCount > coupon.usageLimit) {
      throw new BadRequestException('This coupon has reached its usage limit');
    }
  }

  /**
   * Gives back the coupon use recorded for an order (when it is cancelled or expires), within the caller's transaction.
   * @param tx - The active Prisma transaction client.
   * @param orderId - The ID of the order whose coupon use is released.
   */
  async releaseUsage(tx: Prisma.TransactionClient, orderId: string): Promise<void> {
    await this.couponsRepository.releaseUsage(tx, orderId);
  }

  private async findCouponOrThrow(id: string): Promise<Coupon> {
    const coupon = await this.couponsRepository.findById(id);
    if (!coupon) throw new NotFoundException(`Coupon "${id}" not found`);
    return coupon;
  }
}
