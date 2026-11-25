import { Injectable } from '@nestjs/common';
import {
  CouponCode,
  OrderStatus,
  Prisma,
  PromotionScope,
  Redemption,
  RedemptionStatus,
} from '../generated/prisma/client';
import { PrismaService } from '../prisma/prisma.service';

const TARGETS_INCLUDE = {
  variants: { select: { id: true } },
  products: { select: { id: true } },
  categories: { select: { id: true } },
  brands: { select: { id: true } },
  rewardVariants: { select: { id: true } },
  rewardProducts: { select: { id: true } },
  rewardCategories: { select: { id: true } },
  rewardBrands: { select: { id: true } },
  customerGroups: { select: { id: true } },
  shippingZones: { select: { id: true } },
  tiers: { orderBy: [{ minimumQuantity: 'asc' }, { minimumSpend: 'asc' }] },
} satisfies Prisma.PromotionInclude;

export const PROMOTION_INCLUDE = {
  ...TARGETS_INCLUDE,
  couponCodes: { orderBy: [{ createdAt: 'asc' }, { id: 'asc' }] },
} satisfies Prisma.PromotionInclude;

export type PromotionWithTargets = Prisma.PromotionGetPayload<{ include: typeof TARGETS_INCLUDE }>;
export type PromotionWithRelations = Prisma.PromotionGetPayload<{ include: typeof PROMOTION_INCLUDE }>;

type TargetRelation = 'variants' | 'products' | 'categories' | 'brands';

/** The relation holding a scope's targets; CART has none. */
export const TARGET_RELATION: Record<PromotionScope, TargetRelation | null> = {
  SKU: 'variants',
  PRODUCT: 'products',
  CATEGORY: 'categories',
  BRAND: 'brands',
  CART: null,
};

const TARGET_RELATIONS: TargetRelation[] = ['variants', 'products', 'categories', 'brands'];

type RewardRelation = 'rewardVariants' | 'rewardProducts' | 'rewardCategories' | 'rewardBrands';

/** The relation holding a BXGY promotion's reward targets, of its scope's kind; CART has none. */
export const REWARD_RELATION: Record<PromotionScope, RewardRelation | null> = {
  SKU: 'rewardVariants',
  PRODUCT: 'rewardProducts',
  CATEGORY: 'rewardCategories',
  BRAND: 'rewardBrands',
  CART: null,
};

const REWARD_RELATIONS: RewardRelation[] = ['rewardVariants', 'rewardProducts', 'rewardCategories', 'rewardBrands'];

/** The order statuses that make an order count against first-order promotions (the customer paid or was accepted). */
const COUNTED_ORDER_STATUSES: OrderStatus[] = [
  OrderStatus.CONFIRMED,
  OrderStatus.IN_FULFILMENT,
  OrderStatus.COMPLETED,
  OrderStatus.PAYMENT_REVIEW,
];

/** The ids a cart's lines can be targeted by. */
export interface CartTargets {
  variantIds: string[];
  productIds: string[];
  categoryIds: string[];
  brandIds: string[];
}

export interface RedemptionFilter {
  promotionId?: string;
  customerId?: string;
  orderId?: string;
  status?: RedemptionStatus;
}

/** The relation writes that make `targetIds` the promotion's only targets, for its scope. */
export function targetWrites(scope: PromotionScope, targetIds: readonly string[], operation: 'connect' | 'set') {
  return relationWrites(TARGET_RELATIONS, TARGET_RELATION[scope], targetIds, operation);
}

/** The relation writes that make `rewardTargetIds` the promotion's only BXGY reward targets, for its scope. */
export function rewardTargetWrites(
  scope: PromotionScope,
  rewardTargetIds: readonly string[],
  operation: 'connect' | 'set',
) {
  return relationWrites(REWARD_RELATIONS, REWARD_RELATION[scope], rewardTargetIds, operation);
}

