import { Injectable } from '@nestjs/common';
import { CouponCode, Prisma, PromotionScope, Redemption, RedemptionStatus } from '../generated/prisma/client';
import { PrismaService } from '../prisma/prisma.service';

const TARGETS_INCLUDE = {
  variants: { select: { id: true } },
  products: { select: { id: true } },
  categories: { select: { id: true } },
  brands: { select: { id: true } },
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
  const relation = TARGET_RELATION[scope];
  const writes: Partial<Record<TargetRelation, { connect?: { id: string }[]; set?: { id: string }[] }>> = {};
  for (const each of TARGET_RELATIONS) {
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
      },
    });
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
    data: { promotionId: string; couponCodeId: string | null; customerId: string; orderId: string },
  ): Promise<void> {
    await tx.redemption.create({ data });
  }

  /**
   * Releases the order's RESERVED redemptions (a conditional update, so each is released once) and gives their uses
   * back to the promotions and coupon codes.
   */
  async releaseOrder(tx: Prisma.TransactionClient, orderId: string): Promise<number> {
    const released = await tx.$queryRaw<Pick<Redemption, 'promotionId' | 'couponCodeId'>[]>`
      UPDATE "Redemption" SET "status" = 'RELEASED', "releasedAt" = now()
      WHERE "orderId" = ${orderId} AND "status" = 'RESERVED'
      RETURNING "promotionId", "couponCodeId"`;
    for (const { promotionId, couponCodeId } of released) {
      await tx.promotion.updateMany({
        where: { id: promotionId, usedCount: { gt: 0 } },
        data: { usedCount: { decrement: 1 } },
      });
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

  async runTransaction<T>(fn: (tx: Prisma.TransactionClient) => Promise<T>): Promise<T> {
    return this.prisma.$transaction(fn);
  }
}
