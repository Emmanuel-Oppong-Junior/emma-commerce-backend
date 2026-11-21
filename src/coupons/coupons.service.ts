import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { Coupon, Prisma } from '../generated/prisma/client';
import { CouponsRepository } from './coupons.repository';
import { CreateCouponInput } from './dto/create-coupon.input';
import { UpdateCouponInput } from './dto/update-coupon.input';
import { AuditService, fieldChanges, fieldValues } from '../commons/audit.service';
import { CouponNotApplicableError, couponAmount, PricingCoupon } from '../pricing/price';

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
   * Previews a coupon for a given user and order total with the pricing engine's coupon rules.
   * @param code - The coupon code to validate.
   * @param userId - The ID of the user applying the coupon.
   * @param orderTotal - The order subtotal after item discounts, before the coupon.
   * @returns The discount amount, rounded half-up to 2 dp and never above the order total, and the coupon record.
   * @throws NotFoundException if the coupon code does not exist.
   * @throws BadRequestException if the coupon is inactive, expired, over its usage limit, already used by the user, or
   * the order total is too low.
   */
  async validateCoupon(
    code: string,
    userId: string,
    orderTotal: Prisma.Decimal,
  ): Promise<{ discountAmount: Prisma.Decimal; coupon: Coupon }> {
    const { coupon, pricing } = await this.findForPricing(code, userId);
    return { discountAmount: applyCoupon(pricing, orderTotal, new Date()), coupon };
  }

  /**
   * The coupon with the code, as the pricing engine takes it (with whether the user already used it); `db` reads it
   * inside the caller's transaction.
   * @throws NotFoundException if the coupon code does not exist.
   */
  async findForPricing(
    code: string,
    userId: string,
    db?: Prisma.TransactionClient,
  ): Promise<{ coupon: Coupon; pricing: PricingCoupon }> {
    const coupon = await this.couponsRepository.findByCode(code.toUpperCase(), db);
    if (!coupon) throw new NotFoundException(`Coupon code "${code}" not found`);
    const usedByCustomer = await this.couponsRepository.hasUserUsedCoupon(coupon.id, userId, db);
    return {
      coupon,
      pricing: {
        id: coupon.id,
        code: coupon.code,
        discountType: coupon.discountType,
        value: coupon.value,
        minimumOrderAmount: coupon.minimumOrderAmount,
        isActive: coupon.isActive,
        expiresAt: coupon.expiresAt,
        usageLimit: coupon.usageLimit,
        usedCount: coupon.usedCount,
        usedByCustomer,
      },
    };
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

function applyCoupon(coupon: PricingCoupon, orderTotal: Prisma.Decimal, now: Date): Prisma.Decimal {
  try {
    return couponAmount(coupon, orderTotal, now);
  } catch (error) {
    if (error instanceof CouponNotApplicableError) throw new BadRequestException(error.message);
    throw error;
  }
}