function relationWrites<R extends string>(
  relations: readonly R[],
  relation: R | null,
  targetIds: readonly string[],
  operation: 'connect' | 'set',
) {
  const writes: Partial<Record<R, { connect?: { id: string }[]; set?: { id: string }[] }>> = {};
  for (const each of relations) {
    const ids = each === relation ? targetIds.map((id) => ({ id })) : [];
    if (operation === 'set') writes[each] = { set: ids };
    else if (ids.length > 0) writes[each] = { connect: ids };
  }
  return writes;
}

@Injectable()
export class PromotionsRepository {
  constructor(private readonly prisma: PrismaService) {}

  async create(data: Prisma.PromotionCreateInput, tx: Prisma.TransactionClient): Promise<PromotionWithRelations> {
    return tx.promotion.create({ data, include: PROMOTION_INCLUDE });
  }

  async update(
    id: string,
    data: Prisma.PromotionUpdateInput,
    tx: Prisma.TransactionClient,
  ): Promise<PromotionWithRelations> {
    return tx.promotion.update({ where: { id }, data, include: PROMOTION_INCLUDE });
  }

  async delete(id: string, tx: Prisma.TransactionClient): Promise<PromotionWithRelations> {
    return tx.promotion.delete({ where: { id }, include: PROMOTION_INCLUDE });
  }

  async findById(id: string, db: Prisma.TransactionClient = this.prisma): Promise<PromotionWithRelations | null> {
    return db.promotion.findUnique({ where: { id }, include: PROMOTION_INCLUDE });
  }

  async findAll(where: Prisma.PromotionWhereInput): Promise<PromotionWithRelations[]> {
    return this.prisma.promotion.findMany({
      where,
      include: PROMOTION_INCLUDE,
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
    });
  }

  async countRedemptions(where: Prisma.RedemptionWhereInput): Promise<number> {
    return this.prisma.redemption.count({ where });
  }

  /** The ids among `ids` that are not rows of the scope's target table. */
  async missingTargets(scope: PromotionScope, ids: readonly string[]): Promise<string[]> {
    if (ids.length === 0) return [];
    const where = { id: { in: [...ids] } };
    const select = { id: true } as const;
    const found =
      scope === PromotionScope.SKU
        ? await this.prisma.variant.findMany({ where, select })
        : scope === PromotionScope.PRODUCT
          ? await this.prisma.product.findMany({ where, select })
          : scope === PromotionScope.CATEGORY
            ? await this.prisma.category.findMany({ where, select })
            : scope === PromotionScope.BRAND
              ? await this.prisma.brand.findMany({ where, select })
              : [];
    const existing = new Set(found.map((row) => row.id));
    return ids.filter((id) => !existing.has(id));
  }

  /**
   * Promotions live at `now` that are cart-wide or target one of the cart's variants, products, categories or brands,
   * plus the promotions with `alsoIds` whatever their state (a coupon code's, so the engine can say why it fails).
   * Each comes with only the targets among the cart's.
   */
  async findCandidates(
    targets: CartTargets,
    now: Date,
    alsoIds: string[],
    db: Prisma.TransactionClient = this.prisma,
  ): Promise<PromotionWithTargets[]> {
    return db.promotion.findMany({
      where: {
        OR: [
          { id: { in: alsoIds } },
          {
            isActive: true,
            startsAt: { lte: now },
            AND: [
              { OR: [{ endsAt: null }, { endsAt: { gte: now } }] },
              {
                OR: [
                  { scope: PromotionScope.CART },
                  { scope: PromotionScope.SKU, variants: { some: { id: { in: targets.variantIds } } } },
                  { scope: PromotionScope.PRODUCT, products: { some: { id: { in: targets.productIds } } } },
                  { scope: PromotionScope.CATEGORY, categories: { some: { id: { in: targets.categoryIds } } } },
                  { scope: PromotionScope.BRAND, brands: { some: { id: { in: targets.brandIds } } } },
                ],
              },
            ],
          },
        ],
      },
      include: {
        variants: { where: { id: { in: targets.variantIds } }, select: { id: true } },
        products: { where: { id: { in: targets.productIds } }, select: { id: true } },
        categories: { where: { id: { in: targets.categoryIds } }, select: { id: true } },
        brands: { where: { id: { in: targets.brandIds } }, select: { id: true } },
        // Unfiltered: no reward targets means "the targets themselves", so filtering to the cart would change that.
        rewardVariants: { select: { id: true } },
        rewardProducts: { select: { id: true } },
        rewardCategories: { select: { id: true } },
        rewardBrands: { select: { id: true } },
        customerGroups: { select: { id: true } },
        shippingZones: { select: { id: true } },
        tiers: true,
      },
    });
  }

