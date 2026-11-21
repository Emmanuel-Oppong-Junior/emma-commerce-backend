import { Prisma, PromotionScope, PromotionType } from '../../src/generated/prisma/client';
import { Decimal } from '@prisma/client/runtime/client';
import { PrismaService } from '../../src/prisma/prisma.service';

const DAY_MS = 24 * 60 * 60 * 1000;

export interface PromotionFixture extends Partial<
  Omit<Prisma.PromotionUncheckedCreateInput, 'scope' | 'type' | 'value' | 'tiers'>
> {
  scope?: PromotionScope;
  type: PromotionType;
  /** Null for TIERED. */
  value: Decimal.Value | null;
  /** Of the scope's kind: variant ids (SKU), product (default scope), category or brand ids. */
  targetIds?: string[];
  /** BXGY reward targets, of the scope's kind. */
  rewardTargetIds?: string[];
  /** TIERED tiers. */
  tiers?: { minimumQuantity?: number; minimumSpend?: Decimal.Value; value: Decimal.Value }[];
}

const RELATION: Record<PromotionScope, 'variants' | 'products' | 'categories' | 'brands' | null> = {
  SKU: 'variants',
  PRODUCT: 'products',
  CATEGORY: 'categories',
  BRAND: 'brands',
  CART: null,
};

const REWARD_RELATION: Record<PromotionScope, string | null> = {
  SKU: 'rewardVariants',
  PRODUCT: 'rewardProducts',
  CATEGORY: 'rewardCategories',
  BRAND: 'rewardBrands',
  CART: null,
};

/** An active promotion, live since yesterday until tomorrow unless the fixture says otherwise. */
export async function createPromotion(prisma: PrismaService, fixture: PromotionFixture) {
  const { scope = 'PRODUCT', targetIds = [], rewardTargetIds = [], tiers = [], type, value, ...rest } = fixture;
  const relation = RELATION[scope];
  const rewardRelation = REWARD_RELATION[scope];
  return prisma.promotion.create({
    data: {
      name: rest.name ?? `${type} ${String(value)}`,
      isActive: true,
      startsAt: new Date(Date.now() - DAY_MS),
      endsAt: new Date(Date.now() + DAY_MS),
      ...rest,
      scope,
      type,
      value,
      ...(relation && targetIds.length > 0 && { [relation]: { connect: targetIds.map((id) => ({ id })) } }),
      ...(rewardRelation &&
        rewardTargetIds.length > 0 && { [rewardRelation]: { connect: rewardTargetIds.map((id) => ({ id })) } }),
      ...(tiers.length > 0 && { tiers: { create: tiers } }),
    } as Prisma.PromotionCreateInput,
  });
}

export interface CouponFixture extends Omit<PromotionFixture, 'scope' | 'targetIds'> {
  code: string;
  /** The code's own fields. */
  couponCode?: Partial<Prisma.CouponCodeUncheckedCreateInput>;
}

/**
 * A coupon as the legacy Coupon model was migrated: a CART promotion that requires a code, one use per customer, and
 * its code (stored upper case). Open-ended and live since yesterday unless the fixture says otherwise.
 */
export async function createCoupon(prisma: PrismaService, fixture: CouponFixture) {
  const { code, couponCode, ...promotionFixture } = fixture;
  const promotion = await createPromotion(prisma, {
    name: `Coupon ${code.toUpperCase()}`,
    endsAt: null,
    requiresCoupon: true,
    perCustomerLimit: 1,
    ...promotionFixture,
    scope: 'CART',
  });
  const created = await prisma.couponCode.create({
    data: { code: code.toUpperCase(), promotionId: promotion.id, ...couponCode },
  });
  return { promotion, couponCode: created };
}
