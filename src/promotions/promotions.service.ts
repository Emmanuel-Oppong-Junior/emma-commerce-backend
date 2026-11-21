import { BadRequestException, ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { CouponCode, Prisma, Promotion, PromotionScope } from '../generated/prisma/client';
import { AuditService, fieldChanges, fieldValues } from '../commons/audit.service';
import { couponCodeRejection, PricingCouponCode, PricingCustomer, PricingPromotion } from '../pricing/price';
import { CreatePromotionInput, UpdatePromotionInput } from './dto/promotion.input';
import { CreateCouponCodeInput, UpdateCouponCodeInput } from './dto/coupon-code.input';
import { promotionDefinitionError } from './promotion-definition';
import {
  CartTargets,
  PromotionsRepository,
  PromotionWithRelations,
  PromotionWithTargets,
  RedemptionFilter,
  TARGET_RELATION,
  targetWrites,
} from './promotions.repository';
import { CouponCodeValidation, Promotion as PromotionEntity, RedemptionPage } from './entities/promotion.entity';

/** `extensions.reason` of the CONFLICT createOrder fails with when a promotion or coupon code has no use left. */
export const PROMOTION_LIMIT_REACHED = 'PROMOTION_LIMIT_REACHED';
/** `extensions.reason` of the CONFLICT createOrder fails with when the customer used up their uses of a promotion. */
export const PROMOTION_CUSTOMER_LIMIT_REACHED = 'PROMOTION_CUSTOMER_LIMIT_REACHED';

const AUDITED_PROMOTION_FIELDS = [
  'name',
  'description',
  'scope',
  'type',
  'value',
  'minimumSpend',
  'minimumQuantity',
  'startsAt',
  'endsAt',
  'isActive',
  'priority',
  'stackingGroup',
  'exclusive',
  'requiresCoupon',
  'usageLimit',
  'perCustomerLimit',
] as const satisfies readonly (keyof Promotion)[];

const AUDITED_COUPON_CODE_FIELDS = [
  'code',
  'promotionId',
  'isActive',
  'usageLimit',
] as const satisfies readonly (keyof CouponCode)[];

const REQUIRED_PROMOTION_FIELDS = [
  'name',
  'scope',
  'type',
  'value',
  'startsAt',
  'isActive',
  'priority',
  'stackingGroup',
  'exclusive',
  'requiresCoupon',
] as const satisfies readonly (keyof UpdatePromotionInput)[];

/** The targets of the promotion's scope (variant, product, category or brand ids); none for CART. */
export function targetIdsOf(promotion: PromotionWithTargets): string[] {
  const relation = TARGET_RELATION[promotion.scope];
  return relation ? promotion[relation].map(({ id }) => id) : [];
}

export function toPricingPromotion(promotion: PromotionWithTargets): PricingPromotion {
  return {
    id: promotion.id,
    name: promotion.name,
    description: promotion.description,
    scope: promotion.scope,
    type: promotion.type,
    value: promotion.value,
    minimumSpend: promotion.minimumSpend,
    minimumQuantity: promotion.minimumQuantity,
    startsAt: promotion.startsAt,
    endsAt: promotion.endsAt,
    isActive: promotion.isActive,
    priority: promotion.priority,
    stackingGroup: promotion.stackingGroup,
    exclusive: promotion.exclusive,
    requiresCoupon: promotion.requiresCoupon,
    usageLimit: promotion.usageLimit,
    usedCount: promotion.usedCount,
    perCustomerLimit: promotion.perCustomerLimit,
    createdAt: promotion.createdAt,
    targetIds: targetIdsOf(promotion),
  };
}

function toEntity(promotion: PromotionWithRelations): PromotionEntity {
  // The relation arrays ride along unused: GraphQL serialises only the entity's fields.
  return { ...promotion, targetIds: targetIdsOf(promotion) };
}

function toPricingCouponCode(couponCode: CouponCode): PricingCouponCode {
  return {
    id: couponCode.id,
    code: couponCode.code,
    promotionId: couponCode.promotionId,
    isActive: couponCode.isActive,
    usageLimit: couponCode.usageLimit,
    usedCount: couponCode.usedCount,
  };
}

function limitReached(message: string, reason: string): ConflictException {
  return new ConflictException({ message, extensions: { reason } });
}

function isUniqueViolation(error: unknown): boolean {
  return error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002';
}

/** What the pricing engine needs from promotions for one cart and customer. */
export interface PromotionPricingFacts {
  promotions: PricingPromotion[];
  couponCode?: PricingCouponCode;
  customer: PricingCustomer;
}

@Injectable()
export class PromotionsService {
  constructor(
    private readonly repository: PromotionsRepository,
    private readonly auditService: AuditService,
  ) {}

  async findAll(filter: { isActive?: boolean; scope?: PromotionScope }): Promise<PromotionEntity[]> {
    return (await this.repository.findAll(filter)).map(toEntity);
  }

  async findOne(id: string): Promise<PromotionEntity> {
    return toEntity(await this.findOrThrow(id));
  }

  async create(input: CreatePromotionInput, actorId: string): Promise<PromotionEntity> {
    const { targetIds: requestedTargets, ...fields } = input;
    const targetIds = [...new Set(requestedTargets)];
    const startsAt = input.startsAt ?? new Date();
    this.assertDefinition({ ...input, targetIds, startsAt, endsAt: input.endsAt ?? null });
    await this.assertTargetsExist(input.scope, targetIds);
    const created = await this.auditService.record(
      (tx) => this.repository.create({ ...fields, startsAt, ...targetWrites(input.scope, targetIds, 'connect') }, tx),
      (promotion) => ({
        entity: 'Promotion',
        entityId: promotion.id,
        action: 'CREATE',
        userId: actorId,
        details: { after: fieldValues(promotion, AUDITED_PROMOTION_FIELDS), targetIds },
      }),
    );
    return toEntity(created);
  }

  async update(id: string, input: UpdatePromotionInput, actorId: string): Promise<PromotionEntity> {
    const existing = await this.findOrThrow(id);
    if (Object.values(input).every((value) => value === undefined)) {
      throw new BadRequestException('At least one field must be provided for update');
    }
    const cleared = REQUIRED_PROMOTION_FIELDS.filter((field) => input[field] === null);
    if (cleared.length > 0) throw new BadRequestException(`${cleared.join(', ')} cannot be null`);

    const { targetIds: requestedTargets, ...fields } = input;
    const scope = input.scope ?? existing.scope;
    const scopeChanged = scope !== existing.scope;
    const existingTargets = targetIdsOf(existing);
    if (scopeChanged && requestedTargets === undefined && existingTargets.length > 0) {
      throw new BadRequestException('Give targetIds when changing the scope (the current targets are of another kind)');
    }
    const replaceTargets = requestedTargets !== undefined || scopeChanged;
    const targetIds = requestedTargets !== undefined ? [...new Set(requestedTargets)] : existingTargets;
    this.assertDefinition({
      scope,
      type: input.type ?? existing.type,
      value: input.value ?? existing.value,
      targetIds,
      startsAt: input.startsAt ?? existing.startsAt,
      endsAt: input.endsAt === undefined ? existing.endsAt : input.endsAt,
    });
    if (requestedTargets !== undefined) await this.assertTargetsExist(scope, targetIds);

    const updated = await this.auditService.record(
      (tx) =>
        this.repository.update(
          id,
          { ...fields, ...(replaceTargets && targetWrites(scope, targetIds, 'set')) } as Prisma.PromotionUpdateInput,
          tx,
        ),
      (after) => ({
        entity: 'Promotion',
        entityId: id,
        action: 'UPDATE',
        userId: actorId,
        details: {
          changes: fieldChanges(existing, after, AUDITED_PROMOTION_FIELDS),
          ...(replaceTargets && { targetIds }),
        },
      }),
    );
    return toEntity(updated);
  }

  /** Deletes a promotion no order has used (its coupon codes go with it); a used one can only be deactivated. */
  async delete(id: string, actorId: string): Promise<PromotionEntity> {
    await this.findOrThrow(id);
    if ((await this.repository.countRedemptions({ promotionId: id })) > 0) {
      throw new ConflictException(`Promotion "${id}" has been used by orders; deactivate it instead of deleting it`);
    }
    const deleted = await this.auditService.record(
      (tx) => this.repository.delete(id, tx),
      (before) => ({
        entity: 'Promotion',
        entityId: id,
        action: 'DELETE',
        userId: actorId,
        details: { before: fieldValues(before, AUDITED_PROMOTION_FIELDS), targetIds: targetIdsOf(before) },
      }),
    );
    return toEntity(deleted);
  }

  async createCouponCode(input: CreateCouponCodeInput, actorId: string): Promise<CouponCode> {
    await this.findOrThrow(input.promotionId);
    const code = input.code.toUpperCase();
    return this.writeCouponCode(code, () =>
      this.auditService.record(
        (tx) =>
          this.repository.createCouponCode(
            { code, promotionId: input.promotionId, isActive: input.isActive, usageLimit: input.usageLimit },
            tx,
          ),
        (created) => ({
          entity: 'CouponCode',
          entityId: created.id,
          action: 'CREATE',
          userId: actorId,
          details: { after: fieldValues(created, AUDITED_COUPON_CODE_FIELDS) },
        }),
      ),
    );
  }

  async updateCouponCode(id: string, input: UpdateCouponCodeInput, actorId: string): Promise<CouponCode> {
    const existing = await this.findCouponCodeOrThrow(id);
    if (input.isActive === null) throw new BadRequestException('isActive cannot be null');
    const code = input.code?.toUpperCase();
    return this.writeCouponCode(code ?? existing.code, () =>
      this.auditService.record(
        (tx) =>
          this.repository.updateCouponCode(id, { code, isActive: input.isActive, usageLimit: input.usageLimit }, tx),
        (updated) => ({
          entity: 'CouponCode',
          entityId: id,
          action: 'UPDATE',
          userId: actorId,
          details: { changes: fieldChanges(existing, updated, AUDITED_COUPON_CODE_FIELDS) },
        }),
      ),
    );
  }

  /** Deletes a coupon code no order has used; a used one can only be deactivated. */
  async deleteCouponCode(id: string, actorId: string): Promise<CouponCode> {
    await this.findCouponCodeOrThrow(id);
    if ((await this.repository.countRedemptions({ couponCodeId: id })) > 0) {
      throw new ConflictException(`Coupon code "${id}" has been used by orders; deactivate it instead of deleting it`);
    }
    return this.auditService.record(
      (tx) => this.repository.deleteCouponCode(id, tx),
      (deleted) => ({
        entity: 'CouponCode',
        entityId: id,
        action: 'DELETE',
        userId: actorId,
        details: { before: fieldValues(deleted, AUDITED_COUPON_CODE_FIELDS) },
      }),
    );
  }

  async getRedemptions(filter: RedemptionFilter, first: number, after?: string): Promise<RedemptionPage> {
    const [rows, totalCount] = await this.repository.findRedemptionPage(filter, { take: first + 1, after });
    return { nodes: rows.slice(0, first), totalCount, hasNextPage: rows.length > first };
  }

  /**
   * What the coupon code unlocks, if the customer may use it now (whatever the cart: checkoutQuote applies it).
   * @throws NotFoundException for an unknown code, BadRequestException with the reason when it cannot be used.
   */
  async validateCouponCode(code: string, customerId: string): Promise<CouponCodeValidation> {
    const couponCode = await this.findCouponCodeByCode(code);
    const promotion = await this.findOrThrow(couponCode.promotionId);
    const customer = await this.customerFacts(customerId, [promotion.id]);
    const rejection = couponCodeRejection(
      toPricingCouponCode(couponCode),
      toPricingPromotion(promotion),
      customer,
      new Date(),
    );
    if (rejection) throw new BadRequestException(rejection);
    return {
      code: couponCode.code,
      promotion: {
        id: promotion.id,
        name: promotion.name,
        description: promotion.description,
        endsAt: promotion.endsAt,
      },
      scope: promotion.scope,
      type: promotion.type,
      value: promotion.value,
      minimumSpend: promotion.minimumSpend,
      minimumQuantity: promotion.minimumQuantity,
    };
  }

  /**
   * The candidate promotions for a cart (live ones targeting its lines or the whole cart, plus the coupon code's), the
   * coupon code, and the customer's redemptions, read on `db` (the order transaction at placement).
   * @throws NotFoundException for an unknown coupon code.
   */
  async findForPricing(
    targets: CartTargets,
    customerId: string | null,
    code: string | undefined,
    now: Date,
    db?: Prisma.TransactionClient,
  ): Promise<PromotionPricingFacts> {
    const couponCode = code ? await this.findCouponCodeByCode(code, db) : undefined;
    const promotions = (
      await this.repository.findCandidates(targets, now, couponCode ? [couponCode.promotionId] : [], db)
    ).map(toPricingPromotion);
    const customer = customerId
      ? await this.customerFacts(
          customerId,
          promotions.map((promotion) => promotion.id),
          db,
        )
      : { redemptions: {} };
    return { promotions, couponCode: couponCode && toPricingCouponCode(couponCode), customer };
  }

  /**
   * Records the promotions an order uses, in the order transaction: for each (in id order, so concurrent orders lock
   * promotions in the same order), takes a use if any is left (a conditional increment that row-locks the
   * promotion), checks the customer's own limit against their RESERVED redemptions, takes a use of the coupon code
   * for the promotion it unlocked, and writes the RESERVED redemption.
   * @throws ConflictException (reason PROMOTION_LIMIT_REACHED or PROMOTION_CUSTOMER_LIMIT_REACHED); the caller's
   * transaction then rolls back, so nothing is recorded.
   */
  async reserveRedemptions(
    tx: Prisma.TransactionClient,
    order: { orderId: string; customerId: string },
    promotionIds: readonly string[],
    couponCode?: { id: string; promotionId: string },
  ): Promise<void> {
    for (const promotionId of [...new Set(promotionIds)].sort()) {
      const taken = await this.repository.takePromotionUse(tx, promotionId);
      if (!taken) {
        throw limitReached(
          `Promotion "${promotionId}" has no uses left: get a new checkoutQuote`,
          PROMOTION_LIMIT_REACHED,
        );
      }
      if (
        taken.perCustomerLimit !== null &&
        (await this.repository.countReserved(tx, promotionId, order.customerId)) >= taken.perCustomerLimit
      ) {
        throw limitReached(
          `You have already used promotion "${promotionId}" as many times as it allows`,
          PROMOTION_CUSTOMER_LIMIT_REACHED,
        );
      }
      const couponCodeId = couponCode?.promotionId === promotionId ? couponCode.id : null;
      if (couponCodeId && !(await this.repository.takeCouponCodeUse(tx, couponCodeId))) {
        throw limitReached('This coupon has reached its usage limit: get a new checkoutQuote', PROMOTION_LIMIT_REACHED);
      }
      await this.repository.createRedemption(tx, { promotionId, couponCodeId, ...order });
    }
  }

  /** Gives back the uses the order holds (each once), in the caller's transaction. */
  async releaseRedemptions(tx: Prisma.TransactionClient, orderId: string): Promise<void> {
    await this.repository.releaseOrder(tx, orderId);
  }

  private async customerFacts(
    customerId: string,
    promotionIds: string[],
    db?: Prisma.TransactionClient,
  ): Promise<PricingCustomer> {
    return { redemptions: await this.repository.countReservedByPromotion(customerId, promotionIds, db) };
  }

  private assertDefinition(definition: Parameters<typeof promotionDefinitionError>[0]): void {
    const error = promotionDefinitionError(definition);
    if (error) throw new BadRequestException(error);
  }

  private async assertTargetsExist(scope: PromotionScope, targetIds: string[]): Promise<void> {
    const missing = await this.repository.missingTargets(scope, targetIds);
    if (missing.length > 0) throw new BadRequestException(`Unknown ${scope} target ids: ${missing.join(', ')}`);
  }

  private async findOrThrow(id: string): Promise<PromotionWithRelations> {
    const promotion = await this.repository.findById(id);
    if (!promotion) throw new NotFoundException(`Promotion "${id}" not found`);
    return promotion;
  }

  private async findCouponCodeOrThrow(id: string): Promise<CouponCode> {
    const couponCode = await this.repository.findCouponCodeById(id);
    if (!couponCode) throw new NotFoundException(`Coupon code "${id}" not found`);
    return couponCode;
  }

  private async findCouponCodeByCode(code: string, db?: Prisma.TransactionClient): Promise<CouponCode> {
    const couponCode = await this.repository.findCouponCode(code.toUpperCase(), db);
    if (!couponCode) throw new NotFoundException(`Coupon code "${code}" not found`);
    return couponCode;
  }

  private async writeCouponCode(code: string, write: () => Promise<CouponCode>): Promise<CouponCode> {
    try {
      return await write();
    } catch (error) {
      if (isUniqueViolation(error)) throw new ConflictException(`Coupon code "${code}" already exists`);
      throw error;
    }
  }
}