  async findCustomerGroupIds(customerId: string, db: Prisma.TransactionClient = this.prisma): Promise<string[]> {
    const memberships = await db.customerGroupMember.findMany({
      where: { userId: customerId },
      select: { groupId: true },
    });
    return memberships.map(({ groupId }) => groupId);
  }

  /**
   * Whether the customer has an order, other than `exceptOrderId`, that reached CONFIRMED or later or PAYMENT_REVIEW,
   * now or at any point of its history (so cancelling or refunding a paid order does not make the next one a first).
   * Legacy orders migrated without their history count by their status.
   */
  async hasPriorOrder(customerId: string, db: Prisma.TransactionClient = this.prisma): Promise<boolean> {
    const order = await db.order.findFirst({
      where: {
        userId: customerId,
        OR: [
          { status: { in: COUNTED_ORDER_STATUSES } },
          { statusEvents: { some: { to: { in: COUNTED_ORDER_STATUSES } } } },
        ],
      },
      select: { id: true },
    });
    return order !== null;
  }

  async missingShippingZones(ids: readonly string[]): Promise<string[]> {
    if (ids.length === 0) return [];
    const found = await this.prisma.shippingZone.findMany({ where: { id: { in: [...ids] } }, select: { id: true } });
    const existing = new Set(found.map((row) => row.id));
    return ids.filter((id) => !existing.has(id));
  }

  async missingCustomerGroups(ids: readonly string[]): Promise<string[]> {
    if (ids.length === 0) return [];
    const found = await this.prisma.customerGroup.findMany({ where: { id: { in: [...ids] } }, select: { id: true } });
    const existing = new Set(found.map((row) => row.id));
    return ids.filter((id) => !existing.has(id));
  }

  /** The customer's RESERVED redemptions of each of the promotions. */
  async countReservedByPromotion(
    customerId: string,
    promotionIds: string[],
    db: Prisma.TransactionClient = this.prisma,
  ): Promise<Record<string, number>> {
    if (promotionIds.length === 0) return {};
    const rows = await db.redemption.groupBy({
      by: ['promotionId'],
      where: { customerId, status: RedemptionStatus.RESERVED, promotionId: { in: promotionIds } },
      _count: { _all: true },
    });
    return Object.fromEntries(rows.map((row) => [row.promotionId, row._count._all]));
  }

  async findCouponCode(code: string, db: Prisma.TransactionClient = this.prisma): Promise<CouponCode | null> {
    return db.couponCode.findUnique({ where: { code } });
  }

  async findCouponCodeById(id: string): Promise<CouponCode | null> {
    return this.prisma.couponCode.findUnique({ where: { id } });
  }

  async createCouponCode(data: Prisma.CouponCodeUncheckedCreateInput, tx: Prisma.TransactionClient) {
    return tx.couponCode.create({ data });
  }

  async updateCouponCode(id: string, data: Prisma.CouponCodeUpdateInput, tx: Prisma.TransactionClient) {
    return tx.couponCode.update({ where: { id }, data });
  }

  async deleteCouponCode(id: string, tx: Prisma.TransactionClient) {
    return tx.couponCode.delete({ where: { id } });
  }

