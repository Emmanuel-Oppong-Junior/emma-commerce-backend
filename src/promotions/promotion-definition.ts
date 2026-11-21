import { Decimal } from '@prisma/client/runtime/client';
import { PromotionScope, PromotionType } from '../generated/prisma/client';

export interface PromotionTierDefinition {
  minimumQuantity: number | null;
  minimumSpend: Decimal | null;
  value: Decimal;
}

/** The parts of a promotion that must agree with each other, as they will be stored. */
export interface PromotionDefinition {
  scope: PromotionScope;
  type: PromotionType;
  value: Decimal | null;
  targetIds: readonly string[];
  startsAt: Date;
  endsAt: Date | null;
  unitCap: number | null;
  buyQuantity: number | null;
  getQuantity: number | null;
  maxApplications: number | null;
  rewardTargetIds: readonly string[];
  tierValueType: PromotionType | null;
  tiers: readonly PromotionTierDefinition[];
  shippingZoneIds: readonly string[];
}

const SIMPLE_TYPES: readonly PromotionType[] = [
  PromotionType.PERCENT,
  PromotionType.AMOUNT_OFF,
  PromotionType.FIXED_PRICE,
];

/** Why the promotion, as it would be stored after a create or an update, is inconsistent; null when it is fine. */
export function promotionDefinitionError(definition: PromotionDefinition): string | null {
  const { scope, type, value, targetIds, startsAt, endsAt, unitCap } = definition;
  const cart = scope === PromotionScope.CART;
  if (type === PromotionType.TIERED) {
    if (value !== null) return 'A TIERED promotion takes no value: its tiers carry the values';
  } else if (value === null && type !== PromotionType.FREE_SHIPPING) {
    return `A ${type} promotion needs a value`;
  }
  if (type === PromotionType.FREE_SHIPPING) {
    if (!cart) return 'A FREE_SHIPPING promotion has CART scope: it reduces the delivery fee of the whole order';
    if (value?.lte(0))
      return "A FREE_SHIPPING promotion's value (amount off the fee) must be above 0; omit it to waive the fee";
  } else if (definition.shippingZoneIds.length > 0) {
    return 'shippingZoneIds apply to FREE_SHIPPING promotions only';
  }
  if ((type === PromotionType.PERCENT || type === PromotionType.BXGY) && value?.gt(100)) {
    return `A ${type} promotion's value must be at most 100 (a percentage), got ${value.toString()}`;
  }
  if (type === PromotionType.BXGY && value?.lte(0)) return "A BXGY promotion's value (percent off) must be above 0";
  if (cart && type === PromotionType.FIXED_PRICE) {
    return 'A CART promotion cannot be FIXED_PRICE: a cart has no unit price to fix';
  }
  if (cart && type === PromotionType.BXGY)
    return 'A BXGY promotion needs an item scope (SKU, PRODUCT, CATEGORY or BRAND)';
  if (cart && targetIds.length > 0) return 'A CART promotion takes no targetIds';
  if (cart && unitCap !== null) return 'A CART promotion cannot have a unitCap: it reduces the cart, not units';
  if (endsAt !== null && endsAt <= startsAt) return 'endsAt must be after startsAt';
  return bxgyError(definition) ?? tiersError(definition);
}

function bxgyError(definition: PromotionDefinition): string | null {
  const { type, buyQuantity, getQuantity, maxApplications, rewardTargetIds } = definition;
  if (type !== PromotionType.BXGY) {
    const given = [
      buyQuantity !== null && 'buyQuantity',
      getQuantity !== null && 'getQuantity',
      maxApplications !== null && 'maxApplications',
      rewardTargetIds.length > 0 && 'rewardTargetIds',
    ].filter(Boolean);
    return given.length > 0 ? `${given.join(', ')} apply to BXGY promotions only` : null;
  }
  if (buyQuantity === null || getQuantity === null) return 'A BXGY promotion needs buyQuantity and getQuantity';
  return null;
}

function tiersError(definition: PromotionDefinition): string | null {
  const { type, scope, tierValueType, tiers } = definition;
  if (type !== PromotionType.TIERED) {
    if (tierValueType !== null || tiers.length > 0) return 'tiers and tierValueType apply to TIERED promotions only';
    return null;
  }
  const cart = scope === PromotionScope.CART;
  if (tierValueType === null || !SIMPLE_TYPES.includes(tierValueType)) {
    return 'A TIERED promotion needs tierValueType PERCENT, AMOUNT_OFF or FIXED_PRICE';
  }
  if (cart && tierValueType === PromotionType.FIXED_PRICE) return 'A CART promotion cannot be FIXED_PRICE per tier';
  if (tiers.length === 0) return 'A TIERED promotion needs at least one tier';
  const threshold = (tier: PromotionTierDefinition) =>
    cart ? tier.minimumSpend : tier.minimumQuantity === null ? null : new Decimal(tier.minimumQuantity);
  for (const tier of tiers) {
    if (
      cart
        ? tier.minimumQuantity !== null || tier.minimumSpend === null
        : tier.minimumSpend !== null || tier.minimumQuantity === null
    ) {
      return cart
        ? 'Each tier of a CART promotion has a minimumSpend (and no minimumQuantity)'
        : 'Each tier of an item promotion has a minimumQuantity (and no minimumSpend)';
    }
    if (tierValueType === PromotionType.PERCENT && (tier.value.lte(0) || tier.value.gt(100))) {
      return `A PERCENT tier's value must be above 0 and at most 100, got ${tier.value.toString()}`;
    }
    if (tierValueType === PromotionType.AMOUNT_OFF && tier.value.lte(0)) {
      return `An AMOUNT_OFF tier's value must be above 0, got ${tier.value.toString()}`;
    }
  }
  for (let index = 1; index < tiers.length; index += 1) {
    const [previous, tier] = [tiers[index - 1], tiers[index]];
    if (!threshold(tier)!.gt(threshold(previous)!)) {
      return 'Tiers must be in ascending order of their threshold, each above the one before';
    }
    const worthLess =
      tierValueType === PromotionType.FIXED_PRICE ? tier.value.gt(previous.value) : tier.value.lt(previous.value);
    if (worthLess) return 'A higher tier must not be worth less than the one before it';
  }
  return null;
}