  /**
   * Takes one use of the promotion if it has any left: a conditional increment, which also row-locks the promotion
   * until the transaction ends, so concurrent orders using it queue here. Returns its per-customer limit, or
   * undefined when no use is left.
   */
  async takePromotionUse(
    tx: Prisma.TransactionClient,
    promotionId: string,
  ): Promise<{ perCustomerLimit: number | null } | undefined> {
    const [row] = await tx.$queryRaw<{ perCustomerLimit: number | null }[]>`
      UPDATE "Promotion" SET "usedCount" = "usedCount" + 1
      WHERE "id" = ${promotionId} AND ("usageLimit" IS NULL OR "usedCount" < "usageLimit")
      RETURNING "perCustomerLimit"`;
    return row;
  }

  /**
   * Counts `units` more units sold at the promotion's price if its unit cap leaves that many (a conditional increment
   * on the promotion row the order already locked); false when fewer are left.
   */
  async takePromotionUnits(tx: Prisma.TransactionClient, promotionId: string, units: number): Promise<boolean> {
    const taken = await tx.$executeRaw`
      UPDATE "Promotion" SET "unitsUsed" = "unitsUsed" + ${units}
      WHERE "id" = ${promotionId} AND ("unitCap" IS NULL OR "unitsUsed" + ${units} <= "unitCap")`;
    return taken === 1;
  }

  /** Takes one use of the coupon code if it has any left; false when none is. */
  async takeCouponCodeUse(tx: Prisma.TransactionClient, couponCodeId: string): Promise<boolean> {
    const taken = await tx.$executeRaw`
      UPDATE "CouponCode" SET "usedCount" = "usedCount" + 1
      WHERE "id" = ${couponCodeId} AND ("usageLimit" IS NULL OR "usedCount" < "usageLimit")`;
    return taken === 1;
  }

  async countReserved(tx: Prisma.TransactionClient, promotionId: string, customerId: string): Promise<number> {
    return tx.redemption.count({ where: { promotionId, customerId, status: RedemptionStatus.RESERVED } });
  }

  async createRedemption(
    tx: Prisma.TransactionClient,
    data: {
      promotionId: string;
      couponCodeId: string | null;
      customerId: string | null;
      orderId: string;
      units: number;
    },
  ): Promise<void> {
    await tx.redemption.create({ data });
  }

  /**
   * Releases the order's RESERVED redemptions (a conditional update, so each is released once) and gives their uses
   * and units back to the promotions and coupon codes.
   */
  async releaseOrder(tx: Prisma.TransactionClient, orderId: string): Promise<number> {
    const released = await tx.$queryRaw<Pick<Redemption, 'promotionId' | 'couponCodeId' | 'units'>[]>`
      UPDATE "Redemption" SET "status" = 'RELEASED', "releasedAt" = now()
      WHERE "orderId" = ${orderId} AND "status" = 'RESERVED'
      RETURNING "promotionId", "couponCodeId", "units"`;
    for (const { promotionId, couponCodeId, units } of released) {
      await tx.promotion.updateMany({
        where: { id: promotionId, usedCount: { gt: 0 } },
        data: { usedCount: { decrement: 1 } },
      });
      if (units > 0) {
        await tx.promotion.updateMany({
          where: { id: promotionId, unitsUsed: { gte: units } },
          data: { unitsUsed: { decrement: units } },
        });
      }
      if (couponCodeId) {
        await tx.couponCode.updateMany({
          where: { id: couponCodeId, usedCount: { gt: 0 } },
          data: { usedCount: { decrement: 1 } },
        });
      }
    }
    return released.length;
  }

  async findRedemptionPage(
    filter: RedemptionFilter,
    page: { take: number; after?: string },
  ): Promise<[Redemption[], number]> {
    const where: Prisma.RedemptionWhereInput = filter;
    return Promise.all([
      this.prisma.redemption.findMany({
        where,
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
        take: page.take,
        ...(page.after && { cursor: { id: page.after }, skip: 1 }),
      }),
      this.prisma.redemption.count({ where }),
    ]);
  }
}
